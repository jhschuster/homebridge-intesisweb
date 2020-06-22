# homebridge-intesisweb

## Overview

This is a Homebridge plugin for IntesisHome heat pump devices. It is based
on Philip Moon's `homebridge-intesis` plugin, but instead of using
Intesis's APIs (which aren't available for users any more), scrapes
the user.intesis.com pages to get the information it needs.

## Installation

With Homebridge already installed, install the plugin by running:
`npm install -g homebridge-intesisweb`

## Configuration

Here is an example stanza for your config.json:

    "platforms": [
      {
        "platform": "IntesisWeb",
        "username": "username",
        "password": "password",
        "swingMode": "H",
        "apiBaseURL": "https://user.intesishome.com/",
        "configCacheSeconds": 30
      }
    ]

### Required Options

* `platform` - Must be "IntesisWeb".
* `username` - This is the username you use to log in to user.intesishome.com.
* `password` - This is the password you use to log in to user.intesishome.com.

### Optional Options

* `swingMode` - Whether the swing feature operates on the horizontal or verical vanes. Should be "V" or "H". Defaults to "H".
* `apiBaseURL` - The URL to the Intesis web site. Defaults to "https://user.intesishome.com/".
* `configCacheSeconds` - The number of seconds to cache the Intesis configuration for. This prevents the plugin from constantly scraping their website. The default value is 30.

## Known Issues

When changing the mode of the heat pump, HomeKit seems to send power
on/off commands out of sync with the mode changing commands. Sometimes
this means that it will change the mode to "heat" *before* turning
the device on.

My implentation treats a fan speed of zero as setting it to automatic, but
the Home app treats it as meaning turn off the unit.

For some reason HomeKit sends Swing Mode get/set requests in pairs, and the second one, when handled, throws this error:
```
(node:23446) UnhandledPromiseRejectionWarning: Error: This callback function has already been called by someone else; it can only be called one time.
    at /usr/lib/node_modules/homebridge/node_modules/hap-nodejs/src/lib/util/once.ts:6:13
    at /usr/lib/node_modules/homebridge-intesisweb/index.js:620:5
    at IntesisWeb.refreshConfig (/usr/lib/node_modules/homebridge-intesisweb/index.js:289:6)
    at SwingMode.<anonymous> (/usr/lib/node_modules/homebridge-intesisweb/index.js:617:18)
    at SwingMode.emit (events.js:327:22)
    at SwingMode.EventEmitter.emit (/usr/lib/node_modules/homebridge/node_modules/hap-nodejs/src/lib/EventEmitter.ts:42:22)
    at SwingMode.Characteristic._this.getValue (/usr/lib/node_modules/homebridge/node_modules/hap-nodejs/src/lib/Characteristic.ts:462:12)
    at /usr/lib/node_modules/homebridge/node_modules/hap-nodejs/src/lib/Accessory.ts:1215:22
    at Array.forEach (<anonymous>)
    at Bridge.Accessory._this._handleGetCharacteristics (/usr/lib/node_modules/homebridge/node_modules/hap-nodejs/src/lib/Accessory.ts:1143:10)
(node:23446) UnhandledPromiseRejectionWarning: Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). To terminate the node process on unhandled promise rejection, use the CLI flag `--unhandled-rejections=strict` (see https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). (rejection id: 1)
(node:23446) [DEP0018] DeprecationWarning: Unhandled promise rejections are deprecated. In the future, promise rejections that are not handled will terminate the Node.js process with a non-zero exit code.
```
To hack around it, I've made it only process the callback for every other
request.
