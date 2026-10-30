#!/usr/bin/env python3
"""Controller-only transport; stdin carries Secret data, never argv or logs."""
import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
import db_credential_stage as common
import runtime_secret_stage as stage
import runtime_secret_replicate as recovery

KUBECTL = ('kubectl', '--request-timeout=15s', '--kubeconfig=/home/hyperbola/.kube/config')

class Transport:
    def __init__(self, namespace='mizuki'):
        if namespace != 'mizuki' and not __import__('re').fullmatch(r'shirone-runtime-test-[a-f0-9]{16}', namespace): raise common.Hold('invalid namespace')
        self.namespace = namespace
        self.identity = None
    @staticmethod
    def run(argv, data=None):
        try:
            result = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','imini',shlex.join(argv)], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise common.Hold('transport outcome uncertain') from exc
        if result.returncode: raise common.Hold('transport outcome uncertain')
        return result.stdout
    def verify(self, cluster_uid, namespace_uid):
        actual = self.run((*KUBECTL, 'get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}')).decode().strip()
        namespace = self.run((*KUBECTL, 'get', 'namespace', self.namespace, '-o', 'jsonpath={.metadata.uid}')).decode().strip()
        if actual != cluster_uid or namespace != namespace_uid: raise common.Hold('identity mismatch')
        self.identity = (cluster_uid, namespace_uid)
    def get(self, name):
        if name not in stage.NAMES: raise common.Hold('invalid name')
        if not self.identity: raise common.Hold('unverified identity')
        self.verify(*self.identity)
        result = self.run((*KUBECTL, '-n', self.namespace, 'get', 'secret', name, '--ignore-not-found', '-o', 'json'))
        return json.loads(result) if result.strip() else None
    def create(self, obj):
        if obj.get('metadata', {}).get('name') not in stage.NAMES or obj.get('metadata', {}).get('namespace') != self.namespace: raise common.Hold('invalid name')
        if not self.identity: raise common.Hold('unverified identity')
        self.verify(*self.identity)
        self.run((*KUBECTL, '-n', self.namespace, 'create', '-f', '-', '-o', 'name'), json.dumps(obj, separators=(',', ':')).encode())

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=('init','apply'))
    parser.add_argument('--stage',required=True,type=Path)
    parser.add_argument('--cluster-uid')
    parser.add_argument('--namespace-uid')
    parser.add_argument('--allow-production',action='store_true')
    args=parser.parse_args()
    try:
        if args.action=='init':
            stage.initialize(args.stage)
            print('Private runtime stage initialized; no Kubernetes resources changed.')
            return 0
        if not args.allow_production or not args.cluster_uid or not args.namespace_uid:
            raise common.Hold('explicit production identity required')
        recovery.replicate(args.stage)
        result=stage.reconcile(args.stage,Transport(),args.cluster_uid,args.namespace_uid)
        print('Runtime credential transaction:',result)
        return 0
    except (common.Hold, OSError, ValueError, KeyError, BlockingIOError, subprocess.TimeoutExpired):
        print('Runtime credential transaction held; preserve the stage and review its journal.',file=sys.stderr)
        return 1

if __name__=='__main__': raise SystemExit(main())
