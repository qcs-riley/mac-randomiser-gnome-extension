import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NMCLI   = '/usr/bin/nmcli';
const ETHTOOL = '/usr/bin/ethtool';

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
 * Returns devices from NM, excluding lo and p2p virtual interfaces.
 * Each entry: { name, type, permMac, activeMac }
 *   type: 'wifi' | 'ethernet' | 'other'
 */
function getDevices() {
    // Get device list with type info
    const raw = runCommand([NMCLI, '-t', '-f', 'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.HWADDR', 'device', 'show']);
    if (!raw) return [];

    const devices = [];
    let current = {};

    for (const line of raw.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1).trim();

        if (key === 'GENERAL.DEVICE') {
            current = { name: value, type: 'other', permMac: _('Unknown'), activeMac: null };
        } else if (key === 'GENERAL.TYPE') {
            if (value.includes('wifi') || value.includes('wireless')) current.type = 'wifi';
            else if (value.includes('ethernet')) current.type = 'ethernet';
        } else if (key === 'GENERAL.HWADDR') {
            current.activeMac = value && value !== '--' ? value : null;
            // Only push once we have all three fields
            const name = current.name;
            if (name && name !== 'lo' && !name.startsWith('p2p-dev-')) {
                devices.push({ ...current });
            }
        }
    }

    // Get permanent MACs via ethtool
    for (const dev of devices) {
        const out = runCommand([ETHTOOL, '-P', dev.name]);
        const match = out.match(/Permanent address:\s*([0-9a-fA-F:]{17})/);
        if (match) dev.permMac = match[1].toUpperCase();
    }

    return devices;
}

/**
 * Returns all saved connections with randomise state and their NM connection type.
 * Each entry: { uuid, name, connType, randomise }
 *   connType: '802-11-wireless' | '802-3-ethernet' | 'vpn' | 'loopback' | ...
 */
function getAllConnections() {
    const raw = runCommand([NMCLI, '-t', '-f', 'UUID,NAME,TYPE', 'connection', 'show']);
    if (!raw) return [];

    const conns = [];
    for (const line of raw.split('\n')) {
        // UUID is 36 chars with hyphens, so split carefully
        const parts = line.split(':');
        if (parts.length < 3) continue;
        const uuid = parts[0];
        const connType = parts[parts.length - 1]; // last field is TYPE
        const name = parts.slice(1, parts.length - 1).join(':'); // middle is NAME
        const randomise = getRandomiseSetting(uuid, connType);
        conns.push({ uuid, name, connType, randomise });
    }
    return conns;
}

/**
 * Reads the cloned-mac-address setting for a connection.
 * Returns: true (randomised), false (permanent), null (using global NM default).
 */
function getRandomiseSetting(uuid, connType) {
    let field;
    if (connType && connType.includes('wireless')) field = 'wifi.cloned-mac-address';
    else if (connType && connType.includes('ethernet')) field = '802-3-ethernet.cloned-mac-address';
    else return null; // vpn, loopback etc. — not applicable

    const val = runCommand([NMCLI, '-t', '-f', field, 'connection', 'show', uuid]);
    if (!val) return null;

    const colonIdx = val.indexOf(':');
    if (colonIdx === -1) return null;
    const setting = val.slice(colonIdx + 1).trim().toLowerCase();
    if (!setting || setting === '--') return null;
    return setting === 'random' || setting === 'stable' || setting === 'stable-ssid';
}

/**
 * Sets MAC randomisation for a connection.
 */
function setRandomise(uuid, connType, enable) {
    let field;
    if (connType && connType.includes('wireless')) field = 'wifi.cloned-mac-address';
    else if (connType && connType.includes('ethernet')) field = '802-3-ethernet.cloned-mac-address';
    else return; // can't set for vpn/loopback

    runCommand([NMCLI, 'connection', 'modify', uuid, field, enable ? 'random' : 'permanent']);
}

// ---------------------------------------------------------------------------
// Extension Preferences
// ---------------------------------------------------------------------------

export default class MacRandomiserPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_title(_('MAC Randomiser'));
        window.set_default_size(700, 600);

        const devices = getDevices();
        const allConns = getAllConnections();

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

        if (devices.length === 0) {
            ifaceGroup.add(new Adw.ActionRow({ title: _('No interfaces found') }));
        } else {
            for (const dev of devices) {
                const row = new Adw.ActionRow({
                    title: dev.name,
                    subtitle: dev.permMac,
                });
                const copyBtn = new Gtk.Button({
                    icon_name: 'edit-copy-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Copy MAC address'),
                    css_classes: ['flat'],
                });
                copyBtn.connect('clicked', () => {
                    window.get_clipboard().set(dev.permMac);
                });
                row.add_suffix(copyBtn);
                ifaceGroup.add(row);
            }
        }

        // Refresh button
        const refreshGroup = new Adw.PreferencesGroup();
        ifacePage.add(refreshGroup);
        const refreshRow = new Adw.ActionRow({ title: _('Refresh interface list') });
        const refreshBtn = new Gtk.Button({
            label: _('Refresh'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        refreshBtn.connect('clicked', () => this.openPreferences());
        refreshRow.add_suffix(refreshBtn);
        refreshGroup.add(refreshRow);

        // ── Page: Connections ──────────────────────────────────────────────
        const connPage = new Adw.PreferencesPage({
            title: _('Connections'),
            icon_name: 'network-wireless-symbolic',
        });
        window.add(connPage);

        this._buildConnectionsPage(connPage, devices, allConns);
    }

    _buildConnectionsPage(page, devices, allConns) {
        const seen = new Set();

        // Bucket connections by matching NM connection type to device type
        for (const dev of devices) {
            const devConns = allConns.filter(c => {
                if (seen.has(c.uuid)) return false;
                if (dev.type === 'wifi') return c.connType.includes('wireless');
                if (dev.type === 'ethernet') return c.connType.includes('ethernet');
                return false;
            });

            if (devConns.length === 0) continue;
            devConns.forEach(c => seen.add(c.uuid));

            const group = new Adw.PreferencesGroup({
                title: `${dev.name}`,
                description: _('Current MAC: %s').replace('%s', dev.activeMac ?? _('not connected')),
            });
            page.add(group);

            for (const conn of devConns) {
                this._addConnectionRow(group, conn, dev.activeMac);
            }
        }

        // Remaining connections (vpn, loopback, unmatched)
        const remaining = allConns.filter(c => !seen.has(c.uuid) &&
            !c.connType.includes('loopback'));

        if (remaining.length > 0) {
            const group = new Adw.PreferencesGroup({
                title: _('Other Connections'),
                description: _('VPN and other connection types — MAC randomisation not applicable.'),
            });
            page.add(group);
            for (const conn of remaining) {
                group.add(new Adw.ActionRow({
                    title: conn.name,
                    subtitle: conn.connType,
                }));
            }
        }

        if (allConns.length === 0) {
            const emptyGroup = new Adw.PreferencesGroup({ title: _('Connections') });
            page.add(emptyGroup);
            emptyGroup.add(new Adw.ActionRow({ title: _('No saved connections found.') }));
        }
    }

    _addConnectionRow(group, conn, activeMac = null) {
        const enabledLabel = activeMac
            ? _('Randomisation enabled — current MAC: %s').replace('%s', activeMac)
            : _('Randomisation enabled');

        const row = new Adw.SwitchRow({
            title: conn.name,
            subtitle: conn.randomise === null
                ? _('Using global NetworkManager default')
                : conn.randomise
                    ? enabledLabel
                    : _('Randomisation disabled (permanent MAC)'),
            active: conn.randomise === true,
        });

        row.connect('notify::active', () => {
            setRandomise(conn.uuid, conn.connType, row.active);
            row.subtitle = row.active
                ? enabledLabel
                : _('Randomisation disabled (permanent MAC)');
        });

        group.add(row);
    }
}
