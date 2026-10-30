#!/usr/bin/env python3
"""Generate a non-secret, create-only CNPG role patch from a fresh Cluster JSON.

This program never contacts Kubernetes and never reads a password. Its output
is a JSON Patch intended for a server-side dry-run first. Resource identity and
resourceVersion tests cause a stale or wrong-object write to fail closed.
"""
import argparse
import json
import sys

ROLE = {
    "name": "shirone_cms", "ensure": "present", "login": True,
    "superuser": False, "createdb": False, "createrole": False,
    "replication": False, "bypassrls": False,
    "passwordSecret": {"name": "shirone-cms-db"},
}

def make_patch(cluster, expected_uid):
    meta = cluster.get("metadata", {})
    if (cluster.get("apiVersion") != "postgresql.cnpg.io/v1" or
        cluster.get("kind") != "Cluster" or meta.get("namespace") != "databases" or
        meta.get("name") != "postgresql" or meta.get("uid") != expected_uid or
        not meta.get("resourceVersion")):
        raise ValueError("Cluster identity or resourceVersion does not match")
    spec = cluster.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("Cluster spec is invalid")
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": expected_uid},
        {"op": "test", "path": "/metadata/resourceVersion", "value": meta["resourceVersion"]},
    ]
    managed = spec.get("managed")
    if managed is None:
        patch.append({"op": "add", "path": "/spec/managed", "value": {"roles": [ROLE]}})
    elif not isinstance(managed, dict):
        raise ValueError("managed field has an unexpected shape")
    elif managed.get("roles") is None:
        patch.append({"op": "add", "path": "/spec/managed/roles", "value": [ROLE]})
    else:
        roles = managed["roles"]
        if not isinstance(roles, list) or any(not isinstance(role, dict) for role in roles):
            raise ValueError("managed roles have an unexpected shape")
        if any(role.get("name") == ROLE["name"] for role in roles):
            raise ValueError("role already exists; review its identity, do not overwrite it")
        patch.append({"op": "add", "path": "/spec/managed/roles/-", "value": ROLE})
    return patch

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-uid", required=True)
    args = parser.parse_args()
    try:
        result = make_patch(json.load(sys.stdin), args.expected_uid)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    json.dump(result, sys.stdout, separators=(",", ":"))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
