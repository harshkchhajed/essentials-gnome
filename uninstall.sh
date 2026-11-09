#!/bin/bash
# Removes the Essentials extension and its app launcher for the current user.
# Your saved display layouts (~/.config/display-layouts.json) and clipboard
# pins (~/.config/clipboard-history-pins.json) are kept; delete them by hand
# if you want them gone. The power service has its own uninstaller:
#   sudo ./power-service/uninstall.sh
set -euo pipefail

UUID=essentials@harsh
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"

DEST="$DATA/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
# The schema lives inside the extension, so reset settings before deleting it.
gsettings --schemadir "$DEST/schemas" reset-recursively org.gnome.shell.extensions.essentials 2>/dev/null || true
rm -rf "$DEST"
rm -f "$DATA/applications/essentials.desktop"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/essentials"
echo "Essentials removed. Restart GNOME Shell (X11: Alt+F2, r) to unload it."
