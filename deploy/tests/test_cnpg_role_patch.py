import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'cnpg-role-patch.py'
spec = importlib.util.spec_from_file_location('cnpg_role_patch', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RolePatchTests(unittest.TestCase):
    def cluster(self, managed=None):
        spec = {} if managed is None else {'managed': managed}
        return {'apiVersion': 'postgresql.cnpg.io/v1', 'kind': 'Cluster',
                'metadata': {'name': 'postgresql', 'namespace': 'databases', 'uid': 'u', 'resourceVersion': '7'}, 'spec': spec}

    def test_new_managed_preserves_identity_guards(self):
        patch = module.make_patch(self.cluster(), 'u')
        self.assertEqual([p['op'] for p in patch], ['test', 'test', 'add'])
        self.assertEqual(patch[2]['path'], '/spec/managed')
        self.assertEqual(patch[2]['value']['roles'][0]['name'], 'shirone_cms')

    def test_existing_roles_append_without_replacing(self):
        patch = module.make_patch(self.cluster({'roles': [{'name': 'other'}]}), 'u')
        self.assertEqual(patch[2]['path'], '/spec/managed/roles/-')
        self.assertEqual(patch[2]['value']['passwordSecret']['name'], 'shirone-cms-db')

    def test_existing_role_or_bad_identity_refused(self):
        with self.assertRaises(ValueError): module.make_patch(self.cluster({'roles': [{'name': 'shirone_cms'}]}), 'u')
        with self.assertRaises(ValueError): module.make_patch(self.cluster(), 'wrong')
        with self.assertRaises(ValueError): module.make_patch(self.cluster({'roles': 'bad'}), 'u')

if __name__ == '__main__': unittest.main()
