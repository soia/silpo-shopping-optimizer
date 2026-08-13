#!/usr/bin/env bash
#
# Prepares a fresh Ubuntu box for the compose stack: Docker, swap, firewall.
# Safe to re-run - every step checks whether it already happened.
#
#   curl -fsSL https://get.docker.com | sh   # is what this wraps, plus the rest
#
# Run as a user with sudo, from this directory:  ./bootstrap.sh

set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# --- Docker ------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  log "Docker already installed - skipping"
else
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group. Log out and back in, or run: newgrp docker"
fi

# --- Swap --------------------------------------------------------------------
# On a 1 GB box this is what keeps n8n from being OOM-killed mid-execution. It
# is not a performance tweak; without it the container dies under load.
if sudo swapon --show | grep -q '/swapfile'; then
  log "Swap already configured - skipping"
else
  log "Creating a 2 GB swap file"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Default of 60 swaps too eagerly for a server; 10 keeps swap as a safety net
  # rather than a routine path.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null
  sudo sysctl -q vm.swappiness=10
fi

# --- Firewall ----------------------------------------------------------------
# Oracle images ship iptables rules that drop 80/443 even when the cloud-side
# security list allows them. This is the single most common reason a fresh
# Oracle box appears unreachable while everything looks correctly configured.
if command -v iptables >/dev/null 2>&1 && sudo iptables -L INPUT -n | grep -q 'REJECT'; then
  log "Opening ports 80 and 443 in the host firewall"
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save
  else
    sudo apt-get update -qq && sudo apt-get install -y -qq iptables-persistent
  fi
else
  log "No REJECT rules found in INPUT - leaving the firewall alone"
fi

log "Done"
cat <<'EOF'

Next:
  1. cp .env.example .env  &&  edit it
       openssl rand -hex 32     # for TOKEN_ENCRYPTION_KEY
       openssl rand -hex 32     # again, a different value, for N8N_ENCRYPTION_KEY
  2. Point DOMAIN at this server's public IP (DuckDNS, or your own DNS).
     Confirm before continuing - Caddy cannot get a certificate otherwise:
       dig +short <your-domain>
  3. docker compose up -d
  4. docker compose logs -f caddy      # watch the certificate being issued

Remember the cloud-side rules too: on Oracle, the subnet's Security List (or NSG)
must allow ingress on 80 and 443. The host firewall above is only half of it.
EOF
