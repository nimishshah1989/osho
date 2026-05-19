#!/usr/bin/env bash
# 01-harden-server.sh
#
# Run ONCE per fresh VPS, as root, immediately after first SSH login.
#
# Usage (from your laptop):
#   scp deploy/iceland/01-harden-server.sh root@<server-ip>:/root/
#   ssh root@<server-ip>
#   # then on the server:
#   chmod +x /root/01-harden-server.sh
#   SSH_PUBKEY="ssh-ed25519 AAAA... osho-iceland" /root/01-harden-server.sh
#
# What it does:
#   - Creates an `osho` sudo user with your SSH key
#   - Disables root SSH login and password auth
#   - Installs and configures ufw (firewall) + fail2ban
#   - Enables unattended-upgrades for security patches
#   - Adds 2 GB swap (helps avoid OOM on small boxes during npm/pip installs)
#   - Sets timezone to UTC, hostname from $HOSTNAME env (default: oshohost)
#
# Idempotent: re-running is safe. Bails early if SSH_PUBKEY isn't set.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root." >&2
  exit 1
fi

: "${SSH_PUBKEY:?Set SSH_PUBKEY env var to your ssh-ed25519 public key string}"
HOSTNAME_NEW="${HOSTNAME_NEW:-oshohost}"

echo "==> Setting hostname to $HOSTNAME_NEW"
hostnamectl set-hostname "$HOSTNAME_NEW"

echo "==> Setting timezone to UTC"
timedatectl set-timezone UTC

echo "==> apt update + upgrade"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

echo "==> Installing baseline packages"
apt-get install -y --no-install-recommends \
  ufw fail2ban unattended-upgrades \
  curl wget git ca-certificates gnupg \
  htop iotop ncdu \
  rsync sqlite3

echo "==> Creating osho user (if missing)"
if ! id osho >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" osho
  usermod -aG sudo osho
fi

echo "==> Allowing osho to sudo without password (for deploy scripts)"
echo "osho ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/osho
chmod 0440 /etc/sudoers.d/osho

echo "==> Installing SSH key for osho"
install -d -m 700 -o osho -g osho /home/osho/.ssh
echo "$SSH_PUBKEY" > /home/osho/.ssh/authorized_keys
chmod 600 /home/osho/.ssh/authorized_keys
chown osho:osho /home/osho/.ssh/authorized_keys

echo "==> Locking down SSH (no root, no password)"
SSHD_CONF=/etc/ssh/sshd_config.d/99-osho-hardening.conf
cat > "$SSHD_CONF" <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 60
ClientAliveCountMax 3
MaxAuthTries 3
EOF
chmod 644 "$SSHD_CONF"
systemctl restart ssh || systemctl restart sshd

echo "==> Configuring ufw firewall (default deny inbound, allow 22/80/443)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Configuring fail2ban (default sshd jail)"
systemctl enable --now fail2ban

echo "==> Configuring unattended-upgrades (security only)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

echo "==> Adding 2 GB swap (if not already present)"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "==> Done."
echo ""
echo "Verify before disconnecting:"
echo "  1. Open a SECOND terminal and try:  ssh -i ~/.ssh/osho_iceland osho@<this-ip>"
echo "  2. Confirm that works."
echo "  3. Try:  ssh root@<this-ip>  — should be REFUSED."
echo "  4. Only then close this root session."
