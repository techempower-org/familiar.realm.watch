#!/bin/bash
# Rename 10.0.6.115 from jp-Latitude-7390 → familiar.
# Run this LOCALLY on katana; it SSHes into 10.0.6.115.
# Requires passwordless sudo on 10.0.6.115 (JP's setup).
set -euo pipefail

TARGET="10.0.6.115"
NEW_HOSTNAME="familiar"

echo ">>> Current hostname on ${TARGET}:"
ssh "${TARGET}" hostname

echo ">>> Setting hostname to '${NEW_HOSTNAME}'..."
ssh "${TARGET}" "sudo hostnamectl set-hostname ${NEW_HOSTNAME}"

echo ">>> Updating /etc/hosts on ${TARGET}..."
ssh "${TARGET}" "sudo sed -i 's/jp-Latitude-7390/${NEW_HOSTNAME}/g' /etc/hosts"

echo ">>> Verifying..."
ssh "${TARGET}" "hostname && hostname -f && cat /etc/hostname"

echo ""
echo ">>> Hostname renamed. Reboot required for all systems to pick up."
echo ">>> Run: ssh ${TARGET} sudo reboot"
echo ">>> Then update your /etc/hosts on katana to alias 'familiar → 10.0.6.115' if OpenWrt DNS isn't updated."
