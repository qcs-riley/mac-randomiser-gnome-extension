import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const NMCLI   = '/usr/bin/nmcli';
const ETHTOOL = '/usr/bin/ethtool';

// ---------------------------------------------------------------------------
// Async command runner
// ---------------------------------------------------------------------------

function runCommandAsync(argv) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (_proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    resolve(stdout ? stdout.trim() : '');
                } catch (_e) {
                    resolve('');
                }
            });
        } catch (_e) {
            resolve('');
        }
    });
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function getActiveConnections() {
    const raw = await runCommandAsync(
        [NMCLI, '-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show', '--active']
    );
    if (!raw) return [];

    const conns = [];
    for (const line of raw.split('\n')) {
        // Format: NAME:UUID:TYPE:DEVICE
        // UUID contains hyphens but no colons, TYPE and DEVICE have no colons.
        // So last field is DEVICE, second-last is TYPE, second field is UUID,
        // but UUID is 36 chars — split on last 3 colons only.
        const lastColon  = line.lastIndexOf(':');
        const secColon   = line.lastIndexOf(':', lastColon - 1);
        const thirdColon = line.lastIndexOf(':', secColon - 1);
        if (lastColon === -1 || secColon === -1 || thirdColon === -1) continue;
        const device   = line.slice(lastColon + 1);
        const connType = line.slice(secColon + 1, lastColon);
        const uuid     = line.slice(thirdColon + 1, secColon);
        const name     = line.slice(0, thirdColon);

        if (connType.includes('loopback') || !device || device === '--') continue;

        const hwRaw = await runCommandAsync(
            [NMCLI, '-t', '-f', 'GENERAL.HWADDR', 'device', 'show', device]
        );
        const hwMatch = hwRaw.match(/GENERAL\.HWADDR:(.+)/);
        const activeMac = hwMatch ? hwMatch[1].trim() : '??:??:??:??:??:??';

        const etRaw = await runCommandAsync([ETHTOOL, '-P', device]);
        const etMatch = etRaw.match(/Permanent address:\s*([0-9a-fA-F:]{17})/);
        const permMac = etMatch ? etMatch[1].toUpperCase() : null;

        let randomise = null;
        if (connType.includes('wireless')) {
            const val = await runCommandAsync(
                [NMCLI, '-t', '-f', '802-11-wireless.cloned-mac-address', 'connection', 'show', uuid]
            );
            const s = val.split(':').slice(1).join(':').trim().toLowerCase();
            if (s && s !== '--') randomise = s === 'random' || s === 'stable' || s === 'stable-ssid';
        } else if (connType.includes('ethernet')) {
            const val = await runCommandAsync(
                [NMCLI, '-t', '-f', '802-3-ethernet.cloned-mac-address', 'connection', 'show', uuid]
            );
            const s = val.split(':').slice(1).join(':').trim().toLowerCase();
            if (s && s !== '--') randomise = s === 'random' || s === 'stable' || s === 'stable-ssid';
        }

        conns.push({ name, uuid, connType, device, activeMac, permMac, randomise });
    }
    return conns;
}

function setRandomiseAsync(uuid, connType, enable) {
    let field;
    if (connType.includes('wireless')) field = '802-11-wireless.cloned-mac-address';
    else if (connType.includes('ethernet')) field = '802-3-ethernet.cloned-mac-address';
    else return;
    runCommandAsync([NMCLI, 'connection', 'modify', uuid, field, enable ? 'random' : 'permanent']);
}

// ---------------------------------------------------------------------------
// Panel indicator
// ---------------------------------------------------------------------------

const MacRandomiserIndicator = GObject.registerClass(
class MacRandomiserIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'MAC Randomiser');
        this._ext = extension;
        this._refreshTimer = null;

        this._icon = new St.Icon({
            icon_name: 'security-high-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._statusLabel = new St.Label({
            text: '…',
            y_expand: true,
            y_align: 2, // CENTER
        });
        this.add_child(this._statusLabel);

        // Refresh label when menu closes
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) this._refreshAsync();
        });

        // Build initial menu
        this._buildStaticMenu();

        // Refresh data
        this._refreshAsync();
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refreshAsync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildStaticMenu() {
        this.menu.removeAll();
        const loadingItem = new PopupMenu.PopupMenuItem('Loading…');
        loadingItem.sensitive = false;
        this.menu.addMenuItem(loadingItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _refreshAsync() {
        getActiveConnections().then(conns => {
            this._conns = conns;
            const on = conns.some(c => c.randomise === true);
            this._statusLabel.text = on ? 'Randomised' : 'Static';
            this._icon.icon_name = 'security-high-symbolic';
            this._rebuildMenu(conns);
        }).catch(() => {
            this._statusLabel.text = 'Error';
        });
    }

    _rebuildMenu(conns) {
        this.menu.removeAll();

        if (conns.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No active connections');
            item.sensitive = false;
            this.menu.addMenuItem(item);
        } else {
            for (const conn of conns) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(conn.name));

                const macLabel = new PopupMenu.PopupMenuItem(`Current MAC: ${conn.activeMac}`);
                macLabel.sensitive = false;
                this.menu.addMenuItem(macLabel);

                // Always show permanent MAC when randomisation is off; only when different when on
                if (conn.permMac && (conn.randomise !== true || conn.permMac !== conn.activeMac.toUpperCase())) {
                    const permLabel = new PopupMenu.PopupMenuItem("Permanent MAC: " + conn.permMac);
                    permLabel.sensitive = false;
                    this.menu.addMenuItem(permLabel);
                }

                if (conn.connType.includes('wireless') || conn.connType.includes('ethernet')) {
                    const toggle = new PopupMenu.PopupSwitchMenuItem(
                        'Randomise MAC', conn.randomise === true
                    );
                    toggle.connect('toggled', (_item, state) => {
                        setRandomiseAsync(conn.uuid, conn.connType, state);
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                            this._refreshAsync();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    this.menu.addMenuItem(toggle);
                }
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    destroy() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }
        super.destroy();
    }
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default class MacRandomiserExtension extends Extension {
    enable() {
        this._indicator = new MacRandomiserIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
