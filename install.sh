#!/usr/bin/env bash
# install.sh — installs the MAC Randomiser GNOME extension for the current user

set -euo pipefail

UUID="mac-randomiser@quantumcs.co.uk"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Installing $UUID to $DEST ..."
mkdir -p "$DEST"
cp -r "$(dirname "$0")/$UUID/." "$DEST/"

echo "Done. Enable the extension with:"
echo "  gnome-extensions enable $UUID"
echo ""
echo "Then open its preferences with:"
echo "  gnome-extensions prefs $UUID"
echo ""
echo "Note: you may need to log out and back in first if the extension"
echo "isn't recognised immediately."
