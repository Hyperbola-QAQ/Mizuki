"""Install the already-issued published-reader token without reissuing it."""
import base64
import fcntl
import hmac
import os
import uuid
import re
from pathlib import Path
import db_credential_stage as common
import bootstrap_replicate as bootstrap

ANNOTATION='shirone.hyperbola.cc/reader-transaction'
NAME='shirone-ssr-reader'

def reconcile(path: Path, transport, cluster_uid: str, namespace_uid: str, namespace='mizuki'):
    if namespace!='mizuki' and not re.fullmatch(r'shirone-runtime-test-[a-f0-9]{16}',namespace): raise common.Hold('invalid namespace')
    directory=common._directory(path);lock=common._lock(directory)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        token=bootstrap._read_file(directory,'reader.token').strip()
        if not token or any((path/name).exists() for name in ('.bootstrap.lock','reader.pending','import.pending')): raise common.Hold('bootstrap not complete')
        try: journal=common._read_private(directory,'reader-secret.json')
        except FileNotFoundError:
            journal={'version':1,'transaction':uuid.uuid4().hex,'cluster_uid':cluster_uid,'namespace_uid':namespace_uid,'phase':'ready','uid':None}
            common._write_exclusive(directory,'reader-secret.json',journal)
        if journal.get('version')!=1 or journal.get('cluster_uid')!=cluster_uid or journal.get('namespace_uid')!=namespace_uid or journal.get('phase') not in ('ready','pending','complete'): raise common.Hold('invalid reader journal')
        if journal['phase']=='pending': raise common.Hold('reader Secret outcome uncertain')
        transport.verify(cluster_uid,namespace_uid)
        expected=base64.b64encode(token.encode()).decode()
        existing=transport.get(NAME)
        if journal['phase']=='complete':
            if not existing or existing.get('immutable') is not True or existing.get('metadata',{}).get('uid')!=journal['uid'] or existing.get('metadata',{}).get('annotations',{}).get(ANNOTATION)!=journal['transaction'] or set(existing.get('data',{}))!={'STRAPI_API_TOKEN'} or not hmac.compare_digest(existing['data']['STRAPI_API_TOKEN'],expected): raise common.Hold('reader Secret changed')
            return 'complete'
        if existing: raise common.Hold('reader Secret already exists without receipt')
        obj={'apiVersion':'v1','kind':'Secret','metadata':{'name':NAME,'namespace':namespace,'annotations':{ANNOTATION:journal['transaction']}},'immutable':True,'type':'Opaque','data':{'STRAPI_API_TOKEN':expected}}
        journal['phase']='pending'
        _write(directory,journal)
        transport.create(obj)
        existing=transport.get(NAME)
        if not existing or existing.get('immutable') is not True or existing.get('metadata',{}).get('annotations',{}).get(ANNOTATION)!=journal['transaction'] or not existing.get('metadata',{}).get('uid') or set(existing.get('data',{}))!={'STRAPI_API_TOKEN'} or not hmac.compare_digest(existing['data']['STRAPI_API_TOKEN'],expected): raise common.Hold('reader Secret creation uncertain')
        journal.update(phase='complete',uid=existing['metadata']['uid'])
        _write(directory,journal)
        return 'complete'
    finally: os.close(lock);os.close(directory)

def _write(directory,journal):
    temp=f'.reader-journal-{uuid.uuid4().hex}'
    common._write_exclusive(directory,temp,journal)
    os.replace(temp,'reader-secret.json',src_dir_fd=directory,dst_dir_fd=directory)
    os.fsync(directory)
