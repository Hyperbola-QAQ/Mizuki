import json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import db_credential_stage as common
import backup_primary as backup

class BackupTests(unittest.TestCase):
    def test_stream_encrypted_and_decryptable(self):
        with tempfile.TemporaryDirectory(prefix='backup-unit-') as folder:
            out=Path(folder)/'synthetic.gpg';key=b'synthetic-only-passphrase'
            backup.encrypted_stream(['printf','synthetic plaintext'],out,key)
            self.assertNotIn(b'synthetic plaintext',out.read_bytes())
            r,w=os.pipe();os.write(w,key+b'\n');os.close(w)
            try:
                result=subprocess.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase-fd',str(r),'--decrypt',str(out)],pass_fds=(r,),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True)
            finally:os.close(r)
            self.assertEqual(result.stdout,b'synthetic plaintext')
            with self.assertRaises(FileExistsError): backup.encrypted_stream(['printf','other'],out,key)
    def test_failed_producer_removes_partial_output(self):
        with tempfile.TemporaryDirectory(prefix='backup-unit-') as folder:
            out=Path(folder)/'synthetic.gpg'
            with self.assertRaises(common.Hold): backup.encrypted_stream(['false'],out,b'synthetic-passphrase')
            self.assertFalse(out.exists())
    def test_lost_fence_never_replicates_a_snapshot(self):
        class Transport:
            states=[{'held':True,'instance':'first'},{'held':True,'instance':'first'},{'held':False,'instance':'replacement'},{'released':True}]
            def verify(self,*args): pass
            @classmethod
            def run(cls,*args): return json.dumps(cls.states.pop(0)).encode()
        with tempfile.TemporaryDirectory(prefix='backup-unit-') as folder:
            directory=Path(folder);os.chmod(directory,0o700)
            with patch.object(backup,'Transport',Transport),patch.object(backup,'key_from_runtime',return_value=b'key'),patch.object(backup,'pod_info',return_value='synthetic-pod'),patch.object(backup,'encrypted_stream') as write,patch.object(backup,'remote_copy') as copy:
                with self.assertRaises(common.Hold): backup.snapshot(directory,directory,'cluster','namespace',True)
                self.assertEqual(write.call_count,1)
                copy.assert_not_called()
if __name__=='__main__':unittest.main()
