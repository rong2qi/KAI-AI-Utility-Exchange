#!/usr/bin/env bash
set -euo pipefail
root_dir='/opt/kai-hour-key-staging'
deploy_user='kai-hour-key-staging-deploy'
runtime_user='kai-hour-key-staging-runtime'
public_key_file="${1:-}"
[[ "$(id -u)" -eq 0 && -f "$public_key_file" ]] || { echo 'Root and one public key file required' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
# Only a single public key; never allow a second authorized_keys line.
python3 - "$public_key_file" <<'PY'
from pathlib import Path
import sys
lines=Path(sys.argv[1]).read_text().splitlines()
assert len(lines)==1 and lines[0].startswith('ssh-ed25519 ') and len(lines[0].split())>=2
PY
ssh-keygen -lf "$public_key_file" >/dev/null
node_bin="$root_dir/runtime/node/bin/node"
[[ -x "$node_bin" && ! -L "$root_dir" ]] || { echo 'Approved isolated runtime missing or root is a link' >&2; exit 2; }
"$node_bin" -e 'if(![22,24].includes(Number(process.versions.node.split(".")[0])))process.exit(2)'
# New install only; upgrades use reviewed exact files after confirming this marker.
if [[ ! -f "$root_dir/.managed-by-kai-hour-key" ]]; then
  for item in "/etc/systemd/system/kai-hour-key-staging.service" "/etc/sudoers.d/kai-hour-key-staging"; do
    [[ ! -e "$item" ]] || { echo "Conflict: $item" >&2; exit 2; }
  done
  for account in "$deploy_user" "$runtime_user"; do
    ! getent passwd "$account" >/dev/null || { echo "Account conflict: $account" >&2; exit 2; }
  done
  if ss -ltnH | awk '{print $4}' | grep -q ':18971$'; then echo 'Port conflict' >&2; exit 2; fi
  useradd --system --create-home --home-dir "/var/lib/$deploy_user" --shell /bin/sh "$deploy_user"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$runtime_user"
  touch "$root_dir/.managed-by-kai-hour-key"
fi
for account in "$deploy_user" "$runtime_user"; do
  [[ "$(id -Gn "$account")" == "$account" ]] || { echo 'Unexpected account groups' >&2; exit 2; }
done
install -d -o root -g "$runtime_user" -m 0711 "$root_dir"
install -d -o root -g "$runtime_user" -m 0750 "$root_dir/releases" "$root_dir/runtime"
install -d -o root -g root -m 0700 "$root_dir/state" "$root_dir/audit"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$script_dir/kai-hour-key-staging-promote.py" /usr/local/libexec/kai-hour-key-staging-promote
install -o root -g root -m 0755 "$script_dir/kai-hour-key-staging-receiver.py" /usr/local/libexec/kai-hour-key-staging-receiver
install -o root -g root -m 0644 "$script_dir/kai-hour-key-staging.service" /etc/systemd/system/kai-hour-key-staging.service
# The deploy account must not be able to remove its forced-command restrictions.
chown root:root "/var/lib/$deploy_user"
chmod 0755 "/var/lib/$deploy_user"
install -d -o root -g root -m 0755 "/var/lib/$deploy_user/.ssh"
printf 'restrict,command="/usr/local/libexec/kai-hour-key-staging-receiver" %s\n' "$(cat "$public_key_file")" > "/var/lib/$deploy_user/.ssh/authorized_keys"
chown root:root "/var/lib/$deploy_user/.ssh/authorized_keys"
chmod 0644 "/var/lib/$deploy_user/.ssh/authorized_keys"
cat > /etc/sudoers.d/kai-hour-key-staging <<EOF
Defaults:$deploy_user !setenv
$deploy_user ALL=(root) NOPASSWD: /usr/local/libexec/kai-hour-key-staging-promote ""
EOF
chmod 0440 /etc/sudoers.d/kai-hour-key-staging
visudo -cf /etc/sudoers.d/kai-hour-key-staging
systemd-analyze verify /etc/systemd/system/kai-hour-key-staging.service
systemctl daemon-reload
systemctl enable kai-hour-key-staging.service
printf 'provisioned %s\n' "$root_dir"
