import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ---------------------------------------------------------------------------
// Helpers — run nmcli synchronously and return stdout as a string
// ---------------------------------------------------------------------------

function runCommand(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, stdout] = proc.communicate_utf8(null, null);
        proc.wait(null);
        return stdout ? stdout.trim() : '';
    } catch (_e) {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/**
 * Returns an array of interface objects:
 *   { name: string, permMac: string }
 * Covers all interfaces known to NetworkManager (wifi, ethernet, etc.)
 */
function getInterfaces() {
    // nmcli -t -f DEVICE,PERM-HW-ADDRESS device show
    const raw = runCommand(['nmcli', '-t', '-f', 'GENERAL.DEVICE,GENERAL.HWADDR,CAPABILITIES.SPEED', 'device', 'show']);
    if (!raw) return [];

    const interfaces = [];
    let current = {};

    for (const line of raw.split('\n')) {
        const [key, ...rest] = line.split(':');
        const value = rest.join(':').trim(); // re-join in case MAC has colons

        if (key === 'GENERAL.DEVICE') {
            current = { name: value, permMac: null };
        } else if (key === 'GENERAL.HWADDR') {
            current.permMac = value || _('Unknown');
            interfaces.push(current);
        }
    }

    return interfaces.filter(i => i.name && i.name !== 'lo');
}

/**
 * Returns an array of connection objects for a given interface:
 *   { uuid: string, name: string, randomise: boolean|null }
 *
 * randomise is:
 *   true  → wifi.cloned-mac-address = random  OR  802-3-ethernet.cloned-mac-address = random
 *   false → set to something else (permanent, preserve, default, or a specific MAC)
 *   null  → key not present (falls back to NetworkManager global default)
 */
function getConnectionsForDevice(ifaceName) {
    // List connections associated with this device
    const raw = runCommand(['nmcli', '-t', '-f', 'UUID,NAME,DEVICE', 'connection', 'show']);
    if (!raw) return [];

    const conns = [];
    for (const line of raw.split('\n')) {
        const parts = line.split(':');
        if (parts.length < 3) continue;
        const [uuid, name, device] = parts;
        // Include connections associated with this device OR unassigned (device == '--')
        if (device === ifaceName || device === '--') {
            const randomise = getRandomiseSetting(uuid);
            conns.push({ uuid, name, randomise });
        }
    }
    return conns;
}

/**
 * Reads the cloned-mac-address field for a connection and interprets it.
 * Returns: true (random), false (not random), or null (not set / using global default).
 */
function getRandomiseSetting(uuid) {
    // Try wifi first, then ethernet
    for (const field of ['wifi.cloned-mac-address', '802-3-ethernet.cloned-mac-address']) {
        const val = runCommand(['nmcli', '-t', '-f', field, 'connection', 'show', uuid]);
        if (!val) continue;

        // Output format: "wifi.cloned-mac-address:random"
        const parts = val.split(':');
        if (parts.length < 2) continue;
        const setting = parts.slice(1).join(':').trim().toLowerCase();

        if (setting === '' || setting === '--') continue; // field not applicable
        return setting === 'random' || setting === 'stable' || setting === 'stable-ssid';
    }
    return null; // not configured — will use NM global default
}

/**
 * Sets (or clears) MAC randomisation for a connection.
 * type: 'wifi' | 'ethernet' — determined by probing the connection type.
 */
function setRandomise(uuid, enable) {
    // Detect connection type
    const typeRaw = runCommand(['nmcli', '-t', '-f', 'connection.type', 'connection', 'show', uuid]);
    const connType = typeRaw.split(':').slice(1).join(':').trim().toLowerCase();

    let field;
    if (connType.includes('wireless') || connType.includes('wifi')) {
        field = 'wifi.cloned-mac-address';
    } else if (connType.includes('ethernet')) {
        field = '802-3-ethernet.cloned-mac-address';
    } else {
        // Generic fallback — try wifi field
        field = 'wifi.cloned-mac-address';
    }

    const value = enable ? 'random' : 'permanent';
    runCommand(['nmcli', 'connection', 'modify', uuid, field, value]);
}

// ---------------------------------------------------------------------------
// Extension Preferences
// ---------------------------------------------------------------------------

export default class MacRandomiserPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_title(_('MAC Randomiser'));
        window.set_default_size(700, 600);

        // ── Page: Interfaces ───────────────────────────────────────────────
        const ifacePage = new Adw.PreferencesPage({
            title: _('Interfaces'),
            icon_name: 'network-wired-symbolic',
        });
        window.add(ifacePage);

        const ifaceGroup = new Adw.PreferencesGroup({
            title: _('Network Interfaces'),
            description: _('Permanent (hardware) MAC addresses reported by NetworkManager.'),
        });
        ifacePage.add(ifaceGroup);

        const interfaces = getInterfaces();

        if (interfaces.length === 0) {
            const emptyRow = new Adw.ActionRow({ title: _('No interfaces found') });
            ifaceGroup.add(emptyRow);
        } else {
            for (const iface of interfaces) {
                const row = new Adw.ActionRow({
                    title: iface.name,
                    subtitle: iface.permMac ?? _('Unknown'),
                });

                // Copy-to-clipboard button
                const copyBtn = new Gtk.Button({
                    icon_name: 'edit-copy-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Copy MAC address'),
                    css_classes: ['flat'],
                });
                copyBtn.connect('clicked', () => {
                    const clipboard = window.get_clipboard();
                    clipboard.set(iface.permMac ?? '');
                });
                row.add_suffix(copyBtn);

                ifaceGroup.add(row);
            }
        }

        // Refresh button
        const ifaceRefreshGroup = new Adw.PreferencesGroup();
        ifacePage.add(ifaceRefreshGroup);

        const refreshIfaceRow = new Adw.ActionRow({
            title: _('Refresh interface list'),
        });
        const refreshIfaceBtn = new Gtk.Button({
            label: _('Refresh'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        refreshIfaceBtn.connect('clicked', () => {
            // Re-open preferences to force a full reload
            this.openPreferences();
        });
        refreshIfaceRow.add_suffix(refreshIfaceBtn);
        ifaceRefreshGroup.add(refreshIfaceRow);

        // ── Page: Connections ──────────────────────────────────────────────
        const connPage = new Adw.PreferencesPage({
            title: _('Connections'),
            icon_name: 'network-wireless-symbolic',
        });
        window.add(connPage);

        this._buildConnectionsPage(connPage, interfaces);
    }

    _buildConnectionsPage(page, interfaces) {
        // Group all connections, bucketed by device
        const deviceNames = interfaces.map(i => i.name);
        const seen = new Set();

        // Also grab connections with no active device
        for (const iface of [{ name: null }, ...interfaces]) {
            const conns = iface.name
                ? getConnectionsForDevice(iface.name).filter(c => !seen.has(c.uuid))
                : this._getOrphanConnections(seen);

            if (conns.length === 0) continue;

            conns.forEach(c => seen.add(c.uuid));

            const group = new Adw.PreferencesGroup({
                title: iface.name ? `${_('Device')}: ${iface.name}` : _('Other / Unassigned Connections'),
                description: iface.name
                    ? _('Toggle MAC randomisation per saved connection.')
                    : _('Connections not currently associated with a detected device.'),
            });
            page.add(group);

            for (const conn of conns) {
                this._addConnectionRow(group, conn);
            }
        }

        if (seen.size === 0) {
            const emptyGroup = new Adw.PreferencesGroup({ title: _('Connections') });
            page.add(emptyGroup);
            emptyGroup.add(new Adw.ActionRow({ title: _('No saved connections found.') }));
        }
    }

    _getOrphanConnections(seen) {
        const raw = runCommand(['nmcli', '-t', '-f', 'UUID,NAME,DEVICE', 'connection', 'show']);
        if (!raw) return [];
        const conns = [];
        for (const line of raw.split('\n')) {
            const parts = line.split(':');
            if (parts.length < 3) continue;
            const [uuid, name] = parts;
            if (!seen.has(uuid)) {
                const randomise = getRandomiseSetting(uuid);
                conns.push({ uuid, name, randomise });
            }
        }
        return conns;
    }

    _addConnectionRow(group, conn) {
        const row = new Adw.SwitchRow({
            title: conn.name,
            subtitle: conn.randomise === null
                ? _('Using global NetworkManager default')
                : conn.randomise
                    ? _('Randomisation enabled')
                    : _('Randomisation disabled (permanent MAC)'),
            active: conn.randomise === true,
        });

        row.connect('notify::active', () => {
            setRandomise(conn.uuid, row.active);
            row.subtitle = row.active
                ? _('Randomisation enabled')
                : _('Randomisation disabled (permanent MAC)');
        });

        group.add(row);
    }
}
