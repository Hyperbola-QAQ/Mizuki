"""Local-only primitives for a future create-only CNPG credential transaction.

This module has no Kubernetes client or command-line apply path. Callbacks must
be supplied by a separately reviewed transport. Neither the credential nor the
Secret objects may be logged. An interrupted remote write always leaves the
journal in a pending state and is not retried automatically.
"""
from __future__ import annotations

import base64
import fcntl
import hmac
import json
import os
import re
import secrets
import stat
import uuid
from pathlib import Path

USERNAME = 'shirone_cms'
SECRET_NAME = 'shirone-cms-db'
TRANSACTION_ANNOTATION = 'shirone.hyperbola.cc/credential-transaction'
NAMESPACES = ('databases', 'mizuki')

class Hold(RuntimeError):
    """Unsafe or uncertain transaction: preserve all state for review."""


def _directory(path: Path) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise Hold('stage directory must be owned by this user and mode 0700')
    return fd


def _lock(directory: int) -> int:
    fd = os.open('.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
        stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        os.close(fd)
        raise Hold('stage lock ownership, permissions, or type is unsafe')
    return fd


def _write_exclusive(directory: int, name: str, value: dict) -> None:
    data = json.dumps(value, separators=(',', ':')).encode()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
    finally:
        os.fsync(directory)


def _read_private(directory: int, name: str) -> dict:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        os.close(fd)
        raise Hold('stage file ownership, permissions, or type is unsafe')
    try:
        with os.fdopen(fd, 'rb') as file:
            value = json.load(file)
    except (ValueError, OSError) as exc:
        raise Hold('stage file is unreadable or incomplete') from exc
    if not isinstance(value, dict):
        raise Hold('stage file is malformed')
    return value


def _write_journal(directory: int, value: dict) -> None:
    name = f'.journal-{uuid.uuid4().hex}'
    _write_exclusive(directory, name, value)
    os.replace(name, 'journal.json', src_dir_fd=directory, dst_dir_fd=directory)
    os.fsync(directory)


def initialize(path: Path) -> None:
    """Initialize one new stage only; existing or partially created stages HOLD."""
    directory = _directory(path)
    lock = _lock(directory)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ('credential.json', 'journal.json'):
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise Hold('stage already exists or is incomplete; do not regenerate')
        transaction = uuid.uuid4().hex
        credential = {'version': 1, 'transaction': transaction, 'username': USERNAME, 'password': secrets.token_urlsafe(48)}
        _write_exclusive(directory, 'credential.json', credential)
        _write_exclusive(directory, 'journal.json', {'version': 1, 'transaction': transaction, 'phase': 'ready'})
    except BlockingIOError as exc:
        raise Hold('another credential transaction holds the lock') from exc
    finally:
        os.close(lock)
        os.close(directory)


def _namespaces(namespaces):
    if tuple(namespaces) == NAMESPACES:
        return NAMESPACES
    if (len(namespaces) == 2 and len(set(namespaces)) == 2 and
        all(isinstance(n, str) and re.fullmatch(r'shirone-credtest-[a-z0-9-]{1,42}', n) for n in namespaces)):
        return tuple(namespaces)
    raise Hold('unexpected namespace pair')


def _secret(namespace: str, credential: dict) -> dict:
    return {
        'apiVersion': 'v1', 'kind': 'Secret',
        'metadata': {'namespace': namespace, 'name': SECRET_NAME,
                     'annotations': {TRANSACTION_ANNOTATION: credential['transaction']}},
        'type': 'kubernetes.io/basic-auth', 'immutable': True,
        'data': {key: base64.b64encode(credential[key].encode()).decode() for key in ('username', 'password')},
    }


def _matches(observed: dict | None, expected: dict, expected_uid: str | None = None) -> bool:
    if not isinstance(observed, dict): return False
    meta = observed.get('metadata', {})
    if (observed.get('apiVersion') != 'v1' or observed.get('kind') != 'Secret' or
        meta.get('name') != expected['metadata']['name'] or meta.get('namespace') != expected['metadata']['namespace'] or
        meta.get('annotations', {}).get(TRANSACTION_ANNOTATION) != expected['metadata']['annotations'][TRANSACTION_ANNOTATION] or
        not meta.get('uid') or (expected_uid is not None and meta['uid'] != expected_uid) or
        observed.get('type') != expected['type'] or observed.get('immutable') is not True):
        return False
    data = observed.get('data')
    return isinstance(data, dict) and set(data) == {'username', 'password'} and all(
        isinstance(data[k], str) and hmac.compare_digest(data[k], expected['data'][k]) for k in data)


def reconcile(path: Path, get_secret, create_secret, *, cluster_uid: str, namespace_uids, namespaces=NAMESPACES) -> str:
    """Create missing secrets sequentially using injected create-only transport.

    get_secret(namespace, name) returns an object or None; create_secret(obj)
    sends one create request and returns only when the server acknowledges it.
    Transport errors, identity drift and pending requests never auto-retry.
    """
    namespaces = _namespaces(namespaces)
    if not isinstance(cluster_uid, str) or not re.fullmatch(r'[0-9a-f-]{8,64}', cluster_uid):
        raise Hold('cluster UID is required')
    if (not isinstance(namespace_uids, (tuple, list)) or len(namespace_uids) != 2 or
        any(not isinstance(uid, str) or not re.fullmatch(r'[0-9a-f-]{8,64}', uid) for uid in namespace_uids)):
        raise Hold('both namespace UIDs are required')
    namespace_uids = list(namespace_uids)
    directory = _directory(path)
    lock = _lock(directory)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credential = _read_private(directory, 'credential.json')
        journal = _read_private(directory, 'journal.json')
        if (credential.get('version') != 1 or journal.get('version') != 1 or
            credential.get('username') != USERNAME or not isinstance(credential.get('password'), str) or
            len(credential['password']) < 48 or credential.get('transaction') != journal.get('transaction')):
            raise Hold('stage identity or credential is invalid')
        phase = journal.get('phase')
        if phase not in ('ready', 'db_verified', 'complete'):
            raise Hold('uncertain request or invalid journal; manual review required')
        if phase in ('db_verified', 'complete') and not isinstance(journal.get('db_uid'), str):
            raise Hold('database Secret identity is missing')
        if phase == 'complete' and not isinstance(journal.get('cms_uid'), str):
            raise Hold('CMS Secret identity is missing')
        if phase != 'ready' and (journal.get('cluster_uid') != cluster_uid or journal.get('namespaces') != list(namespaces) or journal.get('namespace_uids') != namespace_uids):
            raise Hold('cluster identity or namespaces changed')
        expected_db = _secret(namespaces[0], credential)
        expected_cms = _secret(namespaces[1], credential)
        current_db = get_secret(namespaces[0], SECRET_NAME)
        current_cms = get_secret(namespaces[1], SECRET_NAME)
        if phase == 'ready':
            if current_db is not None or current_cms is not None:
                raise Hold('pre-existing Secret must not be adopted or overwritten')
            journal.update(phase='creating_db', cluster_uid=cluster_uid, namespaces=list(namespaces), namespace_uids=namespace_uids)
            _write_journal(directory, journal)
            create_secret(expected_db)
            created = get_secret(namespaces[0], SECRET_NAME)
            if not _matches(created, expected_db): raise Hold('database Secret receipt is invalid')
            journal.update(phase='db_verified', db_uid=created['metadata']['uid'])
            _write_journal(directory, journal)
            current_db = created
            current_cms = get_secret(namespaces[1], SECRET_NAME)
            phase = 'db_verified'
        if not _matches(current_db, expected_db, journal.get('db_uid')):
            raise Hold('database Secret has drifted')
        if phase == 'db_verified':
            if current_cms is not None: raise Hold('CMS Secret already exists; manual review required')
            journal['phase'] = 'creating_cms'
            _write_journal(directory, journal)
            create_secret(expected_cms)
            created = get_secret(namespaces[1], SECRET_NAME)
            if not _matches(created, expected_cms): raise Hold('CMS Secret receipt is invalid')
            journal.update(phase='complete', cms_uid=created['metadata']['uid'])
            _write_journal(directory, journal)
            current_cms = created
        if not _matches(current_cms, expected_cms, journal.get('cms_uid')):
            raise Hold('CMS Secret has drifted')
        return 'complete'
    except BlockingIOError as exc:
        raise Hold('another credential transaction holds the lock') from exc
    finally:
        os.close(lock)
        os.close(directory)
