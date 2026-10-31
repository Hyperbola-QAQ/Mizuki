# Shirone IPv4 entrypoint proposal — read-only preflight only

This directory is a proposal, not a deployment. `preview.yml` reads the candidate
entrypoint and refuses the wrong host, occupied ports, missing nginx or missing
Traefik CRDs. It never changes hosts, Kubernetes objects or DNS. Specify the
actual authorized host explicitly; a successful preflight is not authorization
to deploy and is not evidence that the connection works.

Proposed chain: Cloudflare A record → existing txy Traefik → a dedicated,
per-host exact-match route with the existing WAF → authenticated TLS relay on
txy → SSH reverse tunnel bound to 127.0.0.1:25443 → family Higress VIP
192.168.86.100:30181 → existing HTTPS routes. The new route must be separately
named and only take precedence over legacy ingress for hyperbola.cc,
www.hyperbola.cc, blog.hyperbola.cc and strapi.hyperbola.cc. Rollback removes
only newly owned objects and restores priority; it must never edit or delete
legacy-nginx's shared routes or unrelated DNS records.

Mandatory design gates before implementing or applying:

1. Create a dedicated SSH key pair on a private, persistent host, pin txy's
   independently verified host key, and restrict the server-side key to the
   single loopback reverse listener (no shell, command execution, agent, PTY or
   additional forwarding). Provision/revoke it through Ansible without printing
   or committing keys. Confirm OpenSSH authorized_keys option semantics using
   isolated tests, including denial of other target ports and commands.
2. Run the reverse connection with a managed user service and bounded restart
   backoff. Test connection drop and restart. An automatic failover between
   imini and laiku needs an explicit single-writer lease/fence: neither node may
   remove or seize another connection's listener. The initial proposal has a
   single entrypoint and must not be represented as HA.
3. Do not use a plain socat relay or an unauthenticated host-network port. It
   would let other Pods bypass Traefik and access unrelated Higress routes.
   The relay must require a client certificate from an isolated CA, bind only
   the required interface, accept only the four exact hostnames, and reject
   inconsistent TLS SNI, HTTP Host and forwarded host. Proxy to the reverse
   tunnel with TLS verification enabled and the exact original hostname as
   upstream SNI. Ensure request headers cannot override the host allowlist.
   Treat the CA, client key and relay key as protected credentials. A real
   independent security review and isolated negative tests are still required;
   do not infer safety from this description.
4. Use separate Traefik ServersTransport and independently owned route/service
   objects; verify backend certificate chain, name, mTLS and WAF behaviour, and
   ensure legacy shared ingress retains its UID/spec. Confirm exact route
   precedence through staging and verify unknown/other hostnames cannot reach
   the relay. Check cert rotation and expiration, both gateway replicas, logs
   without secrets, and safe handling of websocket/large-upload connections.
5. Confirm where the k3s AddOn manifests are actually managed: the old
   `legacy-nginx` source was on the now NotReady `hyqaq-server`, and is absent
   on txy. Define an authoritative, durable owner for all new objects; do not
   patch the legacy AddOn. Confirm Cloudflare's authorized DNS management
   interface and restore existing record settings on rollback. DNS is outside
   this preflight and must not be modified until the complete route is tested.
6. Verify IPv4-only HTTPS for site and admin, file upload and draft isolation;
   compare user-facing content to IPv6; stop the tunnel to demonstrate a
   bounded failure and recovery; test explicit rollback with no impact to other
   domains. Current public admin media preview limitations remain separate.

Evidence on 2026-10-31: the legacy txy endpoint points to 10.0.0.10:30080,
which is unreachable; from imini the Higress VIP HTTPS endpoint served the
blog with valid certificate/SNI. An admin request through an ephemeral local
SSH port forward timed out once, while later direct gateway/admin checks passed;
reliability therefore remains unproven. The existing site's A record points to
txy; strapi currently has only an AAAA record. Administrator media preview was
subsequently implemented and verified against the actual public HTTPS route.
No DNS or production routing changes have been made by this proposal.

## Isolated validation and remaining work

`relay-nginx.conf.j2` is a candidate, not a deployed service. Run
`python3 tests/test_relay.py` with Docker, Jinja2, OpenSSL and curl to test it in
a disposable nginx container. Four approved hosts passed; mismatched HTTP Host,
unknown SNI, missing or forged mTLS credentials, an untrusted upstream CA and a
forged forwarded Host were rejected or overwritten. The template verifies the
origin certificate against the incoming SNI and overwrites forwarded host/proto.
The test uses synthetic short-lived credentials and removes its container/files.
It does not cover the deployed Traefik or user browser.

`sshd_config.j2` and `shirone-tunnel-sshd.service.j2` describe a *separate*
listener and do not modify the primary sshd. The opt-in
`SHIRONE_SSH_TEST_CONFIRM=isolated bash tests/test_ssh_restrictions.sh` creates
a temporary nologin account and loopback-only test daemon on an authorized test
host, requiring passwordless sudo and free ports 22291, 25442 and 25443. On
txy, this confirmed the allowed reverse port succeeds while another reverse
port, local forwarding and shell access fail; cleanup removed the account and
daemon. It does not provision the production listener or open its firewall.
`permitopen="none"` and port zero were rejected by the tested authorized-key
parser, so restricting local forwarding via `Match User` is essential.

The Cloudflare DNS entrypoint prepared separately defaults to read-only preview;
it may create an A record only after validating public HTTPS and the expected
site content, and removes only an explicitly owned, matching record ID and
value. No DNS mutation has been performed.

Before deployment, create reviewed Ansible tasks for the account, independent
sshd service, tunnel service, relay and Traefik resources; establish scoped
credentials and trusted host keys without disclosing them; prove the account's
PAM setup, firewall, mTLS/host denials, websocket and upload paths, route
priority, DNS ownership, failover, rollback and unrelated-domain invariants on
the real chain. All configuration here remains a proposal, not an Ansible
production entrypoint.

Traefik preflight on txy: the k3s Traefik DaemonSet has the Kubernetes CRD
provider enabled but does not explicitly enable cross-namespace references.
The existing legacy Ingress references `waf-system-waf-auth@kubernetescrd`;
do not assume a new cross-namespace IngressRoute middleware reference will work.
The installed ServersTransport CRD supports `serverName`,
`certificatesSecrets` and `rootCAsSecrets` (the latter is deprecated in favor of
`rootCAs`). Future route work must choose and test a namespace/ownership model,
retain the exact existing WAF behavior, give each upstream hostname its own
verified TLS serverName, and prove route priority and rollback against the
existing shared Ingress. No candidate route or production resource was created.
