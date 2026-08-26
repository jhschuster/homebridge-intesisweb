/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {parseVista} = require("./vista-parser");
const {IntesisCloudClient} = require("./cloud-client");

/** Omits arbitrary messages/bodies; logs a bounded-format name and integer status. */
function safeErrorMetadata(err) {
    const candidate = err && typeof err.name === "string" ? err.name : "";
    const name = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(candidate) ? candidate : "Error";
    const statusCode = err && err.response && err.response.statusCode;
    return Number.isInteger(statusCode) ? `${name} status=${statusCode}` : name;
}

/** Lists capability keys without serializing normalized state values. */
function capabilitySummary(device) {
    return device.services && typeof device.services === "object"
	? Object.keys(device.services).sort().join(",")
	: "none";
}

/** Normalizes a finite numeric setting while enforcing its supported minimum. */
function numericSetting(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Builds the Homebridge static-platform constructor around injected seams. */
function createPlatform({
    IntesisWebDevice,
    CloudClient = IntesisCloudClient,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    maxAuthAttempts = 3
}) {
    /** Stores configuration until Homebridge requests static accessories. */
    function IntesisWeb(log, config) {
	this.log = log;
	this.config = config;
	this.log.debug("IntesisWeb(log, config) called.");
    }

    /** Starts discovery and polling, completing Homebridge's callback once. */
    IntesisWeb.prototype.accessories = function (callback) {
	this.log.debug("IntesisWeb.accessories(callback) called.");
	const config = this.config;
	// Credentials belong only to the cloud client. Keeping duplicate platform
	// copies increases accidental exposure risk without serving runtime behavior.
	this.configCacheSeconds = numericSetting(config["configCacheSeconds"], 30, 1);
	this.swingMode = config["swingMode"] === "V" ? "V" : "H";
	this.defaultCurrentTemp = numericSetting(config["defaultTemperature"], 0, 0);
	this.accessories = [];
	this.deviceDictionary = {};
	this.lastLogin = null;
	this.loggedIn = false;
	this.refreshConfigInProgress = false;
	this.accessoriesCallbackCompleted = false;
	// Discovery and error paths converge here so Homebridge cannot be left
	// waiting or receive the static-accessory callback more than once.
	this.setupAccessories = accessories => {
	    if (this.accessoriesCallbackCompleted) return;
	    this.accessoriesCallbackCompleted = true;
	    this.log("Setting up accessories/devices...");
	    callback(accessories);
	};
	try {
	    this.cloud = new CloudClient(this.log, config);
	    // Preserve the legacy platform fields for compatibility with diagnostics
	    // and callers that inspect the static platform instance.
	    this.cookieJar = this.cloud.cookieJar;
	    this.got = this.cloud.got;
	}
	catch (err) {
	    this.log.error(`Platform initialization failed: ${safeErrorMetadata(err)}`);
	    this.setupAccessories([]);
	    return;
	}
	// instantiateAccessories owns its complete try/catch and exactly-once
	// callback path; keep startup non-blocking while that discovery runs.
	void this.instantiateAccessories();
	this.pollingInterval = setIntervalFn(() => {
	    this.refreshConfig("Background poll");
	}, (this.configCacheSeconds || 30) * 1000);
	this.log(`Background polling started (every ${this.configCacheSeconds || 30} seconds)`);
    };

    /** Delegates authentication while mirroring legacy platform state fields. */
    IntesisWeb.prototype.doLogin = function () {
	return this.cloud.doLogin().then(loggedIn => {
	    this.loggedIn = this.cloud.loggedIn;
	    this.lastLogin = this.cloud.lastLogin;
	    return loggedIn;
	});
    };

    /** Delegates header retrieval while mirroring session state. */
    IntesisWeb.prototype.getHeaders = function () {
	return this.cloud.getHeaders().then(body => {
	    this.loggedIn = this.cloud.loggedIn;
	    return body;
	});
    };

    /** Discovers and normalizes devices after a bounded number of auth attempts. */
    IntesisWeb.prototype.getConfig = async function () {
	this.log.debug("IntesisWeb.getConfig() called.");
	let body = null;
	// A bad session can alternate between login and header failures. Bounding
	// the combined attempts prevents static-platform startup from hanging.
	for (let attempt = 1; attempt <= maxAuthAttempts && !body; attempt++) {
	    if (!this.cloud.loggedIn && !await this.doLogin()) {
		this.log.debug(`Authentication attempt ${attempt}/${maxAuthAttempts} failed.`);
		continue;
	    }
	    body = await this.getHeaders();
	    if (!body) this.log.debug(`Header attempt ${attempt}/${maxAuthAttempts} failed.`);
	}
	if (!body) {
	    this.log("Discovery authentication failed after bounded retries.");
	    return null;
	}
	const re = /<div id="deviceHeader_(\d+)"[^]*?<div class="name left">(.*?)<\/div>/g;
	let matches;
	const devices = [];
	while ((matches = re.exec(body)) !== null) {
	    devices.push({
		device_id: matches[1],
		name: matches[2],
		user_id: null,
		services: null
	    });
	}
	if (devices.length === 0) {
	    this.log("getConfig FAILED");
	    return null;
	}
	const states = await Promise.all(devices.map(async device => {
	    const vista = await this.cloud.getVista(device.device_id);
	    this.loggedIn = this.cloud.loggedIn;
	    return vista ? this.getDeviceStateFromVista(vista) : null;
	}));
	const completeDevices = [];
	for (let i = 0; i < states.length; i++) {
	    if (states[i]) {
		devices[i].user_id = states[i].user_id;
		delete states[i].user_id;
		devices[i].services = states[i];
		completeDevices.push(devices[i]);
	    }
	}
	// Never construct or reconcile an accessory from a partial scrape. Other
	// devices remain usable, while the failed one can recover on the next poll.
	if (completeDevices.length === devices.length) this.lastConfigFetch = new Date().getTime();
	this.log.debug(
	    `getConfig: discovered ${completeDevices.length}/${devices.length} complete device(s).`);
	for (const device of completeDevices) {
	    this.log.debug(
		`Device "${device.name || "(unnamed)"}" id=${device.device_id} capabilities=${capabilitySummary(device)}`);
	}
	return completeDevices;
    };

    /** Parses one raw AC Cloud view with the platform's temperature options. */
    IntesisWeb.prototype.getDeviceStateFromVista = function (body) {
	return parseVista(body, {
	    defaultCurrentTemp: this.defaultCurrentTemp,
	    swingMode: this.swingMode,
	    log: this.log
	});
    };

    /** Creates discovered accessories or terminates startup with an empty list. */
    IntesisWeb.prototype.instantiateAccessories = async function () {
	try {
	    const devices = await this.getConfig();
	    if (!devices || devices.length === 0) {
		this.log("Malformed config, skipping.");
		this.setupAccessories([]);
		return;
	    }
	    for (const device of devices) {
		const name = device.name;
		if (!name) {
		    this.log(`Unnamed device skipped: id=${device.device_id} capabilities=${capabilitySummary(device)}`);
		    continue;
		}
		const deviceKey = device.device_id;
		if (this.deviceDictionary[deviceKey]) {
		    this.log(`"${name}" already instantiated.`);
		    continue;
		}
		this.deviceDictionary[deviceKey] = new IntesisWebDevice(this.log, device, this);
		this.accessories.push(this.deviceDictionary[deviceKey]);
		this.log(`Added "${name}" - Device ID: ${device.device_id}.`);
	    }
	    this.setupAccessories(this.accessories);
	}
	catch (err) {
	    this.log.error(`Initial discovery failed: ${safeErrorMetadata(err)}`);
	    this.setupAccessories([]);
	}
    };

    /** Refreshes known devices and always releases the overlapping-poll guard. */
    IntesisWeb.prototype.refreshConfig = async function (msg) {
	if (this.lastConfigFetch && (new Date().getTime() - this.lastConfigFetch) / 1000 <= this.configCacheSeconds) {
	    this.log.debug(`${msg}: Using cached data; less than ${this.configCacheSeconds}s old.`);
	    return;
	}
	if (this.refreshConfigInProgress) {
	    this.log.debug(`${msg}: Refresh in progress.`);
	    return;
	}
	this.refreshConfigInProgress = true;
	this.log.debug(`${msg}: Refreshing.`);
	try {
	    const devices = await this.getConfig();
	    if (!devices) {
		this.log(`${msg}: Refresh FAILED.`);
		return;
	    }
	    this.log.debug(`${msg}: Refresh successful.`);
	    for (const device of devices) {
		const existing = this.deviceDictionary[device.device_id];
		if (existing) existing.updateData(device);
	    }
	}
	catch (err) {
	    this.log.error(`${msg}: Refresh failed: ${safeErrorMetadata(err)}`);
	}
	finally {
	    // A rejected fetch or device update must not block every later poll.
	    this.refreshConfigInProgress = false;
	}
    };

    /** Preserves the device-facing callback transport signature. */
    IntesisWeb.prototype.setValue = function (userID, deviceID, serviceID, value, callback) {
	return this.cloud.setValue(userID, deviceID, serviceID, value, callback);
    };

    /** Stops background polling when Homebridge shuts down the platform. */
    IntesisWeb.prototype.shutdown = function () {
	// Injected timer implementations may return a falsy token, so test only
	// for the explicit uninitialized states.
	if (this.pollingInterval !== null && this.pollingInterval !== undefined) {
	    clearIntervalFn(this.pollingInterval);
	    this.pollingInterval = null;
	    this.log("Background polling stopped");
	}
    };

    return IntesisWeb;
}

module.exports = {createPlatform};
