#!/bin/bash
# Removes the usbc-power-cap service; stopping it restores the factory CPU
# power limits.   sudo ./power-service/uninstall.sh
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
fi

systemctl disable --now usbc-power-cap.service 2>/dev/null || true
rm -f /etc/systemd/system/usbc-power-cap.service /usr/local/bin/usbc-power-cap
systemctl daemon-reload
echo "usbc-power-cap removed; CPU limits are back to factory defaults."
