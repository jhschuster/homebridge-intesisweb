/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

/** Parses one AC Cloud device view into normalized Intesis service state. */
function parseVista(body, options = {}) {
    const log = options.log || {debug: () => {}, error: () => {}};
    const defaultCurrentTemp = options.defaultCurrentTemp || 0;
    const swingMode = options.swingMode || "H";

    /** Matches a required field without ever logging the response body. */
    const requiredMatch = (pattern, fieldName) => {
	const match = body.match(pattern);
	if (!match) {
	    log.error(`PARSE ERROR: Failed to match pattern for '${fieldName}'`);
	    log.error(`Response body length: ${body.length} chars`);
	    return null;
	}
	return match;
    };

    const userIdMatch = requiredMatch(/\&userId=(\d+)/, 'userId');
    if (!userIdMatch) return null;

    const powerMatch = requiredMatch(/var selectedOnOff = (\d);/, 'power (selectedOnOff)');
    if (!powerMatch) return null;

    const userModeMatch = requiredMatch(/var selectedUsermode = (\d);/, 'userMode (selectedUsermode)');
    if (!userModeMatch) return null;

    // Capability-gate optional HomeKit mode services using the controls AC
    // Cloud actually renders for this device. Current pages HTML-encode the
    // "usermode" argument, while older variants may use literal quotes.
    const supportedUserModes = [];
    const userModeControlPattern = /setUID\s*\(\s*[^,()]+\s*,\s*2\s*,\s*(-?\d+)\s*,\s*(?:&quot;|["'])\s*usermode\s*(?:&quot;|["'])\s*\)/gi;
    let userModeControlMatch;
    while ((userModeControlMatch = userModeControlPattern.exec(body)) !== null) {
	const value = parseInt(userModeControlMatch[1], 10);
	if (!supportedUserModes.includes(value)) {
	    supportedUserModes.push(value);
	}
    }

    const fanSpeedMatch = requiredMatch(/var selectedfanspeed = (\d);/, 'fanSpeed (selectedfanspeed)');
    if (!fanSpeedMatch) return null;

    // AC Cloud omits the initializer and renders "--" when a setpoint is not
    // applicable, such as while some units are in fan mode.
    const setpointMatch = body.match(
	/setTempCelsiusConsignaHeader\(\d+,\s*'(-?\d+(?:\.\d+)?)'\s*\);/,
    );
    const currentTempMatch = body.match(
	/<div class="key_value">\s*(-?\d+(?:\.\d+)?)\s*\&deg;([FC])\s*<\/div>/,
    );

    let currentTempUnits = "C";
    let currentTempRawValue;
    let currentTempDefaulted;
    if (currentTempMatch) {
	currentTempRawValue = currentTempMatch[1];
	currentTempUnits = currentTempMatch[2];
	currentTempDefaulted = 0;
    }
    else if (defaultCurrentTemp != 0) {
	currentTempRawValue = defaultCurrentTemp;
	currentTempDefaulted = 1;
    }
    else if (setpointMatch) {
	currentTempRawValue = setpointMatch[1];
	currentTempDefaulted = 2;
    }
    else {
	// HeaterCooler requires CurrentTemperature. Use a valid neutral fallback
	// only when neither the sensor nor setpoint is available.
	currentTempRawValue = 20;
	currentTempDefaulted = 3;
    }

    const currentTempValue = currentTempUnits === "F"
	? (parseFloat(currentTempRawValue) - 32) * 5/9
	: parseFloat(currentTempRawValue);
    // HeaterCooler's threshold characteristics accept 10..35 C. Only clamp
    // the temporary value used while AC Cloud says the setpoint is
    // unavailable; preserve real setpoints exactly as reported.
    const setpointValue = setpointMatch
	? parseFloat(setpointMatch[1])
	: Math.min(35, Math.max(10, currentTempValue));

    if (!setpointMatch) {
	log.debug("Setpoint is unavailable in the current AC Cloud device state; using current temperature temporarily.");
    }

    const services = {
	user_id: userIdMatch[1],
	power: {
	    service_id: 1,
	    value: parseInt(powerMatch[1], 10)
	},
	userMode: {
	    service_id: 2,
	    value: parseInt(userModeMatch[1], 10),
	    ...(supportedUserModes.length ? {supported_values: supportedUserModes} : {})
	},
	fanSpeed: {
	    service_id: 4,
	    value: parseInt(fanSpeedMatch[1], 10)
	},
	currentTemp: {
	    units: currentTempUnits,
	    raw_value: currentTempRawValue,
	    value: currentTempValue,
	    defaulted: currentTempDefaulted
	},
	setpointTemp: {
	    service_id: 9,
	    raw_value: setpointMatch ? setpointMatch[1] : null,
	    value: setpointValue,
	    defaulted: !setpointMatch
	}
    };

    // Current AC Cloud pages expose swing state as selectedhswing and
    // selectedvswing. Older pages used selectedhvane and selectedvvane, so
    // accept both names. Prefer the explicit swing value when both exist.
    const horizontalVaneMatch = body.match(/var\s+selectedhswing\s*=\s*(\d+)\s*;/)
	|| body.match(/var\s+selectedhvane\s*=\s*(\d+)\s*;/);
    if (horizontalVaneMatch) {
	services.horizontalVanes = {
	    service_id: 6,
	    value: parseInt(horizontalVaneMatch[1], 10)
	};
    }

    const verticalVaneMatch = body.match(/var\s+selectedvswing\s*=\s*(\d+)\s*;/)
	|| body.match(/var\s+selectedvvane\s*=\s*(\d+)\s*;/);
    if (verticalVaneMatch) {
	services.verticalVanes = {
	    service_id: 5,
	    value: parseInt(verticalVaneMatch[1], 10)
	};
    }

    // Honor the configured axis when it exists, but do not hide HomeKit's
    // SwingMode merely because a device supports only the other axis.
    const preferredVanes = swingMode == "V"
	? services.verticalVanes || services.horizontalVanes
	: services.horizontalVanes || services.verticalVanes;
    if (preferredVanes) {
	services.swingMode = {
	    service_id: preferredVanes.service_id,
	    value: preferredVanes.value == 10 ? 10 : 0
	};
    }

    return services;
}

module.exports = {parseVista};
