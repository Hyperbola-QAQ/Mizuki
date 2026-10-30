#!/usr/bin/env python3
"""Create and remove only two uniquely named, UID-checked test namespaces."""
import json,os,secrets,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import db_credential_stage as common
import runtime_secret_stage as stage
from runtime_secret_kubectl import Transport,KUBECTL
import reader_secret_stage as reader
from reader_secret_kubectl import ReaderTransport
if os.environ.get('SHIRONE_ALLOW_DISPOSABLE_K8S_TEST')!='yes': raise SystemExit('disposable opt-in required')
run=Transport.run
cluster=run((*KUBECTL,'get','namespace','kube-system','-o','jsonpath={.metadata.uid}')).decode().strip()
if cluster!=os.environ.get('SHIRONE_EXPECTED_KUBE_SYSTEM_UID'): raise SystemExit('unexpected cluster')
names=[f'shirone-runtime-test-{secrets.token_hex(8)}' for _ in range(2)]
created={}
try:
    for name in names:
        obj={'apiVersion':'v1','kind':'Namespace','metadata':{'name':name,'labels':{'shirone.hyperbola.cc/disposable-test':'runtime'}}}
        created[name]=json.loads(run((*KUBECTL,'create','-f','-','-o','json'),json.dumps(obj).encode()))['metadata']['uid']
    for i,name in enumerate(names):
        with tempfile.TemporaryDirectory(prefix='runtime-k8s-check-') as directory:
            path=Path(directory);os.chmod(path,0o700);stage.initialize(path)
            client=Transport(name)
            if i==0:
                assert stage.reconcile(path,client,cluster,created[name],name)=='complete'
                assert stage.reconcile(path,client,cluster,created[name],name)=='complete'
                token=path/'reader.token';token.write_text('synthetic-reader-token');os.chmod(token,0o600)
                reader_client=ReaderTransport(name)
                assert reader.reconcile(path,reader_client,cluster,created[name],name)=='complete'
                assert reader.reconcile(path,reader_client,cluster,created[name],name)=='complete'
            else:
                original=client.create
                def lost_ack(obj): original(obj);raise common.Hold('synthetic lost acknowledgement')
                client.create=lost_ack
                try: stage.reconcile(path,client,cluster,created[name],name)
                except common.Hold: pass
                else: raise AssertionError('missing injected failure')
                client.create=original
                try: stage.reconcile(path,client,cluster,created[name],name)
                except common.Hold: pass
                else: raise AssertionError('uncertain creation was retried')
                assert client.get(stage.NAMES[0]) is not None
                assert client.get(stage.NAMES[1]) is None
    print('Disposable runtime Secrets: create-only, idempotence and lost-ack HOLD passed.')
finally:
    for name,uid in created.items():
        obj=json.loads(run((*KUBECTL,'get','namespace',name,'-o','json')))
        if obj['metadata']['uid']!=uid or obj['metadata'].get('labels',{}).get('shirone.hyperbola.cc/disposable-test')!='runtime':
            raise RuntimeError('test namespace identity changed; cleanup held')
        run((*KUBECTL,'delete','namespace',name,'--wait=false'))
    for _ in range(60):
        if all(not run((*KUBECTL,'get','namespace',name,'--ignore-not-found','-o','name')).strip() for name in created): break
        time.sleep(.5)
    else: raise RuntimeError('test namespace deletion pending')
    print('Disposable namespaces removed.')
