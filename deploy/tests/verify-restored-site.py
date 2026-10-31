#!/usr/bin/env python3
"""Boot restored production data in disposable, loopback-only containers."""
import argparse,os,re,shutil,stat,subprocess,sys,tarfile,tempfile,time,urllib.request,uuid
from pathlib import Path,PurePosixPath
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import backup_primary as backup
import db_credential_stage as common
import bootstrap_replicate as bootstrap

def decrypt(file,key):
    info=file.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077: raise common.Hold('backup is not private')
    read_fd,write_fd=os.pipe();os.write(write_fd,key+b'\n');os.close(write_fd)
    try: return subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-fd',str(read_fd),'--decrypt',str(file)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,pass_fds=(read_fd,))
    finally: os.close(read_fd)

def main():
    p=argparse.ArgumentParser();p.add_argument('--runtime-stage',type=Path,required=True);p.add_argument('--bootstrap-stage',type=Path,required=True);p.add_argument('--backup-directory',type=Path,required=True);p.add_argument('--snapshot',required=True);p.add_argument('--db-image',required=True);p.add_argument('--cms-image',required=True);p.add_argument('--ssr-image',required=True);p.add_argument('--confirm-disposable',action='store_true');args=p.parse_args()
    if not args.confirm_disposable or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}',args.snapshot): raise common.Hold('disposable confirmation or snapshot invalid')
    key=backup.key_from_runtime(args.runtime_stage)
    directory=common._directory(args.runtime_stage)
    try: runtime=common._read_private(directory,'runtime.json')['objects']['shirone-cms']
    finally: os.close(directory)
    directory=common._directory(args.bootstrap_stage)
    try: reader=bootstrap._read_file(directory,'reader.token').strip()
    finally: os.close(directory)
    network='shirone-restore-site-'+uuid.uuid4().hex[:12]
    names=[network+'-'+part for part in ('db','cms','ssr')]
    def docker(*cmd,**kwargs):return subprocess.run(['docker',*cmd],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs).stdout.decode().strip()
    def wait(fn):
        for _ in range(200):
            try:
                result=fn()
                if result:return result
            except (OSError,subprocess.SubprocessError):pass
            time.sleep(.25)
        raise common.Hold('disposable service did not become ready')
    with tempfile.TemporaryDirectory(prefix='shirone-restore-site-',dir='/dev/shm') as temp:
        temporary=Path(temp);uploads=temporary/'uploads';uploads.mkdir(mode=0o777);os.chmod(uploads,0o777)
        # Docker's daemon must traverse the private tmpfs parent to mount it.
        os.chmod(temporary,0o711)
        try:
            for image in (args.db_image,args.cms_image,args.ssr_image):docker('image','inspect',image)
            db=args.backup_directory/(args.snapshot+'-db.gpg');media=args.backup_directory/(args.snapshot+'-uploads.gpg')
            source=decrypt(media,key)
            try:
                with tarfile.open(fileobj=source.stdout,mode='r|') as archive:
                    for item in archive:
                        if PurePosixPath(item.name).is_absolute() or '..' in PurePosixPath(item.name).parts or not (item.isfile() or item.isdir()): raise common.Hold('unsafe media archive')
                        archive.extract(item,path=uploads,filter='data')
                source.stdout.close()
                if source.wait(timeout=30):raise common.Hold('media decryption failed')
            except BaseException:
                if source.poll() is None:source.kill();source.wait()
                raise
            docker('network','create',network)
            docker('run','-d','--name',names[0],'--network',network,'--network-alias','db','--tmpfs','/tmp:rw,size=512m,uid=26,gid=26',args.db_image,'sh','-c','initdb -D /tmp/pgdata -U strapi --auth=trust >/dev/null && printf "host all all 172.16.0.0/12 trust\\n" >> /tmp/pgdata/pg_hba.conf && exec postgres -D /tmp/pgdata -h 0.0.0.0')
            wait(lambda:subprocess.run(['docker','exec',names[0],'pg_isready','-U','strapi'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0)
            docker('exec',names[0],'createdb','-U','strapi','strapi')
            source=decrypt(db,key)
            restore=subprocess.Popen(['docker','exec','-i',names[0],'pg_restore','--exit-on-error','--no-owner','--no-privileges','-U','strapi','-d','strapi'],stdin=source.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            source.stdout.close()
            if restore.wait(timeout=180) or source.wait(timeout=30):raise common.Hold('database restore failed')
            counts=docker('exec',names[0],'psql','-X','-A','-t','-U','strapi','-d','strapi','-c',"SELECT count(DISTINCT document_id),count(DISTINCT document_id) FILTER (WHERE published_at IS NOT NULL) FROM posts")
            if counts!='63|55':raise common.Hold('restored archive counts differ')
            # Secret-bearing env files stay on tmpfs and are never printed.
            cmsenv={**runtime,'DATABASE_HOST':'db','DATABASE_NAME':'strapi','DATABASE_USERNAME':'strapi','DATABASE_PASSWORD':'synthetic','DATABASE_SSL':'false','HOST':'0.0.0.0','PORT':'1337'}
            ssrenv={'STRAPI_URL':'http://cms:1337','STRAPI_API_TOKEN':reader,'HOST':'0.0.0.0','PORT':'4321'}
            for filename,values in [('cms.env',cmsenv),('ssr.env',ssrenv)]:
                target=temporary/filename;target.write_text(''.join(f'{k}={v}\n' for k,v in values.items()));os.chmod(target,0o600)
            docker('run','-d','--name',names[1],'--network',network,'--network-alias','cms','-p','127.0.0.1::1337','--env-file',str(temporary/'cms.env'),'-v',f'{uploads}:/opt/app/public/uploads',args.cms_image)
            cmsport=docker('port',names[1],'1337/tcp').rsplit(':',1)[1]
            wait(lambda:urllib.request.urlopen(f'http://127.0.0.1:{cmsport}/_health',timeout=2).status==204)
            docker('run','-d','--name',names[2],'--network',network,'-p','127.0.0.1::4321','--env-file',str(temporary/'ssr.env'),args.ssr_image)
            port=docker('port',names[2],'4321/tcp').rsplit(':',1)[1]
            base=f'http://127.0.0.1:{port}'
            home=wait(lambda:urllib.request.urlopen(base+'/',timeout=5).read())
            if 'MangoHud 不显示 CPU'.encode() not in home:raise common.Hold('restored homepage missing migrated article')
            with urllib.request.urlopen(base+'/uploads/04_labeled_5c06dfcbe7.png',timeout=10) as image:
                if image.status!=200 or len(image.read())!=198034:raise common.Hold('restored public media differs')
            print('Disposable restored CMS and SSR served the 63-post archive and a restored public image.')
        finally:
            for name in reversed(names):subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)

try:main()
except (common.Hold,OSError,ValueError,KeyError,tarfile.TarError,subprocess.SubprocessError):
    print('Restored-site verification failed; no live application data was modified.',file=sys.stderr);raise SystemExit(1)
