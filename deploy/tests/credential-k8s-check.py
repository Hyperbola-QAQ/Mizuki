import importlib.util,json,os,pathlib,shlex,subprocess,sys,tempfile,time,uuid
if os.environ.get('SHIRONE_ALLOW_DISPOSABLE_K8S_TEST') != 'yes':
  raise SystemExit('Set SHIRONE_ALLOW_DISPOSABLE_K8S_TEST=yes only for reviewed disposable namespace tests')
root=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'deploy/tools'))
import db_credential_stage as stage
import db_credential_kubectl as transport
K=('kubectl','--request-timeout=15s','--kubeconfig=/home/hyperbola/.kube/config')
def run(args,data=None):
    p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','imini',shlex.join(args)],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if p.returncode: raise RuntimeError('test-only Kubernetes command failed')
    return p.stdout
uid=run((*K,'-n','databases','get','clusters.postgresql.cnpg.io','postgresql','-o','jsonpath={.metadata.uid}')).decode()
if uid != os.environ.get('SHIRONE_EXPECTED_CNPG_UID'):
  raise SystemExit('Kubernetes Cluster UID differs from the explicitly reviewed UID')
suffix=uuid.uuid4().hex[:12]
names=[f'shirone-credtest-{suffix}-{x}' for x in ('a','b','c','d','e','f')]
created={}
try:
  for name in names:
    resource={'apiVersion':'v1','kind':'Namespace','metadata':{'name':name,'labels':{'shirone.hyperbola.cc/disposable-test':suffix}}}
    out=run((*K,'create','-f','-','-o','json'),json.dumps(resource).encode())
    created[name]=json.loads(out)['metadata']['uid']
  with tempfile.TemporaryDirectory(prefix='shirone-secret-stage-',dir='/tmp') as folder:
    path=pathlib.Path(folder);os.chmod(path,0o700); stage.initialize(path)
    pair=tuple(names[:2]); uids=tuple(created[n] for n in pair);client=transport.Transport(uid,pair,uids)
    assert stage.reconcile(path,client.get,client.create,cluster_uid=uid,namespace_uids=uids,namespaces=pair)=='complete'
    assert stage.reconcile(path,client.get,client.create,cluster_uid=uid,namespace_uids=uids,namespaces=pair)=='complete'
    assert client.get(pair[0],stage.SECRET_NAME)['data']==client.get(pair[1],stage.SECRET_NAME)['data']
  with tempfile.TemporaryDirectory(prefix='shirone-secret-fault-',dir='/tmp') as folder:
    path=pathlib.Path(folder);os.chmod(path,0o700);stage.initialize(path)
    pair=tuple(names[2:4]);uids=tuple(created[n] for n in pair);client=transport.Transport(uid,pair,uids)
    def lost_ack(obj):
      client.create(obj)
      raise TimeoutError('synthetic lost acknowledgement')
    try: stage.reconcile(path,client.get,lost_ack,cluster_uid=uid,namespace_uids=uids,namespaces=pair)
    except TimeoutError: pass
    else: raise AssertionError('expected injected lost acknowledgement')
    assert json.loads((path/'journal.json').read_text())['phase']=='creating_db'
    try: stage.reconcile(path,client.get,client.create,cluster_uid=uid,namespace_uids=uids,namespaces=pair)
    except stage.Hold: pass
    else: raise AssertionError('pending transaction must hold')
    assert client.get(pair[0],stage.SECRET_NAME) is not None
    assert client.get(pair[1],stage.SECRET_NAME) is None
  with tempfile.TemporaryDirectory(prefix='shirone-secret-ansible-',dir='/tmp') as folder:
    path=pathlib.Path(folder);os.chmod(path,0o700);pair=tuple(names[4:]);uids=tuple(created[n] for n in pair)
    play=str(root/'deploy/ansible/manage-db-credentials.yml')
    common={'shirone_stage_dir':str(path),'shirone_cluster_uid':uid,'shirone_db_namespace':pair[0],
            'shirone_cms_namespace':pair[1],'shirone_db_namespace_uid':uids[0], 'shirone_cms_namespace_uid':uids[1]}
    def ansible(action, check=False):
      env=dict(os.environ,SHIRONE_WORKSPACE=str(root));values=dict(common,shirone_credential_action=action)
      command=['ansible-playbook','-i','localhost,','-e',json.dumps(values)] + (['--check'] if check else []) + [play]
      p=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
      if p.returncode: raise RuntimeError('Ansible test failed: '+action)
    ansible('init',True)
    assert not (path/'credential.json').exists()
    ansible('init')
    ansible('apply')
    ansible('apply')
    client=transport.Transport(uid,pair,uids)
    assert client.get(pair[0],stage.SECRET_NAME)['data']==client.get(pair[1],stage.SECRET_NAME)['data']
    print('Ansible credential init, check-mode safety, apply and repeat verification passed')
  print('Disposable Kubernetes Secrets: create-only, matching, idempotence and lost-ack HOLD passed')
finally:
  for name,expected_uid in created.items():
    obj=json.loads(run((*K,'get','namespace',name,'-o','json')))
    if obj['metadata']['uid']!=expected_uid or obj['metadata'].get('labels',{}).get('shirone.hyperbola.cc/disposable-test')!=suffix:
      print('Test namespace identity changed; manual cleanup required:',name,file=sys.stderr);continue
    run((*K,'delete','namespace',name,'--wait=false'))
  for _ in range(60):
    remaining=[name for name in created if run((*K,'get','namespace',name,'--ignore-not-found','-o','name')).strip()]
    if not remaining: break
    time.sleep(.5)
  if remaining:
    print('Test namespace deletion pending:',','.join(remaining),file=sys.stderr)
    raise SystemExit(1)
  print('Disposable namespaces and Secrets removed')
