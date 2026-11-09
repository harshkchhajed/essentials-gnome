#!/bin/bash
# Installs the Essentials GNOME Shell extension for the current user.
#   ./install.sh            install / update
#   ./install.sh --super-v  also free Super+V for clipboard history
#                           (GNOME uses it for the notification list;
#                            Super+M keeps doing that)
# No root needed. The optional power service is installed separately:
#   sudo ./power-service/install.sh
set -euo pipefail
cd "$(dirname "$0")"

UUID=essentials@harsh
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

version=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
if [ "${version:-0}" != 42 ]; then
    echo "Warning: Essentials is written for GNOME Shell 42 (Ubuntu 22.04); found '${version:-none}'." >&2
fi

for tool in gjs glib-compile-schemas; do
    command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done

echo "Installing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$UUID"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"

# App launcher: "Essentials" in the app grid opens the settings window.
mkdir -p "$APPS"
sed "s|@ICON@|$DEST/essentials.svg|" data/essentials.desktop.in > "$APPS/essentials.desktop"
update-desktop-database "$APPS" 2>/dev/null || true

if [ "${1:-}" = "--super-v" ]; then
    gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
    echo "Super+V freed for clipboard history (notification list: Super+M)."
fi

# Optional tools used by quick look; missing ones just mean fewer previews.
missing=()
for tool in ffmpeg ffprobe pdfinfo unzip soffice; do
    command -v "$tool" >/dev/null || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
    echo "Optional, for richer previews: ${missing[*]}"
    echo "  sudo apt install ffmpeg poppler-utils unzip libreoffice-core"
fi

cat <<EOF

Done. Now restart GNOME Shell so it sees the extension:
  X11:     press Alt+F2, type r, press Enter
  Wayland: log out and back in
Then enable it:
  gnome-extensions enable $UUID
EOF
