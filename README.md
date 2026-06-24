# MAC Randomiser

A GNOME Shell extension to manage MAC address randomisation via NetworkManager.

## Features

- View permanent (hardware) MAC addresses for all network interfaces
- Toggle MAC address randomisation per saved connection
- Shows the current active MAC when randomisation is enabled

## Requirements

- GNOME Shell 45+
- NetworkManager with `nmcli`
- `ethtool`

## Installation

### From GNOME Extensions website
Coming soon.

### Manual
```bash
cd mac-randomiser@quantumcs.co.uk
zip -r ../mac-randomiser.zip metadata.json extension.js prefs.js
gnome-extensions install mac-randomiser.zip
gnome-extensions enable mac-randomiser@quantumcs.co.uk
```

## Usage

Open Extension Manager, find MAC Randomiser, and click the settings cog.

## License

MIT
