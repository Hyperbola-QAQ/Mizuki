import os, subprocess, tempfile, pathlib, time, socket
from jinja2 import Environment, FileSystemLoader
def free_port():
 with socket.socket() as probe:
  probe.bind(('127.0.0.1',0))
  return probe.getsockname()[1]
relay_port=free_port(); origin_port=free_port()
while origin_port==relay_port: origin_port=free_port()
root=pathlib.Path(tempfile.mkdtemp(prefix='shirone-relay-',dir='/tmp')); root.chmod(0o755)
def run(*args,**kw): return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw)
def openssl(*args): run('openssl',*args,cwd=root)
def cert(name,ext):
 openssl('req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name)
 (root/(name+'.ext')).write_text(ext)
 openssl('x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',name+'.crt','-days','1','-extfile',name+'.ext')
for f in ['run','run/client_body','run/proxy']: (root/f).mkdir(mode=0o777)
for f in ['run','run/client_body','run/proxy']: (root/f).chmod(0o777)
openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Test CA')
cert('server','subjectAltName=DNS:hyperbola.cc,DNS:www.hyperbola.cc,DNS:blog.hyperbola.cc,DNS:strapi.hyperbola.cc\nextendedKeyUsage=serverAuth\n')
cert('client','extendedKeyUsage=clientAuth\n')
openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','forged.key','-out','forged.crt','-days','1','-subj','/CN=Untrusted client')
for f in root.iterdir():
 if f.is_file(): f.chmod(0o644)
base='/work'; p=lambda x:base+'/'+x
hosts=['hyperbola.cc','www.hyperbola.cc','blog.hyperbola.cc','strapi.hyperbola.cc']
t=Environment(loader=FileSystemLoader(str(pathlib.Path(__file__).resolve().parents[1]))).get_template('relay-nginx.conf.j2')
s=t.render(shirone_relay_runtime=p('run'),shirone_relay_hostnames=hosts,shirone_relay_listen=f'127.0.0.1:{relay_port}',shirone_relay_cert=p('server.crt'),shirone_relay_key=p('server.key'),shirone_relay_client_ca=p('ca.crt'),shirone_relay_origin_ca=p('ca.crt'),shirone_relay_upstream=f'127.0.0.1:{origin_port}')
pos=s.rfind('}');s=s[:pos]+f' server {{ listen 127.0.0.1:{origin_port} ssl; ssl_certificate {p("server.crt")}; ssl_certificate_key {p("server.key")}; location / {{ add_header X-Received-Host $http_x_forwarded_host always; return 200 "origin ok"; }} }}\n'+s[pos:]
(root/'nginx.conf').write_text(s)
name='shirone-relay-check-'+str(os.getpid());image='192.168.86.100:30500/ca-clean/nginx-unprivileged:881a32046cbe-20261021'
try:
 run('docker','run','-d','--rm','--name',name,'--network','host','-v',str(root)+':/work:rw',image,'nginx','-g','daemon off;','-c','/work/nginx.conf')
 for _ in range(30):
  try:
   sock=socket.create_connection(('127.0.0.1',relay_port),timeout=.2);sock.close();break
  except OSError: time.sleep(.2)
 def curl(host,headers=(),client=True,forged=False):
  cmd=['curl','--noproxy','*','--resolve',f'{host}:{relay_port}:127.0.0.1','--cacert',str(root/'ca.crt'),'--max-time','3','-sS','-o','/dev/null','-w','%{http_code}']
  if client:
   cert_name = 'forged' if forged else 'client'
   cmd+=['--cert',str(root/(cert_name+'.crt')),'--key',str(root/(cert_name+'.key'))]
  for h in headers: cmd+=['-H',h]
  p=subprocess.run(cmd+[f'https://{host}:{relay_port}/'],capture_output=True,text=True);return p.returncode,p.stdout
 for host in hosts:
  r=curl(host);assert r==(0,'200'),(host,r)
 assert curl('hyperbola.cc',['Host: strapi.hyperbola.cc'])==(0,'421')
 assert curl('hyperbola.cc',client=False)[1] in ('400','403')
 assert curl('hyperbola.cc',forged=True)[1] in ('400','403')
 unknown=curl('unknown.hyperbola.cc');assert unknown[0]!=0,unknown
 cmd=['curl','--noproxy','*','--resolve',f'hyperbola.cc:{relay_port}:127.0.0.1','--cacert',str(root/'ca.crt'),'--cert',str(root/'client.crt'),'--key',str(root/'client.key'),'-sS','-D','-','-o','/dev/null','-H','X-Forwarded-Host: attacker.example',f'https://hyperbola.cc:{relay_port}/']
 output=run(*cmd).stdout.decode().lower()
 assert 'x-received-host: hyperbola.cc' in output and 'x-received-host: attacker.example' not in output
 # Change only the relay's trust anchor for the upstream and reload nginx.
 bad=s.replace('proxy_ssl_trusted_certificate /work/ca.crt;', 'proxy_ssl_trusted_certificate /work/forged.crt;')
 (root/'nginx.conf').write_text(bad)
 run('docker','exec',name,'nginx','-s','reload','-c','/work/nginx.conf')
 for _ in range(30):
  if curl('hyperbola.cc') == (0,'502'): break
  time.sleep(.1)
 else: raise AssertionError('untrusted upstream certificate was not rejected')
 print('PASS: four TLS names; mismatched Host, absent or forged client certificates, unknown SNI and untrusted upstream rejected; forwarded Host overwritten')
finally:
 subprocess.run(['docker','rm','-f',name],capture_output=True)
 import shutil;shutil.rmtree(root)
