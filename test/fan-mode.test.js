/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

// Stub optional network dependencies only while loading the plugin; device
// tests exercise HAP orchestration without creating a cloud client.
const originalLoad = Module._load;
/** Supplies inert cloud modules during plugin module loading. */
Module._load = function (request, parent, isMain) {
    if (request === 'tough-cookie') return {CookieJar: class CookieJar {}};
    if (request === 'got') return {extend: () => {}};
    return originalLoad.call(this, request, parent, isMain);
};
let plugin;
try {
    plugin = require('../index');
}
finally {
    Module._load = originalLoad;
}

/** Creates a mock HAP characteristic type with optional constants. */
function characteristic(name, constants = {}) {
    return Object.assign({name}, constants);
}

const Characteristic = {
    Name: characteristic('Name'),
    ConfiguredName: characteristic('ConfiguredName'),
    Active: characteristic('Active', {INACTIVE: 0, ACTIVE: 1}),
    On: characteristic('On'),
    CurrentHeaterCoolerState: characteristic('CurrentHeaterCoolerState', {INACTIVE: 0, IDLE: 1}),
    CurrentFanState: characteristic('CurrentFanState', {INACTIVE: 0, IDLE: 1, BLOWING_AIR: 2}),
    TargetHeaterCoolerState: characteristic('TargetHeaterCoolerState', {AUTO: 0, HEAT: 1, COOL: 2}),
    RotationSpeed: characteristic('RotationSpeed'),
    CoolingThresholdTemperature: characteristic('CoolingThresholdTemperature'),
    HeatingThresholdTemperature: characteristic('HeatingThresholdTemperature'),
    CurrentTemperature: characteristic('CurrentTemperature'),
    SwingMode: characteristic('SwingMode', {SWING_DISABLED: 0, SWING_ENABLED: 1}),
    Manufacturer: characteristic('Manufacturer'),
    Model: characteristic('Model'),
    SerialNumber: characteristic('SerialNumber')
};

/** Records handlers, properties, and values for one mock characteristic. */
class MockCharacteristic {
    /** Initializes an empty mock characteristic. */
    constructor(type) {
        this.type = type;
        this.handlers = {};
        this.value = undefined;
    }
    /** Registers a HomeKit-style get or set handler. */
    on(event, handler) { this.handlers[event] = handler; return this; }
    /** Records characteristic constraints for assertions. */
    setProps(props) { this.props = props; return this; }
    /** Records the currently published HomeKit value. */
    updateValue(value) { this.value = value; return this; }
}

/** Provides the subset of the HAP Service API used by the plugin. */
class MockService {
    /** Initializes service identity and characteristic storage. */
    constructor(name, subtype) {
        this.name = name;
        this.subtype = subtype;
        this.characteristics = new Map();
        this.linkedServices = [];
    }
    /** Returns a stable characteristic instance for its type. */
    getCharacteristic(type) {
        if (!this.characteristics.has(type)) this.characteristics.set(type, new MockCharacteristic(type));
        return this.characteristics.get(type);
    }
    /** Adds or returns a required characteristic. */
    addCharacteristic(type) { return this.getCharacteristic(type); }
    /** Adds or returns an optional characteristic. */
    addOptionalCharacteristic(type) { return this.getCharacteristic(type); }
    /** Publishes a value to a characteristic. */
    updateCharacteristic(type, value) { this.getCharacteristic(type).updateValue(value); return this; }
    /** Mirrors HAP's fluent initial-value setter. */
    setCharacteristic(type, value) { return this.updateCharacteristic(type, value); }
    /** Records stable service linkage. */
    addLinkedService(service) { this.linkedServices.push(service); return this; }
}

/** Mock HeaterCooler service type. */
class HeaterCooler extends MockService {}
/** Mock Fanv2 service type. */
class Fanv2 extends MockService {}
/** Mock Switch service type. */
class Switch extends MockService {}
/** Mock AccessoryInformation service type. */
class AccessoryInformation extends MockService {}

plugin({
    hap: {Service: {HeaterCooler, Fanv2, Switch, AccessoryInformation}, Characteristic},
    registerPlatform: () => {}
});

const {IntesisWebDevice} = plugin._testing;
/** Silent Homebridge-compatible test logger. */
function log() {}
log.debug = () => {};
log.error = () => {};

/** Builds normalized discovery state with selectable capabilities. */
function deviceDetails({
    power = 0,
    mode = 4,
    fanSpeed = 2,
    supportedModes = [0, 1, 2, 3, 4],
    includeFanSpeed = true,
    setpoint,
    currentTemperature,
    swingServiceID,
    swingValue = 0,
    horizontalSwingValue,
    verticalSwingValue
} = {}) {
    const services = {
        power: {service_id: 1, value: power},
        userMode: {
            service_id: 2,
            value: mode,
            ...(Array.isArray(supportedModes) ? {supported_values: supportedModes} : {})
        }
    };
    if (includeFanSpeed) services.fanSpeed = {service_id: 4, value: fanSpeed};
    if (setpoint !== undefined) services.setpointTemp = {service_id: 9, value: setpoint};
    if (currentTemperature !== undefined) services.currentTemp = {value: currentTemperature};
    if (horizontalSwingValue !== undefined) {
        services.horizontalVanes = {service_id: 6, value: horizontalSwingValue};
    }
    if (verticalSwingValue !== undefined) {
        services.verticalVanes = {service_id: 5, value: verticalSwingValue};
    }
    if (swingServiceID) services.swingMode = {service_id: swingServiceID, value: swingValue};
    return {name: 'Bedroom', device_id: 'device-1', user_id: 'user-1', services};
}

/** Creates a device with a recording callback-style platform transport. */
function makeDevice(options = {}, setValue) {
    const writes = [];
    const platform = {
        /** Records one simulated Intesis write and delegates its completion. */
        setValue(userID, deviceID, serviceID, value, callback) {
            writes.push({userID, deviceID, serviceID, value});
            setValue ? setValue({userID, deviceID, serviceID, value}, callback) : callback();
        }
    };
    return {device: new IntesisWebDevice(log, deviceDetails(options), platform), writes};
}

/** Invokes a mock set handler and reports callback result/count. */
function setCharacteristic(service, type, value) {
    return new Promise(resolve => {
        let callbackCount = 0;
        let resultError;
        service.getCharacteristic(type).handlers.set(value, error => {
            callbackCount += 1;
            resultError = error;
            queueMicrotask(() => resolve({error: resultError, callbackCount}));
        });
    });
}

/** Invokes a mock get handler synchronously. */
function getCharacteristic(service, type) {
    let result;
    service.getCharacteristic(type).handlers.get((error, value) => { result = {error, value}; });
    return result;
}

test('publishes named auxiliary services and links Fan Speed to HeaterCooler', () => {
    const {device} = makeDevice();
    assert.equal(device.fanOnlyService.name, 'Fan Only');
    assert.equal(device.fanOnlyService.subtype, 'fan-only');
    assert.equal(device.dryService.name, 'Dry Mode');
    assert.equal(device.dryService.subtype, 'dry-mode');
    assert.equal(device.fanSpeedService.name, 'Fan Speed');
    assert.equal(device.fanSpeedService.subtype, 'fan-speed');
    assert.equal(device.autoFanSpeedService.name, 'Fan Auto');
    assert.equal(device.autoFanSpeedService.subtype, 'auto-fan-speed');
    for (const [service, expectedName] of [
        [device.fanOnlyService, 'Fan Only'],
        [device.dryService, 'Dry Mode'],
        [device.fanSpeedService, 'Fan Speed'],
        [device.autoFanSpeedService, 'Fan Auto']
    ]) {
        assert.equal(service.getCharacteristic(Characteristic.Name).value, expectedName);
        assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, expectedName);
    }
    assert.deepEqual(device.heaterCoolerService.linkedServices, [device.fanSpeedService]);
    assert.deepEqual(device.getServices(), [
        device.heaterCoolerService,
        device.fanOnlyService,
        device.dryService,
        device.fanSpeedService,
        device.autoFanSpeedService,
        device.accessoryInfoService
    ]);
});

test('capabilities gate auxiliary mode and fan-speed switches', () => {
    const core = makeDevice({supportedModes: null, includeFanSpeed: false}).device;
    const speedOnly = makeDevice({supportedModes: null}).device;
    const fanOnly = makeDevice({supportedModes: [0, 1, 3, 4]}).device;
    assert.equal(core.fanOnlyService, null);
    assert.equal(core.dryService, null);
    assert.equal(core.fanSpeedService, null);
    assert.equal(core.autoFanSpeedService, null);
    assert.deepEqual(core.getServices(), [core.heaterCoolerService, core.accessoryInfoService]);
    assert.equal(speedOnly.fanOnlyService, null);
    assert.equal(speedOnly.dryService, null);
    assert.ok(speedOnly.fanSpeedService);
    assert.ok(speedOnly.autoFanSpeedService);
    assert.deepEqual(speedOnly.heaterCoolerService.linkedServices, [speedOnly.fanSpeedService]);
    assert.deepEqual(speedOnly.getServices(), [
        speedOnly.heaterCoolerService,
        speedOnly.fanSpeedService,
        speedOnly.autoFanSpeedService,
        speedOnly.accessoryInfoService
    ]);
    assert.ok(fanOnly.fanOnlyService);
    assert.equal(fanOnly.dryService, null);
    assert.doesNotThrow(() => core.updateData(deviceDetails({supportedModes: null, includeFanSpeed: false})));
});

test('status getters distinguish native HVAC, fan-only, and dry operation', () => {
    const {device} = makeDevice({power: 1, mode: 4});

    assert.deepEqual(getCharacteristic(device.heaterCoolerService, Characteristic.Active), {
        error: undefined, value: Characteristic.Active.ACTIVE
    });
    assert.deepEqual(getCharacteristic(device.heaterCoolerService, Characteristic.CurrentHeaterCoolerState), {
        error: undefined, value: Characteristic.CurrentHeaterCoolerState.IDLE
    });
    assert.deepEqual(getCharacteristic(device.fanSpeedService, Characteristic.Active), {
        error: undefined, value: Characteristic.Active.ACTIVE
    });
    assert.deepEqual(getCharacteristic(device.fanSpeedService, Characteristic.CurrentFanState), {
        error: undefined, value: Characteristic.CurrentFanState.IDLE
    });
    assert.equal(getCharacteristic(device.autoFanSpeedService, Characteristic.On).value, false);
    device.details.services.fanSpeed.value = 0;
    assert.equal(getCharacteristic(device.autoFanSpeedService, Characteristic.On).value, true);
    device.details.services.userMode.value = 3;
    assert.equal(getCharacteristic(device.heaterCoolerService, Characteristic.Active).value,
        Characteristic.Active.INACTIVE);
    assert.equal(getCharacteristic(device.fanOnlyService, Characteristic.On).value, true);
    assert.equal(getCharacteristic(device.dryService, Characteristic.On).value, false);
    device.details.services.userMode.value = 2;
    assert.equal(getCharacteristic(device.fanOnlyService, Characteristic.On).value, false);
    assert.equal(getCharacteristic(device.dryService, Characteristic.On).value, true);
    device.details.services.power.value = 0;
    assert.equal(getCharacteristic(device.fanSpeedService, Characteristic.Active).value,
        Characteristic.Active.INACTIVE);
    assert.equal(getCharacteristic(device.fanSpeedService, Characteristic.CurrentFanState).value,
        Characteristic.CurrentFanState.INACTIVE);
});

test('native target GET and SET reconcile only after a successful Intesis write', async () => {
    const success = makeDevice({mode: 4});
    assert.equal(getCharacteristic(
        success.device.heaterCoolerService, Characteristic.TargetHeaterCoolerState).value,
    Characteristic.TargetHeaterCoolerState.COOL);

    const result = await setCharacteristic(
        success.device.heaterCoolerService,
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.HEAT);
    assert.equal(result.error, undefined);
    assert.deepEqual(success.writes, [{userID: 'user-1', deviceID: 'device-1', serviceID: 2, value: 1}]);
    assert.equal(success.device.details.services.userMode.value, 1);
    assert.equal(success.device.lastHeaterCoolerTarget, Characteristic.TargetHeaterCoolerState.HEAT);

    const failure = makeDevice({mode: 4}, (_write, callback) => callback(Error('mode failed')));
    const failed = await setCharacteristic(
        failure.device.heaterCoolerService,
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.HEAT);
    assert.match(failed.error.message, /mode failed/);
    assert.equal(failure.device.details.services.userMode.value, 4);
    assert.equal(failure.device.lastHeaterCoolerTarget, Characteristic.TargetHeaterCoolerState.COOL);
});

test('shared setpoint and current-temperature characteristics support GET, SET, and rollback', async () => {
    const success = makeDevice({setpoint: 21.5, currentTemperature: 20.25});
    const cooling = success.device.heaterCoolerService
        .getCharacteristic(Characteristic.CoolingThresholdTemperature);
    const heating = success.device.heaterCoolerService
        .getCharacteristic(Characteristic.HeatingThresholdTemperature);
    assert.deepEqual(cooling.props, {maxValue: 35, minValue: 10, minStep: 1});
    assert.deepEqual(heating.props, {maxValue: 35, minValue: 10, minStep: 1});
    assert.equal(getCharacteristic(
        success.device.heaterCoolerService, Characteristic.CoolingThresholdTemperature).value, 21.5);
    assert.equal(getCharacteristic(
        success.device.heaterCoolerService, Characteristic.HeatingThresholdTemperature).value, 21.5);
    assert.equal(getCharacteristic(
        success.device.heaterCoolerService, Characteristic.CurrentTemperature).value, 20.25);

    assert.equal((await setCharacteristic(
        success.device.heaterCoolerService, Characteristic.CoolingThresholdTemperature, 22.3)).error, undefined);
    assert.equal(success.device.details.services.setpointTemp.value, 22.3);
    assert.deepEqual(success.writes[0], {
        userID: 'user-1', deviceID: 'device-1', serviceID: 9, value: 223
    });

    const failure = makeDevice(
        {setpoint: 21.5, currentTemperature: 20.25},
        (_write, callback) => callback(Error('setpoint failed')));
    const failed = await setCharacteristic(
        failure.device.heaterCoolerService, Characteristic.HeatingThresholdTemperature, 19);
    assert.match(failed.error.message, /setpoint failed/);
    assert.equal(failure.device.details.services.setpointTemp.value, 21.5);
});

test('device mutation helpers fail safely when required state is incomplete', async () => {
    const {device, writes} = makeDevice();
    /** Invokes one direct callback-style device mutation. */
    const invoke = (method, ...args) => new Promise(resolve => method.call(device, ...args, resolve));

    delete device.details.services.power;
    assert.match((await invoke(device.setPhysicalPower, 1, 'user-1', 'device-1')).message, /Power is unavailable/);
    assert.match((await invoke(
        device.setHeaterCoolerActive, Characteristic.Active.ACTIVE, 'user-1', 'device-1')).message,
    /Heater\/Cooler is unavailable/);
    assert.match((await invoke(
        device.setModeActive, true, 3, 'Fan Only', 'user-1', 'device-1')).message,
    /Fan Only mode is unavailable/);
    assert.deepEqual(writes, []);
    assert.doesNotThrow(() => device.updateData(null));
});

test('polling updates temperature characteristics and skips unchanged physical power writes', async () => {
    const {device, writes} = makeDevice({
        power: 1,
        setpoint: 21,
        currentTemperature: 20
    });
    const powerResult = await new Promise(resolve => {
        device.setPhysicalPower(1, 'user-1', 'device-1', resolve);
    });
    assert.equal(powerResult, undefined);
    assert.deepEqual(writes, []);

    device.updateData(deviceDetails({
        power: 1,
        setpoint: 22,
        currentTemperature: 20.5
    }));
    assert.equal(device.heaterCoolerService
        .getCharacteristic(Characteristic.CoolingThresholdTemperature).value, 22);
    assert.equal(device.heaterCoolerService
        .getCharacteristic(Characteristic.HeatingThresholdTemperature).value, 22);
    assert.equal(device.heaterCoolerService
        .getCharacteristic(Characteristic.CurrentTemperature).value, 20.5);
});

test('already-selected native and auxiliary modes write only the required power UID', async () => {
    const native = makeDevice({power: 0, mode: 4});
    const nativeResult = await new Promise(resolve => {
        native.device.setHeaterCoolerActive(
            Characteristic.Active.ACTIVE, 'user-1', 'device-1', resolve);
    });
    assert.equal(nativeResult, undefined);
    assert.deepEqual(native.writes, [
        {userID: 'user-1', deviceID: 'device-1', serviceID: 1, value: 1}
    ]);

    const auxiliary = makeDevice({power: 0, mode: 3});
    const auxiliaryResult = await new Promise(resolve => {
        auxiliary.device.setFanOnlyActive(true, 'user-1', 'device-1', resolve);
    });
    assert.equal(auxiliaryResult, undefined);
    assert.deepEqual(auxiliary.writes, [
        {userID: 'user-1', deviceID: 'device-1', serviceID: 1, value: 1}
    ]);
});

test('publishes named unlinked axis swing switches in stable service order', () => {
    const {device} = makeDevice({
        horizontalSwingValue: 10,
        verticalSwingValue: 0,
        swingServiceID: 6,
        swingValue: 10
    });
    assert.equal(device.horizontalSwingService.name, 'Horizontal Swing');
    assert.equal(device.horizontalSwingService.subtype, 'horizontal-swing');
    assert.equal(device.verticalSwingService.name, 'Vertical Swing');
    assert.equal(device.verticalSwingService.subtype, 'vertical-swing');
    for (const [service, expectedName] of [
        [device.horizontalSwingService, 'Horizontal Swing'],
        [device.verticalSwingService, 'Vertical Swing']
    ]) {
        assert.equal(service.getCharacteristic(Characteristic.Name).value, expectedName);
        assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, expectedName);
    }
    assert.deepEqual(device.heaterCoolerService.linkedServices, [device.fanSpeedService]);
    assert.deepEqual(device.getServices(), [
        device.heaterCoolerService,
        device.fanOnlyService,
        device.dryService,
        device.fanSpeedService,
        device.autoFanSpeedService,
        device.horizontalSwingService,
        device.verticalSwingService,
        device.accessoryInfoService
    ]);
});

test('axis swing capabilities independently gate their switch services', () => {
    const neither = makeDevice().device;
    const horizontal = makeDevice({horizontalSwingValue: 0}).device;
    const vertical = makeDevice({verticalSwingValue: 10}).device;
    assert.equal(neither.horizontalSwingService, null);
    assert.equal(neither.verticalSwingService, null);
    assert.ok(horizontal.horizontalSwingService);
    assert.equal(horizontal.verticalSwingService, null);
    assert.equal(vertical.horizontalSwingService, null);
    assert.ok(vertical.verticalSwingService);
    assert.deepEqual(horizontal.getServices().slice(-2), [
        horizontal.horizontalSwingService,
        horizontal.accessoryInfoService
    ]);
    assert.deepEqual(vertical.getServices().slice(-2), [
        vertical.verticalSwingService,
        vertical.accessoryInfoService
    ]);
});

test('polling reconciles mutually exclusive native, fan-only, and dry activity', () => {
    const {device} = makeDevice({power: 1, mode: 4});
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, false);

    device.updateData(deviceDetails({power: 1, mode: 3}));
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, true);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, false);

    device.updateData(deviceDetails({power: 1, mode: 2}));
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, true);

    device.updateData(deviceDetails({power: 1, mode: 1}));
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, false);
});

for (const [label, property, rawMode] of [
    ['Fan Only', 'fanOnlyService', 3],
    ['Dry Mode', 'dryService', 2]
]) {
    test(`${label} ON selects its mode before powering on`, async () => {
        const {device, writes} = makeDevice({power: 0, mode: 4});
        const result = await setCharacteristic(device[property], Characteristic.On, true);
        assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, rawMode], [1, 1]]);
        assert.equal(result.callbackCount, 1);
        assert.equal(device.details.services.userMode.value, rawMode);
        assert.equal(device.details.services.power.value, 1);
        assert.equal(device[property].getCharacteristic(Characteristic.On).value, true);
        assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);
    });

    test(`${label} reconciles a successful mode write when power-on fails`, async () => {
        const powerError = Error('power failed');
        const {device, writes} = makeDevice({power: 0, mode: 4}, ({serviceID}, callback) => {
            callback(serviceID === 1 ? powerError : undefined);
        });
        const result = await setCharacteristic(device[property], Characteristic.On, true);
        assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, rawMode], [1, 1]]);
        assert.equal(result.error, powerError);
        assert.equal(result.callbackCount, 1);
        assert.equal(device.details.services.userMode.value, rawMode);
        assert.equal(device.details.services.power.value, 0);
        assert.equal(device[property].getCharacteristic(Characteristic.On).value, false);
    });

    test(`${label} mode-write failure prevents the power-on write`, async () => {
        const modeError = Error('mode failed');
        const {device, writes} = makeDevice({power: 0, mode: 4}, ({serviceID}, callback) => {
            callback(serviceID === 2 ? modeError : undefined);
        });
        const result = await setCharacteristic(device[property], Characteristic.On, true);

        assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, rawMode]]);
        assert.equal(result.error, modeError);
        assert.equal(result.callbackCount, 1);
        assert.equal(device.details.services.userMode.value, 4);
        assert.equal(device.details.services.power.value, 0);
        assert.equal(device[property].getCharacteristic(Characteristic.On).value, false);
    });

    test(`${label} OFF powers down only while its cached mode remains selected`, async () => {
        const active = makeDevice({power: 1, mode: rawMode});
        const activeResult = await setCharacteristic(active.device[property], Characteristic.On, false);
        assert.deepEqual(active.writes.map(({serviceID, value}) => [serviceID, value]), [[1, 0]]);
        assert.equal(activeResult.callbackCount, 1);

        const stale = makeDevice({power: 1, mode: 4});
        const staleResult = await setCharacteristic(stale.device[property], Characteristic.On, false);
        assert.deepEqual(stale.writes, []);
        assert.equal(staleResult.callbackCount, 1);
        assert.equal(stale.device.details.services.power.value, 1);
    });
}

test('concurrent Fan Only then Dry commands run FIFO and leave the final Dry state', async () => {
    const {device, writes} = makeDevice({power: 0, mode: 4});

    const fanResult = setCharacteristic(device.fanOnlyService, Characteristic.On, true);
    const dryResult = setCharacteristic(device.dryService, Characteristic.On, true);
    const [fan, dry] = await Promise.all([fanResult, dryResult]);

    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [
        [2, 3],
        [1, 1],
        [2, 2]
    ]);
    assert.equal(fan.callbackCount, 1);
    assert.equal(dry.callbackCount, 1);
    assert.equal(device.details.services.power.value, 1);
    assert.equal(device.details.services.userMode.value, 2);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, true);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);
});

test('FIFO continues after a failed command and a synchronous command exception', async () => {
    const modeError = Error('fan mode failed');
    const {device, writes} = makeDevice({power: 0, mode: 4}, ({serviceID, value}, callback) => {
        callback(serviceID === 2 && value === 3 ? modeError : undefined);
    });

    const fanResult = setCharacteristic(device.fanOnlyService, Characteristic.On, true);
    const exceptionResult = new Promise(resolve => {
        device.enqueueMutation(() => { throw Error('queued exception'); }, error => resolve(error));
    });
    const dryResult = setCharacteristic(device.dryService, Characteristic.On, true);
    const [fan, exception, dry] = await Promise.all([fanResult, exceptionResult, dryResult]);

    assert.equal(fan.error, modeError);
    assert.match(exception.message, /queued exception/);
    assert.equal(dry.error, undefined);
    assert.equal(fan.callbackCount, 1);
    assert.equal(dry.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [
        [2, 3],
        [2, 2],
        [1, 1]
    ]);
    assert.equal(device.details.services.userMode.value, 2);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, true);
});

test('native target selection turns both auxiliary mode switches off', async () => {
    const {device, writes} = makeDevice({power: 1, mode: 3});
    const result = await setCharacteristic(
        device.heaterCoolerService,
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.HEAT);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, 1]]);
    assert.equal(result.callbackCount, 1);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.dryService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
});

test('HeaterCooler ACTIVE restores the last native target before powering on', async () => {
    const {device, writes} = makeDevice({power: 1, mode: 4});
    device.updateData(deviceDetails({power: 0, mode: 3}));
    const result = await setCharacteristic(device.heaterCoolerService, Characteristic.Active, Characteristic.Active.ACTIVE);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, 4], [1, 1]]);
    assert.equal(result.callbackCount, 1);
    assert.equal(device.details.services.userMode.value, 4);
    assert.equal(device.details.services.power.value, 1);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, false);
});

test('HeaterCooler restore failure does not attempt power-on', async () => {
    const modeError = Error('mode failed');
    const {device, writes} = makeDevice({power: 0, mode: 3}, (_write, callback) => callback(modeError));
    const result = await setCharacteristic(device.heaterCoolerService, Characteristic.Active, Characteristic.Active.ACTIVE);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[2, 0]]);
    assert.equal(result.error, modeError);
    assert.equal(result.callbackCount, 1);
    assert.equal(device.details.services.userMode.value, 3);
    assert.equal(device.details.services.power.value, 0);
});

test('HeaterCooler INACTIVE cannot power down cached auxiliary modes', async () => {
    for (const mode of [2, 3]) {
        const {device, writes} = makeDevice({power: 1, mode});
        const result = await setCharacteristic(device.heaterCoolerService, Characteristic.Active, Characteristic.Active.INACTIVE);
        assert.deepEqual(writes, []);
        assert.equal(result.callbackCount, 1);
        assert.equal(device.details.services.power.value, 1);
    }
});

test('HeaterCooler INACTIVE powers down a native mode', async () => {
    const {device, writes} = makeDevice({power: 1, mode: 1});
    const result = await setCharacteristic(device.heaterCoolerService, Characteristic.Active, Characteristic.Active.INACTIVE);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[1, 0]]);
    assert.equal(result.callbackCount, 1);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);
});

test('RotationSpeed exposes four nonzero manual levels and retains them while auto or off', () => {
    const {device} = makeDevice({power: 1, fanSpeed: 0});
    const speed = device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed);
    assert.deepEqual(speed.props, {maxValue: 100, minValue: 25, minStep: 25});
    assert.equal(speed.value, 25);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, true);
    for (const [raw, display] of [[1, 25], [2, 50], [3, 75], [4, 100]]) {
        device.updateData(deviceDetails({power: 1, fanSpeed: raw}));
        assert.equal(speed.value, display);
        assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);
    }
    device.updateData(deviceDetails({power: 0, fanSpeed: 0}));
    assert.equal(speed.value, 100);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, true);
    assert.deepEqual(getCharacteristic(device.fanSpeedService, Characteristic.RotationSpeed),
        {error: undefined, value: 100});
    assert.equal(device.heaterCoolerService.characteristics.has(Characteristic.RotationSpeed), false);
});

test('Fan Speed Active mirrors HVAC power but every requested toggle is a no-op', async () => {
    const {device, writes} = makeDevice({power: 1, mode: 4, fanSpeed: 2});
    const fanActive = device.fanSpeedService.getCharacteristic(Characteristic.Active);
    const currentState = device.fanSpeedService.getCharacteristic(Characteristic.CurrentFanState);
    assert.equal(fanActive.value, Characteristic.Active.ACTIVE);
    assert.equal(currentState.value, Characteristic.CurrentFanState.IDLE);

    const off = await setCharacteristic(device.fanSpeedService, Characteristic.Active, Characteristic.Active.INACTIVE);
    assert.equal(off.error, undefined);
    assert.equal(off.callbackCount, 1);
    assert.deepEqual(writes, []);
    assert.equal(device.details.services.power.value, 1);
    assert.equal(device.details.services.userMode.value, 4);
    assert.equal(fanActive.value, Characteristic.Active.ACTIVE);

    device.updateData(deviceDetails({power: 0, mode: 4, fanSpeed: 2}));
    assert.equal(fanActive.value, Characteristic.Active.INACTIVE);
    assert.equal(currentState.value, Characteristic.CurrentFanState.INACTIVE);
    const on = await setCharacteristic(device.fanSpeedService, Characteristic.Active, Characteristic.Active.ACTIVE);
    assert.equal(on.error, undefined);
    assert.equal(on.callbackCount, 1);
    assert.deepEqual(writes, []);
    assert.equal(device.details.services.power.value, 0);
    assert.equal(device.details.services.userMode.value, 4);
    assert.equal(fanActive.value, Characteristic.Active.INACTIVE);
});

test('Fan Speed RotationSpeed maps percentages to Intesis manual levels', async () => {
    for (const [percentage, raw] of [[25, 1], [50, 2], [75, 3], [100, 4]]) {
        const {device, writes} = makeDevice({power: 1, fanSpeed: 0});
        const result = await setCharacteristic(device.fanSpeedService, Characteristic.RotationSpeed, percentage);
        assert.equal(result.callbackCount, 1);
        assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, raw]]);
        assert.equal(device.details.services.fanSpeed.value, raw);
        assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, percentage);
        assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);
    }
});

test('RotationSpeed while physically off updates raw speed without powering on', async () => {
    const {device, writes} = makeDevice({power: 0, fanSpeed: 0});
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, true);

    const result = await setCharacteristic(device.fanSpeedService, Characteristic.RotationSpeed, 75);

    assert.equal(result.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, 3]]);
    assert.equal(device.details.services.power.value, 0);
    assert.equal(device.details.services.fanSpeed.value, 3);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 75);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);

    device.updateData(deviceDetails({power: 1, fanSpeed: 3}));
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 75);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
});

test('RotationSpeed rejects zero without writing fan speed or physical power', async () => {
    const {device, writes} = makeDevice({power: 1, mode: 3, fanSpeed: 2});
    const result = await setCharacteristic(device.fanSpeedService, Characteristic.RotationSpeed, 0);
    assert.match(result.error.message, /between 25% and 100%/);
    assert.equal(result.callbackCount, 1);
    assert.deepEqual(writes, []);
    assert.equal(device.details.services.power.value, 1);
    assert.equal(device.details.services.fanSpeed.value, 2);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 50);
    assert.equal(device.fanOnlyService.getCharacteristic(Characteristic.On).value, true);
});

test('Automatic Fan Speed writes raw auto and restores retained manual speed', async () => {
    const {device, writes} = makeDevice({power: 1, fanSpeed: 3});
    const on = await setCharacteristic(device.autoFanSpeedService, Characteristic.On, true);
    assert.equal(on.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, 0]]);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 75);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, true);

    const off = await setCharacteristic(device.autoFanSpeedService, Characteristic.On, false);
    assert.equal(off.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, 0], [4, 3]]);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 75);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);
});

test('Automatic Fan Speed cold-start manual fallback is raw1/display25', async () => {
    const {device, writes} = makeDevice({power: 1, fanSpeed: 0});
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 25);
    await setCharacteristic(device.autoFanSpeedService, Characteristic.On, false);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, 1]]);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 25);
});

test('manual RotationSpeed turns Automatic Fan Speed off without changing power', async () => {
    const {device, writes} = makeDevice({power: 1, fanSpeed: 0});
    const result = await setCharacteristic(device.fanSpeedService, Characteristic.RotationSpeed, 100);
    assert.equal(result.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[4, 4]]);
    assert.equal(device.details.services.power.value, 1);
    assert.equal(device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 100);
    assert.equal(device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);
});

test('failed fan-speed writes preserve retained manual and automatic state', async () => {
    const writeError = Error('write failed');
    const speed = makeDevice({power: 1, fanSpeed: 2}, (_write, callback) => callback(writeError));
    const speedResult = await setCharacteristic(speed.device.autoFanSpeedService, Characteristic.On, true);
    assert.equal(speedResult.error, writeError);
    assert.equal(speed.device.details.services.fanSpeed.value, 2);
    assert.equal(speed.device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 50);
    assert.equal(speed.device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, false);

    const manual = makeDevice({power: 1, fanSpeed: 0}, (_write, callback) => callback(writeError));
    const manualResult = await setCharacteristic(manual.device.fanSpeedService, Characteristic.RotationSpeed, 100);
    assert.equal(manualResult.error, writeError);
    assert.equal(manual.device.details.services.power.value, 1);
    assert.equal(manual.device.details.services.fanSpeed.value, 0);
    assert.equal(manual.device.fanSpeedService.getCharacteristic(Characteristic.RotationSpeed).value, 25);
    assert.equal(manual.device.autoFanSpeedService.getCharacteristic(Characteristic.On).value, true);
});

for (const [axis, serviceID] of [['horizontal', 6], ['vertical', 5]]) {
    test(`${axis} SwingMode writes its Intesis UID and follows polling`, async () => {
        const {device, writes} = makeDevice({
            horizontalSwingValue: 0,
            verticalSwingValue: 0,
            swingServiceID: serviceID,
            swingValue: 0
        });
        const result = await setCharacteristic(
            device.heaterCoolerService,
            Characteristic.SwingMode,
            Characteristic.SwingMode.SWING_ENABLED);
        assert.equal(result.callbackCount, 1);
        assert.deepEqual(writes.map(({serviceID: id, value}) => [id, value]), [[serviceID, 10]]);
        const selectedService = axis === 'horizontal'
            ? device.horizontalSwingService
            : device.verticalSwingService;
        const otherService = axis === 'horizontal'
            ? device.verticalSwingService
            : device.horizontalSwingService;
        assert.equal(selectedService.getCharacteristic(Characteristic.On).value, true);
        assert.equal(otherService.getCharacteristic(Characteristic.On).value, false);
        device.updateData(deviceDetails({
            horizontalSwingValue: 0,
            verticalSwingValue: 0,
            swingServiceID: serviceID,
            swingValue: 0
        }));
        assert.deepEqual(getCharacteristic(device.heaterCoolerService, Characteristic.SwingMode),
            {error: undefined, value: Characteristic.SwingMode.SWING_DISABLED});
        assert.equal(selectedService.getCharacteristic(Characteristic.On).value, false);
        assert.equal(otherService.getCharacteristic(Characteristic.On).value, false);
    });
}

for (const [axisName, property, serviceID] of [
    ['horizontalVanes', 'horizontalSwingService', 6],
    ['verticalVanes', 'verticalSwingService', 5]
]) {
    test(`${axisName} switch GET/SET uses only its parsed Intesis UID`, async () => {
        const options = {
            horizontalSwingValue: axisName === 'horizontalVanes' ? 0 : 10,
            verticalSwingValue: axisName === 'verticalVanes' ? 0 : 10
        };
        const {device, writes} = makeDevice(options);
        const otherAxis = axisName === 'horizontalVanes' ? 'verticalVanes' : 'horizontalVanes';
        const otherValue = device.details.services[otherAxis].value;
        assert.deepEqual(getCharacteristic(device[property], Characteristic.On),
            {error: undefined, value: false});

        const result = await setCharacteristic(device[property], Characteristic.On, true);

        assert.equal(result.callbackCount, 1);
        assert.deepEqual(writes.map(({serviceID: id, value}) => [id, value]), [[serviceID, 10]]);
        assert.equal(device.details.services[axisName].value, 10);
        assert.equal(device.details.services[otherAxis].value, otherValue);
        assert.equal(device[property].getCharacteristic(Characteristic.On).value, true);
    });
}

test('failed axis swing write preserves cached and published state and completes once', async () => {
    const writeError = Error('axis write failed');
    const {device, writes} = makeDevice({horizontalSwingValue: 0}, (_write, callback) => {
        callback(writeError);
        callback();
    });

    const result = await setCharacteristic(device.horizontalSwingService, Characteristic.On, true);

    assert.equal(result.error, writeError);
    assert.equal(result.callbackCount, 1);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [[6, 10]]);
    assert.equal(device.details.services.horizontalVanes.value, 0);
    assert.equal(device.horizontalSwingService.getCharacteristic(Characteristic.On).value, false);
});

test('polling synchronizes both axis switches without cross-axis mutation', () => {
    const {device} = makeDevice({
        horizontalSwingValue: 0,
        verticalSwingValue: 10,
        swingServiceID: 6,
        swingValue: 0
    });

    device.updateData(deviceDetails({
        horizontalSwingValue: 10,
        verticalSwingValue: 0,
        swingServiceID: 6,
        swingValue: 10
    }));

    assert.equal(device.horizontalSwingService.getCharacteristic(Characteristic.On).value, true);
    assert.equal(device.verticalSwingService.getCharacteristic(Characteristic.On).value, false);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).value,
        Characteristic.SwingMode.SWING_ENABLED);
});

test('generic and axis swing controls synchronize bidirectionally only for matching UID', async () => {
    const {device, writes} = makeDevice({
        horizontalSwingValue: 0,
        verticalSwingValue: 0,
        swingServiceID: 6,
        swingValue: 0
    });

    await setCharacteristic(
        device.heaterCoolerService,
        Characteristic.SwingMode,
        Characteristic.SwingMode.SWING_ENABLED);
    assert.equal(device.details.services.horizontalVanes.value, 10);
    assert.equal(device.details.services.verticalVanes.value, 0);
    assert.equal(device.horizontalSwingService.getCharacteristic(Characteristic.On).value, true);
    assert.equal(device.verticalSwingService.getCharacteristic(Characteristic.On).value, false);

    await setCharacteristic(device.horizontalSwingService, Characteristic.On, false);
    assert.equal(device.details.services.swingMode.value, 0);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).value,
        Characteristic.SwingMode.SWING_DISABLED);

    await setCharacteristic(device.verticalSwingService, Characteristic.On, true);
    assert.equal(device.details.services.verticalVanes.value, 10);
    assert.equal(device.details.services.horizontalVanes.value, 0);
    assert.equal(device.details.services.swingMode.value, 0);
    assert.equal(device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).value,
        Characteristic.SwingMode.SWING_DISABLED);
    assert.deepEqual(writes.map(({serviceID, value}) => [serviceID, value]), [
        [6, 10],
        [6, 0],
        [5, 10]
    ]);
});
