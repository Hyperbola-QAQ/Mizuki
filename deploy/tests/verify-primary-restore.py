#!/usr/bin/env python3
"""Restore an encrypted snapshot only into a disposable local PostgreSQL tmpfs."""
import argparse,os,re,subprocess,sys,tarfile,time,uuid
from pathlib import Path,PurePosixPath
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import backup_primary as backup
import db_credential_stage as common

def decrypt(file,key):
    info=file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_uid!=os.geteuid() or info.st_mode&0o077: raise common.Hold('backup file is not private')
    read_fd,write_fd=os.pipe();os.write(write_fd,key+b'\n');os.close(write_fd)
    try:
        proc=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-fd',str(read_fd),'--decrypt',str(file)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,pass_fds=(read_fd,))
    finally: os.close(read_fd)
    return proc

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime-stage',required=True,type=Path);parser.add_argument('--backup-directory',required=True,type=Path);parser.add_argument('--snapshot',required=True);parser.add_argument('--image',required=True);parser.add_argument('--expected-posts',type=int);parser.add_argument('--expected-published',type=int);args=parser.parse_args()
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}',args.snapshot): raise common.Hold('invalid snapshot ID')
    key=backup.key_from_runtime(args.runtime_stage)
    db=args.backup_directory/(args.snapshot+'-db.gpg');uploads=args.backup_directory/(args.snapshot+'-uploads.gpg')
    name='shirone-restore-verify-'+uuid.uuid4().hex[:12]
    def docker(*cmd,**kwargs): return subprocess.run(['docker',*cmd],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
    try:
        docker('image','inspect',args.image)
        docker('run','-d','--name',name,'--network','none','--tmpfs','/tmp:rw,size=512m,uid=26,gid=26',args.image,'sh','-c','initdb -D /tmp/pgdata -U strapi --auth=trust >/dev/null && exec postgres -D /tmp/pgdata -h ""')
        for _ in range(100):
            if subprocess.run(['docker','exec',name,'pg_isready','-U','strapi','-d','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(.2)
        else: raise common.Hold('disposable database did not start')
        docker('exec',name,'createdb','-U','strapi','restore_verify')
        source=decrypt(db,key)
        restore=subprocess.Popen(['docker','exec','-i',name,'pg_restore','--exit-on-error','--no-owner','--no-privileges','-U','strapi','-d','restore_verify'],stdin=source.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        source.stdout.close()
        try:
            restore_status=restore.wait(timeout=180);decrypt_status=source.wait(timeout=30)
        except subprocess.TimeoutExpired:
            restore.kill();source.kill();restore.wait();source.wait();raise
        if restore_status or decrypt_status: raise common.Hold('database restore failed')
        count=docker('exec',name,'psql','-X','-A','-t','-U','strapi','-d','restore_verify','-c',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").stdout.decode().strip()
        if not count.isdigit() or int(count)<1: raise common.Hold('restored database has no application tables')
        if args.expected_posts is not None and args.expected_published is not None:
            result=docker('exec',name,'psql','-X','-A','-t','-U','strapi','-d','restore_verify','-c',"SELECT count(DISTINCT document_id), count(DISTINCT document_id) FILTER (WHERE published_at IS NOT NULL) FROM posts").stdout.decode().strip()
            if result!=f'{args.expected_posts}|{args.expected_published}': raise common.Hold('restored post counts differ')
        source=decrypt(uploads,key);files=0
        try:
            with tarfile.open(fileobj=source.stdout,mode='r|') as archive:
                for entry in archive:
                    path=PurePosixPath(entry.name)
                    if path.is_absolute() or '..' in path.parts or not (entry.isfile() or entry.isdir()): raise common.Hold('unsafe upload archive entry')
                    if entry.isfile():
                        stream=archive.extractfile(entry)
                        while stream.read(1024*1024): pass
                        files+=1
            source.stdout.close()
            if source.wait(timeout=30): raise common.Hold('upload backup decryption failed')
        except BaseException:
            if source.poll() is None: source.kill();source.wait()
            raise
        print(f'Encrypted snapshot restored into disposable database; {count} tables and {files} uploaded files verified.')
    finally:
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)

try: main()
except (common.Hold,OSError,ValueError,subprocess.SubprocessError,tarfile.TarError):
    print('Isolated restore verification failed; no live data was modified.',file=sys.stderr);raise SystemExit(1)
