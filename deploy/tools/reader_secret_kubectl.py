#!/usr/bin/env python3
import argparse,json,subprocess,sys
from pathlib import Path
import db_credential_stage as common
import bootstrap_replicate as bootstrap
import reader_secret_stage as stage
from runtime_secret_kubectl import Transport,KUBECTL

class ReaderTransport(Transport):
    def get(self,name):
        if name!=stage.NAME or not self.identity: raise common.Hold('invalid reader Secret')
        self.verify(*self.identity)
        result=self.run((*KUBECTL,'-n',self.namespace,'get','secret',name,'--ignore-not-found','-o','json'))
        return json.loads(result) if result.strip() else None
    def create(self,obj):
        if obj.get('metadata',{}).get('name')!=stage.NAME or obj.get('metadata',{}).get('namespace')!=self.namespace or not self.identity: raise common.Hold('invalid reader Secret')
        self.verify(*self.identity)
        self.run((*KUBECTL,'-n',self.namespace,'create','-f','-','-o','name'),json.dumps(obj,separators=(',',':')).encode())

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--stage',required=True,type=Path);parser.add_argument('--cluster-uid',required=True);parser.add_argument('--namespace-uid',required=True);parser.add_argument('--allow-production',action='store_true');args=parser.parse_args()
    try:
        if not args.allow_production: raise common.Hold('explicit production required')
        bootstrap.replicate(args.stage)
        result=stage.reconcile(args.stage,ReaderTransport(),args.cluster_uid,args.namespace_uid)
        print('Reader credential transaction:',result)
        return 0
    except (common.Hold,OSError,ValueError,KeyError,subprocess.TimeoutExpired,BlockingIOError):
        print('Reader credential transaction held; preserve state and review the journal.',file=sys.stderr);return 1
if __name__=='__main__': raise SystemExit(main())
