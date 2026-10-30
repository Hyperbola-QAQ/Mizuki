#!/usr/bin/env python3
"""Copy a completed bootstrap state, create-only, to two owner-only stores."""
import argparse
import hashlib
import json
import os
import shlex
import stat
import subprocess
import sys
from pathlib import Path
import db_credential_stage as common
import runtime_secret_replicate as replica

REMOTE = replica.REMOTE.replace("'.shirone-runtime-test-'+ident", "'.shirone-admin-test-'+ident").replace("'runtime-recovery'", "'admin-recovery'").replace("'runtime.json'", "'bootstrap.json'")
FILES=('admin.json','identity.json','reader.token','reader.json','import.token','import.json')

def _read_file(directory, name):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1:
        os.close(fd);raise common.Hold('unsafe bootstrap file')
    with os.fdopen(fd,'r',encoding='utf8') as file:
        data=file.read(65537)
    if not data or len(data)>65536: raise common.Hold('invalid bootstrap file')
    return data

def replicate(path: Path, test_id=''):
    if test_id and not __import__('re').fullmatch(r'[0-9a-f]{16}',test_id): raise common.Hold('invalid test ID')
    directory=common._directory(path)
    try:
        if any((path/name).exists() for name in ('.bootstrap.lock','reader.pending','import.pending')): raise common.Hold('bootstrap is incomplete')
        files={name:_read_file(directory,name) for name in FILES}
        admin=json.loads(files['admin.json']); identity=json.loads(files['identity.json'])
        if not admin.get('email') or identity.get('email')!=admin['email'] or not identity.get('userId'): raise common.Hold('bootstrap identity mismatch')
        tx=hashlib.sha256((str(identity['userId'])+'\0'+identity['email']).encode()).hexdigest()[:32]
        payload=json.dumps({'version':1,'transaction':tx,'objects':{'bootstrap':files}},separators=(',',':')).encode()
        for host in ('imini','laiku'):
            result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,shlex.join(['python3','-c',REMOTE,test_id])],input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=False)
            if result.returncode or result.stdout.strip()!=b'verified': raise common.Hold('recovery copy failed or differs')
    finally: os.close(directory)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--stage',required=True,type=Path);parser.add_argument('--allow-production',action='store_true')
    args=parser.parse_args()
    try:
        if not args.allow_production: raise common.Hold('explicit production flag required')
        replicate(args.stage)
        print('Both protected administrator recovery copies verified.')
        return 0
    except (common.Hold,OSError,ValueError,subprocess.TimeoutExpired):
        print('Administrator recovery copy held; preserve local state.',file=sys.stderr);return 1
if __name__=='__main__': raise SystemExit(main())
