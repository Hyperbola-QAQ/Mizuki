#!/usr/bin/env python3
"""Replicate the immutable runtime source to two private, create-only stores."""
import argparse
import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
import db_credential_stage as common
import runtime_secret_stage as stage

REMOTE = r'''
import hmac,json,os,re,stat,sys
from pathlib import Path
ident=sys.argv[1]
parts=['.shirone-runtime-test-'+ident] if ident else ['.shirone-strapi','runtime-recovery']
if ident and not re.fullmatch(r'[0-9a-f]{16}',ident): raise SystemExit(2)
fd=os.open(Path.home(),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    info=os.fstat(fd)
    if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o022: raise SystemExit(2)
    for part in parts:
        try: os.mkdir(part,0o700,dir_fd=fd);os.fsync(fd)
        except FileExistsError: pass
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd);fd=child
        info=os.fstat(fd)
        if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(2)
    payload=sys.stdin.buffer.read(65537)
    if len(payload)>65536: raise SystemExit(2)
    obj=json.loads(payload)
    if obj.get('version')!=1 or not re.fullmatch(r'[0-9a-f]{32}',obj.get('transaction','')) or not isinstance(obj.get('objects'),dict): raise SystemExit(2)
    try: out=os.open('runtime.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    except FileExistsError:
        out=os.open('runtime.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        info=os.fstat(out)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1: raise SystemExit(2)
        with os.fdopen(out,'rb') as f: existing=f.read(65537)
        if not hmac.compare_digest(existing,payload): raise SystemExit(2)
    else:
        with os.fdopen(out,'wb') as f: f.write(payload);f.flush();os.fsync(f.fileno())
        os.fsync(fd)
    print('verified')
finally: os.close(fd)
'''

def replicate(path: Path, test_id=''):
    if test_id and not re.fullmatch(r'[0-9a-f]{16}',test_id): raise common.Hold('invalid test ID')
    directory=common._directory(path); lock=common._lock(directory)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        data,journal=common._read_private(directory,'runtime.json'),common._read_private(directory,'journal.json')
        stage._validate(data,journal)
        payload=json.dumps(data,separators=(',',':')).encode()
        for host in ('imini','laiku'):
            result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,shlex.join(['python3','-c',REMOTE,test_id])],input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=False)
            if result.returncode or result.stdout.strip()!=b'verified': raise common.Hold('recovery copy failed or differs')
    finally: os.close(lock);os.close(directory)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--stage',required=True,type=Path)
    parser.add_argument('--test-id',default='')
    parser.add_argument('--allow-production',action='store_true')
    args=parser.parse_args()
    try:
        if not args.test_id and not args.allow_production: raise common.Hold('explicit production flag required')
        replicate(args.stage,args.test_id)
        print('Both protected runtime recovery copies verified; the journal is not replicated.')
        return 0
    except (common.Hold,OSError,ValueError,subprocess.TimeoutExpired,BlockingIOError):
        print('Runtime recovery replication held; preserve the source.',file=sys.stderr)
        return 1
if __name__=='__main__': raise SystemExit(main())
