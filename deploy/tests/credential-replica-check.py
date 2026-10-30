#!/usr/bin/env python3
"""Explicit opt-in SSH recovery copy check; uses synthetic credentials only."""
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import uuid

if os.environ.get('SHIRONE_ALLOW_DISPOSABLE_SSH_TEST') != 'yes':
    raise SystemExit('Set SHIRONE_ALLOW_DISPOSABLE_SSH_TEST=yes only for disposable test directories')
root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'deploy/tools'))
import db_credential_stage as stage
import db_credential_replicate as replica
ident = uuid.uuid4().hex[:16]
cleanup = r'''
import os,stat,sys
from pathlib import Path
n='.shirone-credtest-'+sys.argv[1]
if not __import__('re').fullmatch(r'\.shirone-credtest-[0-9a-f]{16}',n): raise SystemExit(2)
home=os.open(Path.home(),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
  try: d=os.open(n,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=home)
  except FileNotFoundError: raise SystemExit(0)
  try:
    q=os.fstat(d)
    if q.st_uid!=os.geteuid() or stat.S_IMODE(q.st_mode)!=0o700: raise SystemExit(2)
    names=os.listdir(d)
    if any(x!='credential.json' for x in names): raise SystemExit(2)
    if 'credential.json' in names:
      f=os.open('credential.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=d)
      try:
        i=os.fstat(f)
        if not stat.S_ISREG(i.st_mode) or i.st_uid!=os.geteuid() or stat.S_IMODE(i.st_mode)!=0o600: raise SystemExit(2)
      finally: os.close(f)
      os.unlink('credential.json',dir_fd=d)
    os.fsync(d)
  finally: os.close(d)
  os.rmdir(n,dir_fd=home);os.fsync(home)
finally: os.close(home)
'''
try:
    with tempfile.TemporaryDirectory(prefix='shirone-copy-check-', dir='/tmp') as folder:
        root1 = pathlib.Path(folder) / 'one'; root1.mkdir(mode=0o700)
        root2 = pathlib.Path(folder) / 'two'; root2.mkdir(mode=0o700)
        stage.initialize(root1); stage.initialize(root2)
        replica.replicate(root1, ident)
        replica.replicate(root1, ident)
        try: replica.replicate(root2, ident)
        except stage.Hold: pass
        else: raise AssertionError('existing recovery copy must not be overwritten')
    print('Synthetic SSH copies: both nodes, idempotence and mismatch HOLD passed')
finally:
    failed=[]
    for host in replica.HOSTS:
        remote=shlex.join(['python3','-c',cleanup,ident])
        result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,remote],
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        if result.returncode: failed.append(host)
    if failed: raise SystemExit('Disposable recovery cleanup failed for '+','.join(failed))
    print('Disposable SSH recovery copies removed')
