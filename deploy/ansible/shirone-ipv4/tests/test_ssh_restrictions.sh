#!/usr/bin/env bash
# Test on an authorized Linux test host. Creates a temporary system account
# and loopback-only sshd; it never edits the host's primary sshd configuration.
set -Eeuo pipefail
[[ ${SHIRONE_SSH_TEST_CONFIRM:-} == isolated ]] || { echo 'set SHIRONE_SSH_TEST_CONFIRM=isolated' >&2; exit 1; }
w=$(mktemp -d /tmp/shirone-ssh-test.XXXXXX)
account=sh-test-$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')
created=false
cleanup() {
  r=$?
  for s in "$w/control" "$w/local-control"; do
    [[ ! -S $s ]] || ssh -n -S "$s" -O exit 127.0.0.1 >/dev/null 2>&1 || true
  done
  [[ ! -f $w/pid ]] || sudo -n kill "$(cat "$w/pid")" 2>/dev/null || true
  [[ $created != true ]] || sudo -n /usr/sbin/userdel "$account" 2>/dev/null || true
  find "$w" -depth -delete
  exit "$r"
}
trap cleanup EXIT
chmod 755 "$w"
! getent passwd "$account" >/dev/null
sudo -n /usr/sbin/useradd --system --no-create-home --shell /usr/sbin/nologin "$account"
created=true
ssh-keygen -q -t ed25519 -N '' -f "$w/host"
ssh-keygen -q -t ed25519 -N '' -f "$w/client"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:25443" ' > "$w/keys"
cat "$w/client.pub" >> "$w/keys"
chmod 644 "$w/keys"
printf '[127.0.0.1]:22291 ' > "$w/known"
cat "$w/host.pub" >> "$w/known"
cat > "$w/config" <<EOF
ListenAddress 127.0.0.1
Port 22291
HostKey $w/host
PidFile $w/pid
AuthorizedKeysFile $w/keys
StrictModes no
UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers $account
GatewayPorts no
Match User $account
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:25443
    ForceCommand /bin/false
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
EOF
sudo -n /usr/sbin/sshd -t -f "$w/config"
sudo -n /usr/sbin/sshd -f "$w/config" -E "$w/log"
args=(-n -p 22291 -i "$w/client" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$w/known" -o GlobalKnownHostsFile=/dev/null -o ExitOnForwardFailure=yes -o ConnectTimeout=3)
ssh "${args[@]}" -M -S "$w/control" -fN -R 127.0.0.1:25443:127.0.0.1:30181 "$account"@127.0.0.1
if ssh "${args[@]}" -fN -R 127.0.0.1:25442:127.0.0.1:30181 "$account"@127.0.0.1 2>/dev/null; then echo 'unexpected reverse forwarding' >&2; exit 1; fi
if ssh "${args[@]}" "$account"@127.0.0.1 'echo unauthorized' 2>/dev/null; then echo 'unexpected shell access' >&2; exit 1; fi
ssh "${args[@]}" -M -S "$w/local-control" -fN -L 127.0.0.1:25442:127.0.0.1:22291 "$account"@127.0.0.1
python3 - <<'PY'
import socket
sock = socket.create_connection(('127.0.0.1', 25442), timeout=3)
sock.settimeout(3)
try:
    data = sock.recv(32)
except ConnectionResetError:
    data = b''
assert not data.startswith(b'SSH-'), 'local forwarding unexpectedly succeeded'
sock.close()
PY
echo 'PASS: only approved remote forwarding works; shell and local forwarding are denied'
