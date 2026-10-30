import copy,json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import db_credential_stage as common
import reader_secret_stage as stage

class Transport:
    def __init__(self): self.obj=None;self.creations=0;self.fail=False
    def verify(self,cluster,namespace):
        if (cluster,namespace)!=('cluster','namespace'): raise common.Hold('wrong identity')
    def get(self,name): return copy.deepcopy(self.obj)
    def create(self,obj):
        self.creations+=1;self.obj=copy.deepcopy(obj);self.obj['metadata']['uid']='synthetic-uid'
        if self.fail: raise common.Hold('lost acknowledgement')

class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='reader-secret-');self.path=Path(self.tmp.name);os.chmod(self.path,0o700)
        (self.path/'reader.token').write_text('synthetic-reader-token');os.chmod(self.path/'reader.token',0o600);self.transport=Transport()
    def tearDown(self): self.tmp.cleanup()
    def apply(self): return stage.reconcile(self.path,self.transport,'cluster','namespace')
    def test_create_repeat_and_detect_drift(self):
        self.assertEqual(self.apply(),'complete');self.assertEqual(self.apply(),'complete');self.assertEqual(self.transport.creations,1)
        self.transport.obj['metadata']['uid']='changed'
        with self.assertRaises(common.Hold):self.apply()
    def test_lost_ack_holds(self):
        self.transport.fail=True
        with self.assertRaises(common.Hold):self.apply()
        self.transport.fail=False
        with self.assertRaises(common.Hold):self.apply()
        self.assertEqual(self.transport.creations,1)
        self.assertEqual(json.loads((self.path/'reader-secret.json').read_text())['phase'],'pending')
    def test_pending_bootstrap_holds(self):
        (self.path/'reader.pending').write_text('x')
        with self.assertRaises(common.Hold):self.apply()
        self.assertEqual(self.transport.creations,0)
if __name__=='__main__':unittest.main()
