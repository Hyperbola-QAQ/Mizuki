import os,subprocess,sys,tempfile,unittest
from pathlib import Path
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
if __name__=='__main__':unittest.main()
