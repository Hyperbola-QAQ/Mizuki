#!/usr/bin/env python3
"""Manage only the reviewed Strapi A record; credentials remain in memory."""
import base64
import http.client
import json
import re
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST = "strapi.hyperbola.cc"
ZONE = "hyperbola.cc"
ADDRESS = "175.178.150.147"
API = "https://api.cloudflare.com/client/v4/"


def check_ipv4(host, path):
    conn = http.client.HTTPSConnection(host, timeout=12, context=ssl.create_default_context())
    conn._create_connection = lambda _address, timeout, source_address=None: socket.create_connection(
        (ADDRESS, 443), timeout, source_address
    )
    try:
        conn.request("GET", path, headers={"Host": host})
        response = conn.getresponse()
        return response.status, response.read(524288)
    finally:
        conn.close()


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"preview", "create", "delete"}:
        raise ValueError("invalid mode")
    mode, record_id = sys.argv[1:]
    if mode == "delete":
        if not re.fullmatch(r"[a-f0-9]{32}", record_id):
            raise ValueError("delete requires a verified record ID")
    elif record_id:
        raise ValueError("record ID is only accepted for deletion")
    secret = json.loads(subprocess.run(
        ["kubectl", "-n", "cert-manager", "get", "secret", "cloudflare-api-token", "-o", "json"],
        capture_output=True, check=True, timeout=15,
    ).stdout)
    token = base64.b64decode(secret["data"]["api-token"], validate=True).decode("utf-8").strip()
    if not token:
        raise ValueError("Cloudflare token missing")

    def api(route, method="GET", body=None):
        request = urllib.request.Request(
            API + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Cloudflare API returned HTTP {error.code}") from None
        if result.get("success") is not True:
            raise RuntimeError("Cloudflare API rejected the operation")
        return result

    zones = api("zones?" + urllib.parse.urlencode({"name": ZONE, "status": "active"}))["result"]
    if len(zones) != 1 or zones[0].get("name") != ZONE:
        raise ValueError("zone identity mismatch")
    zone = zones[0]["id"]
    if not re.fullmatch(r"[a-f0-9]{32}", zone):
        raise ValueError("invalid zone ID")
    # Per-page bound prevents making a write if unexpected pagination occurs.
    def list_records():
        response = api(f"zones/{zone}/dns_records?" + urllib.parse.urlencode({"name": HOST, "per_page": 100}))
        if response.get("result_info", {}).get("total_pages", 1) > 1:
            raise ValueError("unexpected DNS pagination")
        found = response["result"]
        if any(r.get("name") != HOST for r in found):
            raise ValueError("unexpected record returned")
        return found

    records = list_records()
    a_records = [r for r in records if r.get("type") == "A"]
    if mode == "preview":
        print(json.dumps({"mode": mode, "a_records": [{k: r.get(k) for k in ("id", "content", "proxied", "ttl")} for r in a_records],
                          "aaaa_count": sum(r.get("type") == "AAAA" for r in records)}))
        return
    if mode == "create":
        if a_records or any(r.get("type") == "CNAME" for r in records):
            raise ValueError("existing A or CNAME; inspect rather than overwrite")
        site_status, site_html = check_ipv4(ZONE, "/")
        admin_status, admin_html = check_ipv4(HOST, "/admin")
        if site_status != 200 or b">Hyperbola</h1>" not in site_html or admin_status != 200 or b"<title>Strapi Admin</title>" not in admin_html:
            raise ValueError("IPv4 HTTPS route preflight failed")
        result = api(f"zones/{zone}/dns_records", "POST", {"type": "A", "name": HOST, "content": ADDRESS,
                     "ttl": 1, "proxied": False, "comment": "shirone-strapi IPv4 ingress"})["result"]
        new_id = result.get("id", "")
        expected = {"type": "A", "name": HOST, "content": ADDRESS, "proxied": False,
                    "comment": "shirone-strapi IPv4 ingress"}
        if not re.fullmatch(r"[a-f0-9]{32}", new_id):
            raise ValueError("created record differs; inspect manually")
        if any(result.get(k) != v for k, v in expected.items()):
            raise ValueError(f"created record differs; inspect created ID {new_id}")
        try:
            confirmed = api(f"zones/{zone}/dns_records/{new_id}")["result"]
            if confirmed.get("id") != new_id or any(confirmed.get(k) != v for k, v in expected.items()):
                raise ValueError("created record not confirmed")
            current_a = [r for r in list_records() if r.get("type") == "A"]
            if len(current_a) != 1 or current_a[0].get("id") != new_id:
                raise ValueError("concurrent or duplicate A records detected")
        except Exception:
            raise ValueError(f"created record verification uncertain; inspect created ID {new_id}") from None
        print(json.dumps({"mode": mode, "record_id": new_id, "content": ADDRESS}))
        return
    matches = [r for r in a_records if r.get("id") == record_id]
    if len(matches) != 1 or any(matches[0].get(k) != v for k, v in {"type": "A", "name": HOST, "content": ADDRESS, "proxied": False, "comment": "shirone-strapi IPv4 ingress"}.items()):
        raise ValueError("record ID, value or ownership marker differs; refusing deletion")
    result = api(f"zones/{zone}/dns_records/{record_id}", "DELETE")["result"]
    if result.get("id") != record_id:
        raise ValueError("delete receipt mismatch; inspect manually")
    if any(r.get("id") == record_id for r in list_records()):
        raise ValueError("deleted record still present; inspect manually")
    print(json.dumps({"mode": mode, "deleted_record_id": record_id}))


try:
    main()
except Exception as error:
    print(json.dumps({"error": str(error)}), file=sys.stderr)
    sys.exit(1)
