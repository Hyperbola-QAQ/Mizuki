#!/usr/bin/env python3
"""Encrypted, create-only snapshots of the dedicated database and upload claim.

The operator must fence application writes before invoking this tool. Encrypted
files are streamed to two owner-only remote stores; no plaintext backup is
written to disk. This is an on-demand primitive, not a scheduler.
"""
import argparse,datetime,hashlib,hmac,json,os,re,shlex,subprocess,sys,uuid
from pathlib import Path
import db_credential_stage as common
import runtime_secret_stage as runtime
from runtime_secret_kubectl import KUBECTL,Transport

REMOTE=r'''
import hashlib,os,re,stat,sys
from pathlib import Path
name,digest=sys.argv[1:]
if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}-(db|uploads)\.gpg',name) or not re.fullmatch(r'[0-9a-f]{64}',digest): raise SystemExit(2)
fd=os.open(Path.home(),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    info=os.fstat(fd)
    if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o022: raise SystemExit(2)
    for part in ('.shirone-strapi','primary-backups'):
        try: os.mkdir(part,0o700,dir_fd=fd);os.fsync(fd)
        except FileExistsError: pass
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
        info=os.fstat(fd)
        if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(2)
    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    result=hashlib.sha256()
    with os.fdopen(out,'wb') as f:
        while True:
            chunk=sys.stdin.buffer.read(1024*1024)
            if not chunk: break
            result.update(chunk);f.write(chunk)
        f.flush();os.fsync(f.fileno())
    os.fsync(fd)
    if result.hexdigest()!=digest: raise SystemExit(2)
    print('verified')
finally: os.close(fd)
'''

def key_from_runtime(path: Path):
    directory=common._directory(path)
    try:
        data=common._read_private(directory,'runtime.json');journal=common._read_private(directory,'journal.json')
        runtime._validate(data,journal)
        if journal.get('pending') is not None or len(journal.get('completed',{}))!=len(runtime.NAMES): raise common.Hold('runtime credential state incomplete')
        master=data['objects'][runtime.NAMES[0]]['MEILI_MASTER_KEY']
        return hmac.new(master.encode(),b'shirone-primary-backup-v1',hashlib.sha256).hexdigest().encode()
    finally: os.close(directory)

def encrypted_stream(command, output: Path, key: bytes):
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    read_fd,write_fd=os.pipe()
    os.write(write_fd,key+b'\n');os.close(write_fd)
    producer=None;encrypt=None
    try:
        producer=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        encrypt=subprocess.Popen(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-fd',str(read_fd),'--symmetric','--cipher-algo','AES256','--compress-algo','zlib'],stdin=producer.stdout,stdout=fd,stderr=subprocess.DEVNULL,pass_fds=(read_fd,))
        producer.stdout.close();os.close(read_fd);read_fd=-1
        if encrypt.wait(timeout=300)!=0 or producer.wait(timeout=30)!=0: raise common.Hold('snapshot stream failed')
        os.fsync(fd)
    except BaseException:
        for process in (encrypt,producer):
            if process and process.poll() is None: process.kill();process.wait()
        os.close(fd);fd=-1
        output.unlink(missing_ok=True)
        raise
    finally:
        if read_fd>=0: os.close(read_fd)
        if fd>=0: os.close(fd)

def remote_copy(file: Path, host: str):
    digest=hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''): digest.update(chunk)
    with file.open('rb') as source:
        command=shlex.join(['python3','-c',REMOTE,file.name,digest.hexdigest()])
        result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,command],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=300,check=False)
    if result.returncode or result.stdout.strip()!=b'verified': raise common.Hold('encrypted recovery copy failed or is uncertain')

def pod_info(namespace,selector):
    payload=Transport.run((*KUBECTL,'-n',namespace,'get','pods','-l',selector,'-o','json'))
    items=json.loads(payload).get('items',[])
    ready=[item for item in items if item.get('status',{}).get('phase')=='Running' and item.get('metadata',{}).get('deletionTimestamp') is None]
    if len(ready)!=1: raise common.Hold('expected exactly one running source pod')
    name=ready[0]['metadata']['name']
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',name): raise common.Hold('invalid pod name')
    return name

def snapshot(stage: Path, destination: Path, cluster_uid: str, namespace_uid: str):
    transport=Transport();transport.verify(cluster_uid,namespace_uid)
    key=key_from_runtime(stage)
    directory=common._directory(destination);os.close(directory)
    pg=pod_info('databases','cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary')
    cms=pod_info('mizuki','app=shirone-cms')
    ident=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:16]
    outputs=[destination/(ident+'-db.gpg'),destination/(ident+'-uploads.gpg')]
    for output,remote in zip(outputs,[(*KUBECTL,'-n','databases','exec',pg,'-c','postgres','--','pg_dump','-U','postgres','-Fc','shirone_cms'),(*KUBECTL,'-n','mizuki','exec',cms,'-c','cms','--','tar','-C','/opt/app/public/uploads','-cf','-','.')]):
        transport.verify(cluster_uid,namespace_uid)
        command=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','imini',shlex.join(remote)]
        encrypted_stream(command,output,key)
        for host in ('imini','laiku'): remote_copy(output,host)
    return ident

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime-stage',type=Path,required=True);parser.add_argument('--destination',type=Path,required=True);parser.add_argument('--cluster-uid',required=True);parser.add_argument('--namespace-uid',required=True);parser.add_argument('--confirm-writes-fenced',action='store_true');args=parser.parse_args()
    try:
        if not args.confirm_writes_fenced: raise common.Hold('application writes must be fenced')
        print('Encrypted snapshot completed:',snapshot(args.runtime_stage,args.destination,args.cluster_uid,args.namespace_uid))
        return 0
    except (common.Hold,OSError,ValueError,KeyError,subprocess.TimeoutExpired):
        print('Snapshot held or incomplete; preserve existing encrypted files and inspect before retry.',file=sys.stderr);return 1
if __name__=='__main__': raise SystemExit(main())
