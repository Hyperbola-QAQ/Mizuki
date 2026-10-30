#!/usr/bin/env python3
"""Opt-in two-host test using random synthetic state and uniquely named directories."""
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import db_credential_stage as common
import runtime_secret_stage as stage
import runtime_secret_replicate as replica
if os.environ.get('SHIRONE_ALLOW_DISPOSABLE_SSH_TEST')!='yes': raise SystemExit('disposable opt-in required')
ident=secrets.token_hex(8)
try:
    with tempfile.TemporaryDirectory(prefix='shirone-runtime-replica-') as directory:
        path=Path(directory); os.chmod(path,0o700)
        stage.initialize(path)
        replica.replicate(path,ident)
        replica.replicate(path,ident)
        with tempfile.TemporaryDirectory(prefix='shirone-runtime-conflict-') as other:
            second=Path(other);os.chmod(second,0o700);stage.initialize(second)
            try: replica.replicate(second,ident)
            except common.Hold: pass
            else: raise AssertionError('conflicting credentials were accepted')
        print('Synthetic recovery copies verified twice; differing source refused.')
finally:
    # This exact random directory is created only by this test; do not recurse.
    for host in ('imini','laiku'):
        command="python3 -c " + __import__('shlex').quote("import os, pathlib, sys; p=pathlib.Path.home()/sys.argv[1]; f=p/'runtime.json'; f.unlink(missing_ok=True); p.rmdir() if p.exists() else None") + ' ' + __import__('shlex').quote('.shirone-runtime-test-'+ident)
        result=subprocess.run(['ssh','-o','BatchMode=yes',host,command],capture_output=True,timeout=30)
        if result.returncode: raise RuntimeError('synthetic recovery directory cleanup failed')
