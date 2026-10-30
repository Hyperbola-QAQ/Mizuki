#!/usr/bin/env python3
"""Create-only private recovery copies of the CMS credential source via SSH.

This is not a journal backup and cannot authorize a pending transaction retry.
No credential is passed in argv or written to stdout/stderr. Test mode uses
only explicitly named disposable directories under the remote user's home.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
import db_credential_stage as stage

HOSTS = ('imini', 'laiku')
REMOTE = r'''
import hmac,json,os,stat,sys
from pathlib import Path
mode=sys.argv[1]
ident=sys.argv[2] if len(sys.argv)>2 else ''
if mode=='test':
    if not __import__('re').fullmatch(r'[0-9a-f]{16}',ident): raise SystemExit(2)
    components=['.shirone-credtest-'+ident]
elif mode=='production':
    components=['.shirone-strapi','credential-recovery']
else: raise SystemExit(2)
home=Path.home()
fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    info=os.fstat(fd)
    if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o022: raise SystemExit(2)
    for part in components:
        try: os.mkdir(part,0o700,dir_fd=fd);os.fsync(fd)
        except FileExistsError: pass
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd);fd=child
        info=os.fstat(fd)
        if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(2)
    payload=sys.stdin.buffer.read(16385)
    if len(payload)>16384: raise SystemExit(2)
    obj=json.loads(payload)
    if (obj.get('version')!=1 or obj.get('username')!='shirone_cms' or
        not isinstance(obj.get('password'),str) or len(obj['password'])<48 or
        not __import__('re').fullmatch(r'[0-9a-f]{32}',obj.get('transaction',''))): raise SystemExit(2)
    try:
        out=os.open('credential.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    except FileExistsError:
        out=os.open('credential.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        info=os.fstat(out)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1: raise SystemExit(2)
        with os.fdopen(out,'rb') as f: existing=f.read(16385)
        if not hmac.compare_digest(existing,payload): raise SystemExit(2)
    else:
        with os.fdopen(out,'wb') as f:
            f.write(payload);f.flush();os.fsync(f.fileno())
        os.fsync(fd)
    print('verified')
finally: os.close(fd)
'''

def replicate(path: Path, test_id: str | None = None) -> None:
    if test_id is not None and not re.fullmatch(r'[0-9a-f]{16}', test_id):
        raise stage.Hold('invalid disposable test identifier')
    directory = stage._directory(path)
    try:
        lock = stage._lock(directory)
    except BaseException:
        __import__('os').close(directory)
        raise
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credential = stage._read_private(directory, 'credential.json')
        journal = stage._read_private(directory, 'journal.json')
        if (credential.get('version') != 1 or journal.get('version') != 1 or
            credential.get('username') != stage.USERNAME or
            credential.get('transaction') != journal.get('transaction') or
            not isinstance(credential.get('password'), str) or len(credential['password']) < 48):
            raise stage.Hold('credential stage identity is invalid')
        payload = json.dumps(credential, separators=(',', ':')).encode()
        args = ['python3', '-c', REMOTE, 'test' if test_id else 'production']
        if test_id: args.append(test_id)
        for host in HOSTS:
            try:
                result = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,shlex.join(args)],
                                        input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        timeout=30, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise stage.Hold('recovery copy result uncertain; review both hosts') from exc
            if result.returncode or result.stdout.strip() != b'verified':
                raise stage.Hold('recovery copy failed or conflicts; review both hosts')
    finally:
        __import__('os').close(lock)
        __import__('os').close(directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True, type=Path)
    parser.add_argument('--test-id')
    parser.add_argument('--confirm-production', action='store_true')
    args = parser.parse_args()
    try:
        if not args.test_id and not args.confirm_production:
            raise stage.Hold('production copy requires explicit confirmation')
        replicate(args.stage, args.test_id)
        print('Both protected recovery copies verified; transaction journal was not copied.')
        return 0
    except (stage.Hold, OSError, ValueError, BlockingIOError):
        print('Recovery copy held; do not provision credentials until reviewed.', file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
