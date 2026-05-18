# homebridge-intesisweb

## Overview

This is a Homebridge plugin for IntesisHome heat pump devices. It is based
on Philip Moon's `homebridge-intesis` plugin, but instead of using
Intesis's APIs (which aren't available for users any more), scrapes
the accloud.intesis.com pages to get the information it needs.

## Requirements

- Homebridge >= 1.6.0
- Node.js >= 18.20.4

For older versions of Homebridge or Node.js, please use version 1.x of this plugin.

## Installation

### Standard Installation

With Homebridge already installed, install the plugin by running:
`npm install -g homebridge-intesisweb`

### Manual Installation (Updated Version )

**Note**: The official npm package does not currently include the latest performance improvements and Homebridge 2.0 compatibility updates. 

To install this updated version manually:

1. **Download the latest release** from the [GitHub releases page](https://github.com/verisgit/homebridge-intesisweb/releases) or build from source

2. **For hb-service users** (most common on Raspberry Pi):
   ```bash
   #First SCP the release file to the Raspberry Pi - you can do it manually or use win-scp or similar
   scp /path/to/homebridge-intesisweb-2.0.2.tgz pi@raspberrypi:/tmp/homebridge-intesisweb-2.0.2.tgz
   
   # Stop Homebridge
   sudo hb-service stop

   # Install the package (replace with actual path)
   sudo hb-service shell
   npm install /path/to/homebridge-intesisweb-2.0.x.tgz
   exit

   # Start Homebridge
   sudo hb-service start
   
   # You can just view these in Homebridge UI or if you want to see it in the terminal use this
   sudo hb-service logs
   ```

3. **For standard npm installations**:
   ```bash
   # Install the local package
   npm install -g /path/to/homebridge-intesisweb-2.0.2.tgz

   # Restart Homebridge
   sudo systemctl restart homebridge
   ```

4. **Verify installation**:
   ```bash
   # Check version (should show 2.0.2 or higher)
   cat /var/lib/homebridge/node_modules/homebridge-intesisweb/package.json | grep version
   ```

5. **Look for these in logs** to confirm it's working:
   - `Loaded homebridge-intesisweb v2.0.2`
   - `Background polling started (every 30 seconds)`

**Benefits of the updated version**:
- 80-90% CPU usage reduction
- Homebridge 2.0 compatibility
- Instant HomeKit status updates
- Change logging for troubleshooting
- Node.js 24+ support

**Rollback if needed**:
```bash
# Reinstall the official version
npm install -g homebridge-intesisweb@1.0.20
```

## Configuration

Here is an example stanza for your config.json:

    "platforms": [
      {
        "platform": "IntesisWeb",
        "username": "username",
        "password": "password",
        "swingMode": "H",
        "apiBaseURL": "https://accloud.intesis.com/",
        "configCacheSeconds": 30,
        "defaultTemperature": 0
      }
    ]

### Required Options

* `platform` - Must be "IntesisWeb".
* `username` - This is the username you use to log in to accloud.intesis.com.
* `password` - This is the password you use to log in to accloud.intesis.com.

### Optional Options

* `swingMode` - Whether the swing feature operates on the horizontal or vertical vanes. Should be "V" or "H". Defaults to "H".
* `apiBaseURL` - The URL to the Intesis web site. Defaults to "https://accloud.intesis.com/".
* `configCacheSeconds` - **Polling interval** in seconds. The plugin automatically fetches device status from Intesis every X seconds in the background. Defaults to 30 seconds. Increase this value (e.g., 60 or 120) to reduce API calls and network traffic. Version 2.0+ uses efficient background polling for better performance.
* `defaultTemperature` - The temperature in Celsius to default the current temperature to if the temperature is not available from scraping the web page. 0 means to use the set point temperature. The default value is 0. Apparently you can disable the Intesis's reporting of the temperature, but HomeKit's HeaterCooler service requires a CurrentTemperature characteristic.

## Performance Tuning

Version 2.0 includes significant performance improvements with background polling instead of on-demand refresh.

If you experience high CPU usage:
- Ensure you're running version 2.0 or higher
- Increase `configCacheSeconds` to 60 or higher to reduce polling frequency
- Check your internet connection (slow API responses can cause delays)
- Monitor logs for errors that might cause excessive retries

Expected CPU usage reduction in version 2.0+: 80-90% compared to version 1.x

## Upgrading from Version 1.x

Version 2.0 includes significant performance improvements and Homebridge 2.0 support.

### Before Upgrading

1. Verify Node.js version: `node --version` (must be >= 18.20.4)
2. If needed, upgrade Node.js first
3. Ensure Homebridge is version 1.6.0 or higher

### Upgrade Steps

```bash
npm install -g homebridge-intesisweb@latest
```

Then restart Homebridge.

### What's Changed in 2.0

- **Performance**: Reduced CPU usage by 80-90% through background polling
- **Polling**: Now uses background polling instead of on-demand refresh on every characteristic request
- **Compatibility**: Works with both Homebridge 1.6.x and 2.0+
- **No configuration changes required**: Your existing config.json will work as-is

## Known Issues

When changing the mode of the heat pump, HomeKit seems to send power
on/off commands out of sync with the mode changing commands. Sometimes
this means that it will change the mode to "heat" *before* turning
the device on.

My implementation treats a fan speed of zero as setting it to automatic, but
the Home app treats it as meaning turn off the unit.
