#!/bin/bash
# Installs the usbc-power-cap system service (needs root):
#   sudo ./power-service/install.sh
#
# What it does: adapts the CPU power limit when running on a weak (e.g. 65 W
# USB-C) charger so the charger doesn't keep cutting out, restores factory
# limits on a full-power charger, and gives the Essentials power monitor
# access to CPU energy, fan speeds and the 80% charge limit.
#
# It is written for the Lenovo Legion Pro 5 (16IRX9): it reads that laptop's
# embedded controller. On other laptops read power-service/usbc-power-cap
# first; the extension works without this service (CPU watts, fan speeds and
# the charge-limit switch just won't be available).
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" != 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
fi

install -m 755 usbc-power-cap /usr/local/bin/usbc-power-cap
install -m 644 usbc-power-cap.service /etc/systemd/system/usbc-power-cap.service
systemctl daemon-reload
systemctl enable usbc-power-cap.service
systemctl restart usbc-power-cap.service
sleep 3
systemctl is-active usbc-power-cap.service
journalctl -t usbc-power-cap -n 3 --no-pager -o cat
