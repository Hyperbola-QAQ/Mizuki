#!/usr/bin/env python3
"""Create-only Secret transport for db_credential_stage; no secret is logged.

By default this tool only accepts test namespace pairs. Production names require
an explicit flag. Initialize a durable private stage separately and retain it
until recovery/rotation has been independently verified. This tool never
creates namespaces, modifies existing Secrets or retries uncertain writes.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
import db_credential_stage as stage

HOST = 'imini'
KUBECONFIG = '/home/hyperbola/.kube/config'
KUBECTL = ('kubectl', '--request-timeout=15s', '--kubeconfig=' + KUBECONFIG)

class Transport:
    def __init__(self, cluster_uid, namespaces, namespace_uids):
        self.cluster_uid = cluster_uid
        self.namespaces = stage._namespaces(namespaces)
        if len(namespace_uids) != 2: raise stage.Hold('two namespace UIDs required')
        self.namespace_uids = dict(zip(self.namespaces, namespace_uids))
        actual = self._run((*KUBECTL, '-n', 'databases', 'get', 'clusters.postgresql.cnpg.io',
                            'postgresql', '-o', 'jsonpath={.metadata.uid}'))
        if actual.decode().strip() != cluster_uid:
            raise stage.Hold('cluster UID does not match')

    @staticmethod
    def _run(argv, data=None):
        command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', HOST, shlex.join(argv)]
        try:
            result = subprocess.run(command, input=data, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise stage.Hold('Kubernetes transport failed or timed out; outcome may be unknown') from exc
        if result.returncode != 0:
            # Do not expose response bodies, credentials, or stderr to logs.
            raise stage.Hold('Kubernetes request failed; outcome may be unknown')
        return result.stdout

    def verify_namespace(self, namespace):
        if namespace not in self.namespace_uids:
            raise stage.Hold('unexpected namespace')
        actual = self._run((*KUBECTL, 'get', 'namespace', namespace, '-o', 'jsonpath={.metadata.uid}'))
        if actual.decode().strip() != self.namespace_uids[namespace]:
            raise stage.Hold('namespace UID does not match')

    def get(self, namespace, name):
        if namespace not in self.namespaces or name != stage.SECRET_NAME:
            raise stage.Hold('unexpected Secret identity')
        self.verify_namespace(namespace)
        output = self._run((*KUBECTL, '-n', namespace, 'get', 'secret', name,
                            '--ignore-not-found', '-o', 'json'))
        if not output.strip():
            return None
        try:
            return json.loads(output)
        except (ValueError, UnicodeError) as exc:
            raise stage.Hold('Secret response was invalid') from exc

    def create(self, secret):
        namespace = secret.get('metadata', {}).get('namespace')
        if namespace not in self.namespaces or secret.get('metadata', {}).get('name') != stage.SECRET_NAME:
            raise stage.Hold('unexpected Secret identity')
        self.verify_namespace(namespace)
        # Body is passed on stdin; -o name prevents credentials entering stdout.
        self._run((*KUBECTL, '-n', namespace, 'create', '-f', '-', '-o', 'name'),
                  json.dumps(secret, separators=(',', ':')).encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('init', 'apply'))
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--cluster-uid')
    parser.add_argument('--db-namespace', default='databases')
    parser.add_argument('--cms-namespace', default='mizuki')
    parser.add_argument('--db-namespace-uid')
    parser.add_argument('--cms-namespace-uid')
    parser.add_argument('--allow-production', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'init':
            stage.initialize(args.stage)
            print('Private credential stage initialized; no Kubernetes resources were changed.')
            return 0
        namespaces = stage._namespaces((args.db_namespace, args.cms_namespace))
        if namespaces == stage.NAMESPACES and not args.allow_production:
            raise stage.Hold('production namespaces require the explicit allow-production flag')
        if not args.cluster_uid:
            raise stage.Hold('reviewed cluster UID is required')
        namespace_uids = (args.db_namespace_uid, args.cms_namespace_uid)
        if any(not uid for uid in namespace_uids):
            raise stage.Hold('both reviewed namespace UIDs are required')
        transport = Transport(args.cluster_uid, namespaces, namespace_uids)
        result = stage.reconcile(args.stage, transport.get, transport.create,
                                 cluster_uid=args.cluster_uid, namespace_uids=namespace_uids, namespaces=namespaces)
        print('Credential stage:', result)
        return 0
    except (stage.Hold, OSError, ValueError):
        # Do not print exception details, raw subprocess output or secret bodies.
        print('Credential transaction held; inspect its protected state before any recovery.', file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
