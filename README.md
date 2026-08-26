# homebridge-intesisweb

`homebridge-intesisweb` connects Intesis AC Cloud Control mini-split systems to
Apple Home through Homebridge. It discovers every unit in an AC Cloud account,
polls its current state, and translates supported controls into HomeKit
services.

This is an unofficial integration. Intesis does not provide a supported public
API for this use case, so the plugin signs in to the AC Cloud website and parses
its device pages. A website change can break discovery or control until the
plugin is updated.

## Requirements

- Homebridge 1.8 or later, including Homebridge 2.x
- Node.js 22.10 or later in the Node 22 line, or Node.js 24
- An AC Cloud Control account with one or more registered devices

## Installation

Install the published package from the Homebridge UI, or use the Homebridge
terminal:

```sh
npm install homebridge-intesisweb
```

Restart Homebridge after installation or an upgrade.

## Configuration

The Homebridge UI reads `config.schema.json` and provides a configuration form.
The equivalent `config.json` platform entry is:

```json
{
  "platform": "IntesisWeb",
  "username": "your-ac-cloud-username",
  "password": "your-ac-cloud-password",
  "swingMode": "H",
  "configCacheSeconds": 30,
  "defaultTemperature": 0
}
```

Required settings:

- `username`: the username used to sign in to AC Cloud Control. This is not
  necessarily the account email address.
- `password`: the AC Cloud Control password.

Optional settings:

- `swingMode`: selects the axis used by the Heater/Cooler's generic Swing Mode
  characteristic when a unit has both axes. Use `H` for horizontal or `V` for
  vertical. The default is `H`; separate axis switches are still published.
- `configCacheSeconds`: status polling interval in seconds. The default is 30.
- `defaultTemperature`: Celsius value used when neither current-temperature
  telemetry nor a usable setpoint is available. `0` preserves the normal
  fallback sequence: current temperature, setpoint, then a neutral 20 °C.
- `apiBaseURL`: alternate AC Cloud base URL. Most users should leave the default
  `https://accloud.intesis.com/` unchanged.

Homebridge stores the account credentials in its local `config.json`. The
plugin uses them only to authenticate its in-memory cookie session. It does not
write credentials, cookies, CSRF tokens, user IDs, or response bodies to logs.

## HomeKit services

Service availability is based on the controls AC Cloud reports for each unit.

- **Heater/Cooler** provides physical state, current temperature, native
  Auto/Heat/Cool targets, the shared temperature setpoint, and a generic Swing
  Mode when a vane axis is available.
- **Fan Only** is a separate switch for fan-only operating mode.
- **Dry Mode** is a separate switch for dry mode. AC Cloud does not provide the
  humidity target required for a HomeKit dehumidifier service.
- **Fan Speed** is a Fan service linked to the Heater/Cooler. Its manual slider
  maps 25%, 50%, 75%, and 100% to Intesis levels 1 through 4. It has no zero
  position and never changes physical power.
- **Fan Auto** selects Intesis automatic fan speed. Turning it off restores the
  last manual speed, or level 1 after a cold start.
- **Horizontal Swing** and **Vertical Swing** are separate switches published
  only for axes reported by the unit.

The Fan Speed service's Active value mirrors physical HVAC power, but changing
that HomeKit toggle is intentionally a no-op. Physical power and operating mode
remain under the Heater/Cooler and auxiliary-mode services.

While Fan Auto is enabled or a unit is off, the manual fan slider retains its
last nonzero selection. Moving it selects that manual level and disables Fan
Auto without changing physical power.

HomeKit writes are serialized independently for each unit. This prevents local
multi-step mode and power commands from overtaking one another. Fan Only and
Dry Mode OFF actions use the last polled mode as a safety check; a change made
by another client between polls can still race that check.

The generic Heater/Cooler Swing Mode and its matching axis switch stay
synchronized. They do not change the other axis.

## Development

Install dependencies and run the complete test suite:

```sh
npm install
npm test
```

Run the suite with Node's built-in coverage report:

```sh
npm run test:coverage
```

Inspect the exact npm package contents before publishing:

```sh
npm pack --dry-run
```

The package allowlist includes only runtime code, metadata, the schema, license,
changelog, and this README. Tests, local deployment helpers, `env.sh`, and
generated `.tgz` archives are not published.

### Local Synology test deployment

The optional `scripts/install-synology-test.sh` helper builds the current
working tree, runs its tests, packages it, uploads it, verifies the installed
runtime fingerprint, restarts Homebridge, and optionally follows logs. Review
the script before running it because it modifies a remote Homebridge
installation.

Create an ignored `env.sh` in the repository root. Keep the two groups separate
and replace every placeholder locally:

```sh
# AC Cloud account (used by separate read-only development probes)
export INTESIS_AC_CLOUD_USERNAME="your-ac-cloud-username"
export INTESIS_AC_CLOUD_PASSWORD="your-ac-cloud-password"

# Synology Homebridge test deployment
export HOMEBRIDGE_SYNOLOGY_HOST="your-homebridge-host"
export HOMEBRIDGE_SYNOLOGY_SSH_USER="your-ssh-user"
export HOMEBRIDGE_SYNOLOGY_TEMP_DIR="/tmp"
export HOMEBRIDGE_SYNOLOGY_STORAGE_DIR="/path/to/homebridge-storage"
```

`env.sh` and `*.tgz` are ignored by both Git and npm. The installer sources
`env.sh` automatically; set `ENV_FILE=/another/private/path` to use a different
file.

Run a deployment with:

```sh
./scripts/install-synology-test.sh --logs
```

## Troubleshooting

- Use Homebridge debug logging to see authentication, discovery, capability,
  polling, and command metadata. Sensitive response bodies and session data are
  deliberately omitted at every logging level.
- Recheck the AC Cloud username and password by signing in at
  <https://accloud.intesis.com/login>.
- If controls disappear after an AC Cloud website update, capture only the
  parse-error field names and response lengths from logs. Do not post account
  credentials, cookies, tokens, user IDs, or raw device-page HTML.
- Increasing `configCacheSeconds` reduces AC Cloud traffic at the cost of slower
  reconciliation for changes made outside HomeKit.

## Credits and license

This project is based on Phillip Moon's original `homebridge-intesis` work and
Jay Schuster's `homebridge-intesisweb` integration, with additional development
by Armando DiCianno and other contributors. It is distributed under the MIT
License; see [LICENSE](LICENSE).
