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
	    "apiBaseURL": "https://user.intesishome.com/",
	    "configCacheSeconds": 30
	}
    ]

### Required Options

* `platform` - Must be "IntesisWeb".
* `username` - This is the username you use to log in to user.intesishome.com.
* `password` - This is the password you use to log in to user.intesishome.com.

### Optional Options

* `apiBaseURL` - The URL to the Intesis web site.  Defaults to "https://user.intesishome.com/".
* `configCacheSeconds` - The number of seconds to cache the Intesis configuration for.  This prevents the plugin from constantly scraping their website.  The default value is 30.

## Known Issues

When changing the mode of the heat pump, HomeKit seems to send power
on/off commands out of sync with the mode changing commands. Sometimes
this means that it will change the mode to "heat" *before* turning
the device on.
