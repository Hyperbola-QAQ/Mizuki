import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import db_credential_stage as common
import runtime_secret_stage as stage

class Transport:
    def __init__(self): self.objects={}; self.fail=False; self.counter=0
    def verify(self, cluster, namespace):
        if (cluster,namespace)!=('cluster','namespace'): raise common.Hold('identity')
    def get(self, name): return copy.deepcopy(self.objects.get(name))
    def create(self, obj):
        self.counter+=1
        value=copy.deepcopy(obj)
        value['metadata']['uid']=f'uid-{self.counter}'
        self.objects[value['metadata']['name']]=value
        if self.fail: raise common.Hold('lost acknowledgement')

class RuntimeStageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='runtime-stage-')
        self.path=Path(self.temp.name)
        os.chmod(self.path,0o700)
        self.transport=Transport()
    def tearDown(self): self.temp.cleanup()
    def run_stage(self): return stage.reconcile(self.path,self.transport,'cluster','namespace')
    def test_create_and_idempotent_verify(self):
        stage.initialize(self.path)
        stage.initialize(self.path)
        self.assertEqual(self.run_stage(),'complete')
        self.assertEqual(self.run_stage(),'complete')
        self.assertEqual(self.transport.counter,4)
        data=json.loads((self.path/'runtime.json').read_text())
        self.assertEqual(data['objects'][stage.NAMES[1]]['MEILI_SEARCH_KEY'],data['objects'][stage.NAMES[3]]['MEILI_SEARCH_KEY'])
        self.assertEqual(data['objects'][stage.NAMES[1]]['MEILI_WRITER_KEY'],data['objects'][stage.NAMES[2]]['MEILI_ADMIN_KEY'])
        self.transport.objects[stage.NAMES[0]]['metadata']['uid']='different'
        with self.assertRaises(common.Hold): self.run_stage()
    def test_uncertain_create_is_never_retried(self):
        stage.initialize(self.path)
        self.transport.fail=True
        with self.assertRaises(common.Hold): self.run_stage()
        self.transport.fail=False
        with self.assertRaises(common.Hold): self.run_stage()
        self.assertEqual(self.transport.counter,1)
        self.assertEqual(json.loads((self.path/'journal.json').read_text())['pending'],stage.NAMES[0])
    def test_partial_initialization_is_not_regenerated(self):
        (self.path/'runtime.json').write_text('{}')
        os.chmod(self.path/'runtime.json',0o600)
        with self.assertRaises(common.Hold): stage.initialize(self.path)
        self.assertFalse((self.path/'journal.json').exists())
    def test_existing_unrecorded_secret_is_not_adopted(self):
        stage.initialize(self.path)
        self.transport.objects[stage.NAMES[0]]={'metadata':{'name':stage.NAMES[0]}}
        with self.assertRaises(common.Hold): self.run_stage()
        self.assertEqual(self.transport.counter,0)

if __name__=='__main__': unittest.main()
