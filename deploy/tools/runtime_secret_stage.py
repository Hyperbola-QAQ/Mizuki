"""Create-only, journaled application secrets; no secret is ever logged."""
from __future__ import annotations
import base64
import fcntl
import hashlib
import hmac
import os
import secrets
import re
import uuid
from pathlib import Path
import db_credential_stage as common

NAMES = ('shirone-search', 'shirone-search-keys', 'shirone-cms', 'shirone-ssr-static')
ANNOTATION = 'shirone.hyperbola.cc/runtime-transaction'

def _token(): return secrets.token_urlsafe(48)
def _key(master, uid): return hmac.new(master.encode(), uid.encode(), hashlib.sha256).hexdigest()

def initialize(path: Path):
    directory = common._directory(path)
    lock = common._lock(directory)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            existing = common._read_private(directory, 'runtime.json')
            journal = common._read_private(directory, 'journal.json')
        except FileNotFoundError:
            # Never regenerate if only part of an earlier initialization exists.
            if any(os.path.exists(path / name) for name in ('runtime.json', 'journal.json')):
                raise common.Hold('partial initialization')
            master = _token()
            ids = [str(uuid.uuid4()) for _ in range(3)]
            keys = [_key(master, uid) for uid in ids]
            renderer, media = _token(), _token()
            objects = {
                NAMES[0]: {'MEILI_MASTER_KEY': master},
                NAMES[1]: {'MEILI_MASTER_KEY': master, 'MEILI_SEARCH_UID': ids[0], 'MEILI_WRITER_UID': ids[1], 'MEILI_TASKS_UID': ids[2], 'MEILI_SEARCH_KEY': keys[0], 'MEILI_WRITER_KEY': keys[1], 'MEILI_TASKS_KEY': keys[2]},
                NAMES[2]: {'DATABASE_HOST': 'postgresql-rw.databases.svc.cluster.local', 'DATABASE_PORT': '5432', 'DATABASE_NAME': 'shirone_cms', 'DATABASE_SSL': 'false', 'APP_KEYS': ','.join((_token(), _token())), 'API_TOKEN_SALT': _token(), 'ADMIN_JWT_SECRET': _token(), 'TRANSFER_TOKEN_SALT': _token(), 'JWT_SECRET': _token(), 'ENCRYPTION_KEY': secrets.token_hex(16), 'MEILI_ADMIN_KEY': keys[1], 'MEILI_TASKS_KEY': keys[2], 'INTERNAL_RENDER_TOKEN': renderer, 'STRAPI_PUBLIC_URL': 'https://hyperbola.cc'},
                NAMES[3]: {'MEILI_SEARCH_KEY': keys[0], 'INTERNAL_RENDER_TOKEN': renderer, 'PROTECTED_MEDIA_SESSION_SECRET': media},
            }
            transaction = uuid.uuid4().hex
            common._write_exclusive(directory, 'runtime.json', {'version': 1, 'transaction': transaction, 'objects': objects})
            common._write_exclusive(directory, 'journal.json', {'version': 1, 'transaction': transaction, 'cluster_uid': None, 'namespace_uid': None, 'completed': {}, 'pending': None})
            return
        _validate(existing, journal)
    finally:
        os.close(lock); os.close(directory)

def _validate(data, journal):
    if data.get('version') != 1 or journal.get('version') != 1 or not isinstance(data.get('transaction'), str) or len(data['transaction']) != 32 or data['transaction'] != journal.get('transaction'):
        raise common.Hold('invalid transaction')
    objects = data.get('objects')
    if not isinstance(objects, dict) or set(objects) != set(NAMES) or any(not isinstance(obj, dict) or not obj or any(not isinstance(k,str) or not isinstance(v,str) or not v for k,v in obj.items()) for obj in objects.values()):
        raise common.Hold('invalid runtime credentials')
    try:
        master=objects[NAMES[0]]['MEILI_MASTER_KEY']; scoped=objects[NAMES[1]]; cms=objects[NAMES[2]]; ssr=objects[NAMES[3]]
        uids=[scoped['MEILI_SEARCH_UID'],scoped['MEILI_WRITER_UID'],scoped['MEILI_TASKS_UID']]
        keys=[scoped['MEILI_SEARCH_KEY'],scoped['MEILI_WRITER_KEY'],scoped['MEILI_TASKS_KEY']]
        if len(set(uids))!=3 or any(not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',u) for u in uids): raise common.Hold('invalid key identity')
        if not hmac.compare_digest(master,scoped['MEILI_MASTER_KEY']) or any(not hmac.compare_digest(key,_key(master,uid)) for uid,key in zip(uids,keys)): raise common.Hold('derived key mismatch')
        if not (hmac.compare_digest(keys[0],ssr['MEILI_SEARCH_KEY']) and hmac.compare_digest(keys[1],cms['MEILI_ADMIN_KEY']) and hmac.compare_digest(keys[2],cms['MEILI_TASKS_KEY']) and hmac.compare_digest(ssr['INTERNAL_RENDER_TOKEN'],cms['INTERNAL_RENDER_TOKEN'])): raise common.Hold('shared secret mismatch')
        if (cms['DATABASE_HOST'],cms['DATABASE_NAME'],cms['DATABASE_SSL'],cms['STRAPI_PUBLIC_URL']) != ('postgresql-rw.databases.svc.cluster.local','shirone_cms','false','https://hyperbola.cc'): raise common.Hold('unexpected destination')
    except KeyError as exc:
        raise common.Hold('runtime credentials incomplete') from exc
    if not isinstance(journal.get('completed'), dict) or any(name not in NAMES for name in journal['completed']):
        raise common.Hold('invalid journal')

def _body(name, data, namespace):
    return {'apiVersion':'v1', 'kind':'Secret', 'metadata':{'name':name, 'namespace':namespace, 'annotations':{ANNOTATION:data['transaction']}},
            'immutable': True, 'type':'Opaque', 'data':{key:base64.b64encode(value.encode()).decode() for key,value in data['objects'][name].items()}}

def _matches(found, expected, uid=None):
    meta = found.get('metadata', {})
    return (found.get('immutable') is True and found.get('type') == 'Opaque' and
        meta.get('name') == expected['metadata']['name'] and meta.get('namespace') == expected['metadata']['namespace'] and
        meta.get('annotations', {}).get(ANNOTATION) == expected['metadata']['annotations'][ANNOTATION] and
        bool(meta.get('uid')) and (uid is None or meta['uid'] == uid) and
        hmac.compare_digest(str(sorted(found.get('data', {}).items())), str(sorted(expected['data'].items()))))

def reconcile(path: Path, transport, cluster_uid: str, namespace_uid: str, namespace='mizuki'):
    if namespace != 'mizuki' and not re.fullmatch(r'shirone-runtime-test-[a-f0-9]{16}', namespace): raise common.Hold('unexpected namespace')
    directory = common._directory(path)
    lock = common._lock(directory)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        data, journal = common._read_private(directory, 'runtime.json'), common._read_private(directory, 'journal.json')
        _validate(data, journal)
        if journal['pending'] is not None: raise common.Hold('uncertain write needs operator review')
        if journal['cluster_uid'] not in (None, cluster_uid) or journal['namespace_uid'] not in (None, namespace_uid): raise common.Hold('cluster identity changed')
        transport.verify(cluster_uid, namespace_uid)
        if journal['cluster_uid'] is None:
            journal.update(cluster_uid=cluster_uid, namespace_uid=namespace_uid)
            common._write_journal(directory, journal)
        for name in NAMES:
            expected = _body(name, data, namespace)
            found = transport.get(name)
            saved_uid = journal['completed'].get(name)
            if saved_uid:
                if not found or not _matches(found, expected, saved_uid): raise common.Hold('completed Secret differs')
                continue
            if found: raise common.Hold('unrecorded Secret already exists')
            journal['pending'] = name
            common._write_journal(directory, journal)
            transport.create(expected)
            found = transport.get(name)
            if not found or not _matches(found, expected): raise common.Hold('Secret creation outcome uncertain')
            journal['completed'][name] = found['metadata']['uid']
            journal['pending'] = None
            common._write_journal(directory, journal)
        return 'complete'
    finally:
        os.close(lock); os.close(directory)
