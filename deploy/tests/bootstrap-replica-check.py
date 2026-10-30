#!/usr/bin/env python3
import json,os,secrets,shlex,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import bootstrap_replicate as replica
import db_credential_stage as common
if os.environ.get('SHIRONE_ALLOW_DISPOSABLE_SSH_TEST')!='yes': raise SystemExit('disposable opt-in required')
ident=secrets.token_hex(8)
try:
    with tempfile.TemporaryDirectory(prefix='bootstrap-test-') as folder:
        path=Path(folder);os.chmod(path,0o700)
        values={'admin.json':json.dumps({'email':'synthetic@example.invalid','password':'synthetic'}),'identity.json':json.dumps({'email':'synthetic@example.invalid','userId':1}),
                'reader.token':'synthetic-reader','reader.json':'{}','import.token':'synthetic-import','import.json':'{}'}
        for name,value in values.items(): (path/name).write_text(value);os.chmod(path/name,0o600)
        replica.replicate(path,ident);replica.replicate(path,ident)
        (path/'reader.pending').write_text('pending')
        try: replica.replicate(path,ident)
        except common.Hold: pass
        else: raise AssertionError('pending bootstrap state was accepted')
    print('Synthetic administrator recovery copies verified; pending state refused.')
finally:
    for host in ('imini','laiku'):
        code="import pathlib,sys; p=pathlib.Path.home()/sys.argv[1]; (p/'bootstrap.json').unlink(missing_ok=True); p.rmdir() if p.exists() else None"
        command=shlex.join(['python3','-c',code,'.shirone-admin-test-'+ident])
        result=subprocess.run(['ssh','-o','BatchMode=yes',host,command],capture_output=True,timeout=30)
        if result.returncode: raise RuntimeError('synthetic recovery cleanup failed')
