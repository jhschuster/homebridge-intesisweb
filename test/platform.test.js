/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const {createPlatform} = require("../lib/platform");

/** Creates a Homebridge-shaped logger that records every level. */
function recordingLog() {
    const entries = [];
    /** Serializes one log call for redaction assertions. */
    const record = (...values) => entries.push(values.map(String).join(" "));
    record.debug = record;
    record.error = record;
    return {log: record, entries};
}

/** Provides inert, inspectable interval functions for platform tests. */
function timerHarness() {
    const scheduled = [];
    const cleared = [];
    return {
	scheduled,
	cleared,
	/** Records a scheduled interval without starting a real timer. */
	setIntervalFn(handler, milliseconds) {
	    const token = {handler, milliseconds};
	    scheduled.push(token);
	    return token;
	},
	/** Records which interval token the platform clears. */
	clearIntervalFn(token) {
	    cleared.push(token);
	}
    };
}

/** Starts static discovery and exposes its exactly-once callback state. */
function beginAccessories(platform) {
    let callbackCount = 0;
    let lastAccessories;
    const completed = new Promise(resolve => {
	platform.accessories(accessories => {
	    callbackCount += 1;
	    lastAccessories = accessories;
	    resolve(accessories);
	});
    });
    return {
	completed,
	/** Returns the number of Homebridge callback invocations. */
	get callbackCount() { return callbackCount; },
	/** Returns the most recently supplied accessory list. */
	get lastAccessories() { return lastAccessories; }
    };
}

/** Builds a minimal injectable cloud class and exposes each new instance. */
function baseCloud(instanceHook) {
    /** Minimal cloud boundary used by platform-only tests. */
    return class FakeCloud {
	/** Initializes legacy fields inspected by the platform. */
	constructor() {
	    this.loggedIn = false;
	    this.lastLogin = null;
	    this.cookieJar = {};
	    this.got = {};
	    if (instanceHook) instanceHook(this);
	}
	/** Returns inert device-view markup. */
	async getVista() { return "vista"; }
	/** Provides the callback transport surface without network access. */
	async setValue() {}
    };
}

test("cloud-client construction failure completes startup without scheduling polling", async () => {
    /** Simulates a missing or unusable runtime HTTP dependency. */
    class BrokenCloud {
	/** Fails before any credential or transport state can escape. */
	constructor() { throw Object.assign(Error("PRIVATE_CONSTRUCTOR_MESSAGE"), {name: "DependencyError"}); }
    }
    const timers = timerHarness();
    const {log, entries} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: BrokenCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {});
    const startup = beginAccessories(platform);

    assert.deepEqual(await startup.completed, []);
    assert.equal(startup.callbackCount, 1);
    assert.equal(timers.scheduled.length, 0);
    assert.match(entries.join("\n"), /Platform initialization failed: DependencyError/);
    assert.equal(entries.join("\n").includes("PRIVATE_CONSTRUCTOR_MESSAGE"), false);
});

test("initial authentication failure is bounded and completes startup once with an empty list", async () => {
    let cloud;
    const FakeCloud = baseCloud(instance => {
	cloud = instance;
	instance.loginCalls = 0;
	instance.doLogin = async function () {
	    this.loginCalls += 1;
	    this.loggedIn = false;
	    return false;
	};
	instance.getHeaders = async () => { throw Error("headers must not run"); };
    });
    const timers = timerHarness();
    const {log} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn,
	maxAuthAttempts: 2
    });
    const platform = new Platform(log, {username: "user", password: "password"});
    const startup = beginAccessories(platform);

    assert.deepEqual(await startup.completed, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(startup.callbackCount, 1);
    assert.deepEqual(startup.lastAccessories, []);
    assert.equal(cloud.loginCalls, 2);
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0].milliseconds, 30000);
    assert.equal(Object.hasOwn(platform, "username"), false);
    assert.equal(Object.hasOwn(platform, "password"), false);
    let pollCalls = 0;
    platform.refreshConfig = () => { pollCalls += 1; };
    timers.scheduled[0].handler();
    assert.equal(pollCalls, 1);
});

test("header/session retries are bounded and terminal failure completes startup", async () => {
    let cloud;
    const FakeCloud = baseCloud(instance => {
	cloud = instance;
	instance.loginCalls = 0;
	instance.headerCalls = 0;
	instance.doLogin = async function () {
	    this.loginCalls += 1;
	    this.loggedIn = true;
	    return true;
	};
	instance.getHeaders = async function () {
	    this.headerCalls += 1;
	    this.loggedIn = false;
	    return null;
	};
    });
    const timers = timerHarness();
    const {log} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn,
	maxAuthAttempts: 2
    });
    const platform = new Platform(log, {});
    const startup = beginAccessories(platform);

    assert.deepEqual(await startup.completed, []);
    assert.equal(startup.callbackCount, 1);
    assert.equal(cloud.loginCalls, 2);
    assert.equal(cloud.headerCalls, 2);
});

test("authenticated discovery with no device headers completes startup safely", async () => {
    const FakeCloud = baseCloud(instance => {
	instance.doLogin = async function () { this.loggedIn = true; return true; };
	instance.getHeaders = async () => "<div>no devices</div>";
    });
    const timers = timerHarness();
    const {log} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });

    assert.deepEqual(await beginAccessories(new Platform(log, {})).completed, []);
});

test("successful discovery returns accessories once and logs only safe summaries", async () => {
    const userID = "SECRET_USER_ID_MARKER";
    const stateMarker = "FULL_NORMALIZED_STATE_SECRET";
    const credentialMarker = "PLATFORM_CREDENTIAL_SECRET";
    const header = [
	'<div id="deviceHeader_101"><div class="name left">Bedroom</div>',
	'<div id="deviceHeader_202"><div class="name left"></div>'
    ].join("");
    const FakeCloud = baseCloud(instance => {
	instance.doLogin = async function () {
	    this.loggedIn = true;
	    return true;
	};
	instance.getHeaders = async () => header;
    });
    /** Captures normalized details passed to a discovered accessory. */
    class Device {
	/** Stores discovery details for assertions. */
	constructor(_log, details) {
	    this.details = details;
	}
    }
    const timers = timerHarness();
    const {log, entries} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: Device,
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {
	username: credentialMarker,
	password: credentialMarker
    });
    platform.getDeviceStateFromVista = () => ({
	user_id: userID,
	power: {service_id: 1, value: 1, marker: stateMarker},
	fanSpeed: {service_id: 4, value: 2}
    });
    const startup = beginAccessories(platform);

    const accessories = await startup.completed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(startup.callbackCount, 1);
    assert.equal(accessories.length, 1);
    assert.equal(accessories[0].details.name, "Bedroom");
    const output = entries.join("\n");
    assert.match(output, /capabilities=fanSpeed,power/);
    assert.equal(output.includes(userID), false);
    assert.equal(output.includes(stateMarker), false);
    assert.equal(output.includes(credentialMarker), false);
    assert.equal(output.includes('"user_id"'), false);
    assert.equal(output.includes('"services"'), false);

    platform.getConfig = async () => [accessories[0].details];
    await platform.instantiateAccessories();
    assert.equal(platform.accessories.length, 1);
    assert.equal(startup.callbackCount, 1);
});

test("discovery uses stable device IDs and excludes incomplete device snapshots", async () => {
    const header = [
	'<div id="deviceHeader_101"><div class="name left">Bedroom</div>',
	'<div id="deviceHeader_202"><div class="name left">Bedroom</div>',
	'<div id="deviceHeader_303"><div class="name left">Bedroom</div>'
    ].join("");
    const FakeCloud = baseCloud(instance => {
	instance.doLogin = async function () {
	    this.loggedIn = true;
	    return true;
	};
	instance.getHeaders = async () => header;
	instance.getVista = async deviceID => deviceID === "303" ? null : `vista-${deviceID}`;
    });
    /** Stores the stable device ID supplied by discovery. */
    class Device {
	/** Captures normalized accessory details. */
	constructor(_log, details) { this.details = details; }
    }
    const timers = timerHarness();
    const {log} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: Device,
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {});
    platform.getDeviceStateFromVista = vista => ({
	user_id: `user-${vista}`,
	power: {service_id: 1, value: 1}
    });

    const accessories = await beginAccessories(platform).completed;

    assert.deepEqual(accessories.map(accessory => accessory.details.device_id), ["101", "202"]);
    assert.deepEqual(Object.keys(platform.deviceDictionary), ["101", "202"]);
    assert.equal(platform.lastConfigFetch, undefined);
});

test("runtime settings are normalized before scheduling and parsing", async () => {
    const FakeCloud = baseCloud(instance => {
	instance.doLogin = async () => false;
    });
    const timers = timerHarness();
    const {log} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn,
	maxAuthAttempts: 1
    });
    const platform = new Platform(log, {
	configCacheSeconds: -10,
	defaultTemperature: "not-a-number",
	swingMode: "unexpected"
    });

    await beginAccessories(platform).completed;

    assert.equal(platform.configCacheSeconds, 30);
    assert.equal(platform.defaultCurrentTemp, 0);
    assert.equal(platform.swingMode, "H");
    assert.equal(timers.scheduled[0].milliseconds, 30000);
});

test("platform passes normalized temperature and swing settings to the parser", () => {
    const {log} = recordingLog();
    const Platform = createPlatform({IntesisWebDevice: class Device {}});
    const platform = new Platform(log, {});
    platform.defaultCurrentTemp = 18;
    platform.swingMode = "V";
    const services = platform.getDeviceStateFromVista(`
      <a href="/device/setVal?id=123&uid=1&value=1&userId=456">state</a>
      <script>
        var selectedOnOff = 1;
        var selectedUsermode = 4;
        var selectedfanspeed = 2;
        var selectedhswing = 0;
        var selectedvswing = 10;
      </script>
    `);

    assert.equal(services.currentTemp.value, 18);
    assert.deepEqual(services.swingMode, {service_id: 5, value: 10});
});

test("unexpected initial discovery rejection logs safe metadata and completes startup", async () => {
    const rejectionMarker = "SECRET_REJECTION_MESSAGE";
    const FakeCloud = baseCloud(instance => {
	instance.doLogin = async () => { throw Error(rejectionMarker); };
    });
    const timers = timerHarness();
    const {log, entries} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {});
    const startup = beginAccessories(platform);

    assert.deepEqual(await startup.completed, []);
    assert.equal(startup.callbackCount, 1);
    assert.match(entries.join("\n"), /Initial discovery failed: Error/);
    assert.equal(entries.join("\n").includes(rejectionMarker), false);
});

test("refresh exceptions always reset the guard and a later poll recovers", async () => {
    const errorMarker = "SECRET_REFRESH_ERROR";
    const {log, entries} = recordingLog();
    const timers = timerHarness();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: baseCloud(),
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {});
    platform.configCacheSeconds = 0;
    platform.refreshConfigInProgress = false;
    let updateCount = 0;
    platform.deviceDictionary = {"device-1": {updateData: () => { updateCount += 1; }}};
    let fetchCount = 0;
    platform.getConfig = async () => {
	fetchCount += 1;
	if (fetchCount === 1) throw Error(errorMarker);
	return [{name: "Bedroom", device_id: "device-1"}];
    };

    await platform.refreshConfig("Poll 1");
    assert.equal(platform.refreshConfigInProgress, false);
    await platform.refreshConfig("Poll 2");
    assert.equal(platform.refreshConfigInProgress, false);
    assert.equal(updateCount, 1);
    assert.equal(entries.join("\n").includes(errorMarker), false);

    const token = {timer: true};
    platform.pollingInterval = token;
    platform.shutdown();
    assert.deepEqual(timers.cleared, [token]);
    assert.equal(platform.pollingInterval, null);
});

test("refresh honors cache and overlap guards, handles null snapshots, and delegates writes", async () => {
    let cloud;
    const FakeCloud = baseCloud(instance => {
	cloud = instance;
	instance.setValue = (...args) => args.at(-1)(undefined);
    });
    const timers = timerHarness();
    const {log, entries} = recordingLog();
    const Platform = createPlatform({
	IntesisWebDevice: class Device {},
	CloudClient: FakeCloud,
	setIntervalFn: timers.setIntervalFn,
	clearIntervalFn: timers.clearIntervalFn
    });
    const platform = new Platform(log, {});
    platform.cloud = new FakeCloud();
    platform.configCacheSeconds = 30;
    platform.lastConfigFetch = Date.now();
    platform.getConfig = async () => { throw Error("cache guard failed"); };
    await platform.refreshConfig("Cached poll");
    platform.lastConfigFetch = 0;
    platform.refreshConfigInProgress = true;
    await platform.refreshConfig("Overlapping poll");
    platform.refreshConfigInProgress = false;
    platform.getConfig = async () => null;
    await platform.refreshConfig("Failed poll");

    const writeResult = await new Promise(resolve => {
	platform.setValue("user", "device", 1, 1, resolve);
    });
    assert.equal(writeResult, undefined);
    assert.ok(cloud);
    assert.match(entries.join("\n"), /Using cached data/);
    assert.match(entries.join("\n"), /Refresh in progress/);
    assert.match(entries.join("\n"), /Refresh FAILED/);

    platform.pollingInterval = undefined;
    assert.doesNotThrow(() => platform.shutdown());
});

test("entry point preserves registration identifiers and testing exports", () => {
    const plugin = require("../index");
    let registration;
    plugin({
	hap: {Service: {}, Characteristic: {}},
	/** Captures the plugin's Homebridge registration call. */
	registerPlatform(pluginName, platformName, constructor) {
	    registration = {pluginName, platformName, constructor};
	}
    });
    assert.equal(registration.pluginName, "homebridge-intesisweb");
    assert.equal(registration.platformName, "IntesisWeb");
    assert.equal(typeof registration.constructor, "function");
    assert.equal(typeof plugin._testing.IntesisWebDevice, "function");
    assert.equal(plugin._testing.IntesisWeb, registration.constructor);
});
