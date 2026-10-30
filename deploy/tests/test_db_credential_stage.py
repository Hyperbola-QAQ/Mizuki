import copy
import fcntl
import json
import os
import pathlib
import tempfile
import unittest
import importlib.util

path = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'db_credential_stage.py'
spec = importlib.util.spec_from_file_location('db_credential_stage', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeAPI:
    def __init__(self, fail_after_create=False):
        self.data = {}
        self.fail_after_create = fail_after_create
        self.fail_namespace = None
    def get(self, namespace, name):
        return copy.deepcopy(self.data.get((namespace, name)))
    def create(self, obj):
        key = (obj['metadata']['namespace'], obj['metadata']['name'])
        if key in self.data: raise RuntimeError('conflict')
        obj = copy.deepcopy(obj)
        obj['metadata']['uid'] = f'uid-{key[0]}'
        self.data[key] = obj
        if self.fail_after_create or self.fail_namespace == key[0]: raise TimeoutError('unknown remote outcome')

class CredentialStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name)
        os.chmod(self.path, 0o700)
        module.initialize(self.path)
        self.api = FakeAPI()
    def tearDown(self): self.temp.cleanup()

    def test_create_two_consistent_secrets_and_idempotent_verify(self):
        self.assertEqual(module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb')), 'complete')
        a = self.api.get('databases', module.SECRET_NAME)
        b = self.api.get('mizuki', module.SECRET_NAME)
        self.assertEqual(a['data'], b['data'])
        self.assertEqual(module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb')), 'complete')
        self.assertNotIn(a['data']['password'], (self.path / 'journal.json').read_text())

    def test_uncertain_response_holds_after_remote_create(self):
        self.api.fail_after_create = True
        with self.assertRaises(TimeoutError): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(json.loads((self.path / 'journal.json').read_text())['phase'], 'creating_db')
        with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(len(self.api.data), 1)

    def test_second_create_timeout_preserves_both_and_holds(self):
        self.api.fail_namespace = 'mizuki'
        with self.assertRaises(TimeoutError): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(len(self.api.data), 2)
        self.assertEqual(json.loads((self.path / 'journal.json').read_text())['phase'], 'creating_cms')
        with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(len(self.api.data), 2)

    def test_partial_stage_does_not_generate_credentials(self):
        second = pathlib.Path(self.temp.name) / 'partial'
        second.mkdir(mode=0o700)
        (second / 'journal.json').write_text('{}')
        os.chmod(second / 'journal.json', 0o600)
        with self.assertRaises(module.Hold): module.initialize(second)
        self.assertFalse((second / 'credential.json').exists())

    def test_pending_present_can_be_resolved_only_after_attestation(self):
        self.api.fail_after_create = True
        with self.assertRaises(TimeoutError):
            module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        with self.assertRaises(module.Hold):
            module.resolve_present(self.path, self.api.get, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(module.resolve_present(self.path, self.api.get, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'), fencing_attested=True), 'db_verified')
        self.api.fail_after_create = False
        self.assertEqual(module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb')), 'complete')

    def test_pending_missing_or_drift_never_resolves(self):
        self.api.fail_after_create = True
        with self.assertRaises(TimeoutError):
            module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.api.data.clear()
        with self.assertRaises(module.Hold):
            module.resolve_present(self.path, self.api.get, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'), fencing_attested=True)
        self.assertEqual(json.loads((self.path / 'journal.json').read_text())['phase'], 'creating_db')

    def test_second_pending_present_resolves_without_writes(self):
        self.api.fail_namespace = 'mizuki'
        with self.assertRaises(TimeoutError):
            module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertEqual(module.resolve_present(self.path, self.api.get, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'), fencing_attested=True), 'complete')
        self.assertEqual(len(self.api.data), 2)

    def test_conflict_and_uid_drift_never_overwritten(self):
        self.api.data[('mizuki', module.SECRET_NAME)] = {'metadata': {'name': module.SECRET_NAME}}
        with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.assertNotIn(('databases', module.SECRET_NAME), self.api.data)
        self.api.data.clear()
        module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        self.api.data[('mizuki', module.SECRET_NAME)]['metadata']['uid'] = 'changed'
        with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))

    def test_permissions_and_lock_fail_closed(self):
        os.chmod(self.path / 'credential.json', 0o644)
        with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        os.chmod(self.path / 'credential.json', 0o600)
        with open(self.path / '.lock', 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(module.Hold): module.reconcile(self.path, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))

    def test_symlink_ancestor_and_writable_parent_are_refused(self):
        link = self.path / 'alias'
        link.symlink_to(self.path, target_is_directory=True)
        with self.assertRaises((module.Hold, OSError)):
            module.reconcile(link, self.api.get, self.api.create, cluster_uid='12345678-abcd', namespace_uids=('12345678-aaaa','12345678-bbbb'))
        parent = self.path / 'writable'
        parent.mkdir(mode=0o777)
        os.chmod(parent, 0o777)
        child = parent / 'stage'
        child.mkdir(mode=0o700)
        with self.assertRaises(module.Hold): module.initialize(child)
        self.assertFalse((child / 'credential.json').exists())

    def test_reinitialize_is_refused(self):
        before = (self.path / 'credential.json').read_bytes()
        with self.assertRaises(module.Hold): module.initialize(self.path)
        self.assertEqual((self.path / 'credential.json').read_bytes(), before)

if __name__ == '__main__': unittest.main()
