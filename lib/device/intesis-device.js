/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {MutationQueue} = require("./mutation-queue");
const {createMappings, isNativeMode} = require("./mappings");
const {
    createAuxiliaryModeServices,
    setupAuxiliaryModeHandlers
} = require("../features/auxiliary-modes");
const {createFanSpeedServices, setupFanSpeed} = require("../features/fan-speed");
const {
    setupPower,
    setupUserMode,
    setupSetpoint,
    setupCurrentTemperature
} = require("../features/heater-cooler");
const {createSwingServices, setupAxisSwing, setupSwing} = require("../features/swing");

/** Creates the accessory constructor bound to Homebridge's HAP classes. */
function createIntesisWebDevice({Service, Characteristic}) {
    /** Builds one Intesis accessory and its stable HomeKit service graph. */
    function IntesisWebDevice(log, details, platform) {
	this.Service = Service;
	this.Characteristic = Characteristic;
	this.dataMap = createMappings(Characteristic);
	this.log = log;
	this.details = details;
	this.platform = platform;
	this.name = details.name;
	this.heaterCoolerService = new Service.HeaterCooler(details.name);
	Object.assign(this, createAuxiliaryModeServices(details, Service, Characteristic));
	Object.assign(this, createFanSpeedServices(details, Service, Characteristic));
	Object.assign(this, createSwingServices(details, Service, Characteristic));
	this.accessoryInfoService = new Service.AccessoryInformation();
	this.accessoryInfoService
	    .setCharacteristic(Characteristic.Manufacturer, "Intesis")
	    .setCharacteristic(Characteristic.Model, details.name)
	    .setCharacteristic(Characteristic.SerialNumber, details.device_id);

	// Service order, names, subtypes, and linkage are persistent HomeKit
	// identity. Keep this ordering stable across refactors and upgrades.
	this.services = [this.heaterCoolerService];
	if (this.fanOnlyService) this.services.push(this.fanOnlyService);
	if (this.dryService) this.services.push(this.dryService);
	if (this.fanSpeedService) {
	    this.services.push(this.fanSpeedService);
	    this.heaterCoolerService.addLinkedService(this.fanSpeedService);
	}
	if (this.autoFanSpeedService) this.services.push(this.autoFanSpeedService);
	// Axis switches are deliberately unlinked so Apple Home renders separate
	// tiles. Their position before AccessoryInformation is part of identity.
	if (this.horizontalSwingService) this.services.push(this.horizontalSwingService);
	if (this.verticalSwingService) this.services.push(this.verticalSwingService);
	this.services.push(this.accessoryInfoService);

	const initialFanSpeed = details.services && details.services.fanSpeed
	    ? details.services.fanSpeed.value
	    : 0;
	this.lastManualFanRaw = initialFanSpeed >= 1 && initialFanSpeed <= 4 ? initialFanSpeed : 1;
	this.fanSpeedConfigured = false;
	this.mutationQueue = new MutationQueue();
	this.commandQueue = this.mutationQueue.tail;
	const initialTarget = details.services && details.services.userMode
	    ? this.dataMap.userMode.homekit(details.services.userMode.value)
	    : undefined;
	// Dry and fan-only have no HeaterCooler target; retain the last native
	// auto/heat/cool target so reactivating HeaterCooler is deterministic.
	this.lastHeaterCoolerTarget = initialTarget !== undefined
	    ? initialTarget
	    : Characteristic.TargetHeaterCoolerState.AUTO;
	this.setup(this.details);
    }

    /** Wires characteristics for every capability reported at discovery. */
    IntesisWebDevice.prototype.setup = function (details) {
	const services = details.services;
	const deviceID = details.device_id;
	const userID = details.user_id;
	for (const serviceName in services) {
	    this.addService(serviceName, services[serviceName], userID, deviceID);
	}
    };

    /** Returns services in their persistent HomeKit identity order. */
    IntesisWebDevice.prototype.getServices = function () {
	return this.services;
    };

    /** Adds a mutation to the per-device callback-once FIFO. */
    IntesisWebDevice.prototype.enqueueMutation = function (action, callback) {
	this.mutationQueue.enqueue(action, callback);
	this.commandQueue = this.mutationQueue.tail;
    };

    /** Reports whether an Intesis mode has a native HeaterCooler target. */
    IntesisWebDevice.prototype.isNativeMode = isNativeMode;

    /** Reconciles cached Intesis state across all exposed HomeKit services. */
    IntesisWebDevice.prototype.updateOperatingState = function () {
	const services = this.details && this.details.services;
	if (!services || !services.power || !services.userMode) return;
	const powered = services.power.value === 1;
	const heaterCoolerActive = powered && this.isNativeMode(services.userMode.value);
	const fanActive = powered && services.userMode.value === 3;
	const dryActive = powered && services.userMode.value === 2;
	this.heaterCoolerService
	    .updateCharacteristic(Characteristic.Active,
		heaterCoolerActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
	    .updateCharacteristic(Characteristic.CurrentHeaterCoolerState,
		heaterCoolerActive
		    ? Characteristic.CurrentHeaterCoolerState.IDLE
		    : Characteristic.CurrentHeaterCoolerState.INACTIVE);
	if (this.fanOnlyService) this.fanOnlyService.updateCharacteristic(Characteristic.On, fanActive);
	if (this.dryService) this.dryService.updateCharacteristic(Characteristic.On, dryActive);
	this.updateFanServicePowerState();
	if (this.fanSpeedConfigured) this.updateFanSpeedState(services.fanSpeed && services.fanSpeed.value);
    };

    /** Writes physical power only when the cached value actually changes. */
    IntesisWebDevice.prototype.setPhysicalPower = function (powerValue, userID, deviceID, callback) {
	let completed = false;
	/** Delivers the transport result once. */
	const done = err => {
	    if (completed) return;
	    completed = true;
	    callback(err);
	};
	const services = this.details && this.details.services;
	if (!services || !services.power) {
	    done(Error("Power is unavailable because device state is incomplete."));
	    return;
	}
	if (services.power.value === powerValue) {
	    this.updateOperatingState();
	    done();
	    return;
	}
	this.platform.setValue(userID, deviceID, services.power.service_id, powerValue, err => {
	    if (!err) services.power.value = powerValue;
	    this.updateOperatingState();
	    done(err);
	});
    };

    /** Activates native HVAC state, restoring its retained target when needed. */
    IntesisWebDevice.prototype.setHeaterCoolerActive = function (value, userID, deviceID, callback) {
	let completed = false;
	/** Collapses restore and power branches to one completion. */
	const done = err => {
	    if (completed) return;
	    completed = true;
	    callback(err);
	};
	const services = this.details && this.details.services;
	if (!services || !services.power || !services.userMode) {
	    done(Error("Heater/Cooler is unavailable because device state is incomplete."));
	    return;
	}
	const active = value === Characteristic.Active.ACTIVE;
	if (!active) {
	    if (!this.isNativeMode(services.userMode.value)) {
		this.updateOperatingState();
		done();
		return;
	    }
	    this.setPhysicalPower(0, userID, deviceID, done);
	    return;
	}

	/** Continues with power only after target restoration succeeds. */
	const ensurePowerOn = () => this.setPhysicalPower(1, userID, deviceID, done);
	if (this.isNativeMode(services.userMode.value)) {
	    ensurePowerOn();
	    return;
	}
	const nativeMode = this.dataMap.userMode.intesis(this.lastHeaterCoolerTarget);
	this.platform.setValue(userID, deviceID, services.userMode.service_id, nativeMode, err => {
	    if (err) {
		this.updateOperatingState();
		done(err);
		return;
	    }
	    services.userMode.value = nativeMode;
	    this.updateOperatingState();
	    ensurePowerOn();
	});
    };

    /** Selects an auxiliary mode and sequences mode before power-on. */
    IntesisWebDevice.prototype.setModeActive = function (active, intesisMode, modeName, userID, deviceID, callback) {
	let completed = false;
	/** Collapses mode and power branches to one completion. */
	const done = err => {
	    if (completed) return;
	    completed = true;
	    callback(err);
	};
	const services = this.details && this.details.services;
	if (!services || !services.power || !services.userMode) {
	    done(Error(`${modeName} mode is unavailable because device state is incomplete.`));
	    return;
	}
	/** Applies power after the selected auxiliary mode is cached. */
	const writePowerOn = () => {
	    if (services.power.value === 1) {
		this.updateOperatingState();
		done();
		return;
	    }
	    this.platform.setValue(userID, deviceID, services.power.service_id, 1, err => {
		if (!err) services.power.value = 1;
		this.updateOperatingState();
		done(err);
	    });
	};
	if (active) {
	    if (services.userMode.value === intesisMode) {
		writePowerOn();
		return;
	    }
	    this.platform.setValue(userID, deviceID, services.userMode.service_id, intesisMode, err => {
		if (err) {
		    this.updateOperatingState();
		    done(err);
		    return;
		}
		services.userMode.value = intesisMode;
		this.updateOperatingState();
		writePowerOn();
	    });
	    return;
	}
	if (services.userMode.value !== intesisMode || services.power.value !== 1) {
	    this.updateOperatingState();
	    done();
	    return;
	}
	this.platform.setValue(userID, deviceID, services.power.service_id, 0, err => {
	    if (!err) services.power.value = 0;
	    this.updateOperatingState();
	    done(err);
	});
    };

    /** Toggles fan-only through the shared auxiliary-mode sequencer. */
    IntesisWebDevice.prototype.setFanOnlyActive = function (value, userID, deviceID, callback) {
	this.setModeActive(Boolean(value), 3, "Fan Only", userID, deviceID, callback);
    };

    /** Toggles dry mode through the shared auxiliary-mode sequencer. */
    IntesisWebDevice.prototype.setDryActive = function (value, userID, deviceID, callback) {
	this.setModeActive(Boolean(value), 2, "Dry", userID, deviceID, callback);
    };

    /** Mirrors physical HVAC power onto the linked Fanv2 status only. */
    IntesisWebDevice.prototype.updateFanServicePowerState = function () {
	if (!this.fanSpeedService) return;
	const services = this.details && this.details.services;
	const powered = Boolean(services && services.power && services.power.value === 1);
	this.fanSpeedService.updateCharacteristic(
	    Characteristic.Active,
	    powered ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
	if (Characteristic.CurrentFanState) {
	    this.fanSpeedService.updateCharacteristic(
		Characteristic.CurrentFanState,
		powered ? Characteristic.CurrentFanState.IDLE : Characteristic.CurrentFanState.INACTIVE);
	}
    };

    /** Retains the last manual speed while separately reflecting raw auto mode. */
    IntesisWebDevice.prototype.updateFanSpeedState = function (rawValue) {
	if (rawValue >= 1 && rawValue <= 4) this.lastManualFanRaw = rawValue;
	this.fanSpeedService.updateCharacteristic(
	    Characteristic.RotationSpeed,
	    this.dataMap.fanSpeed.homekit(this.lastManualFanRaw));
	if (this.autoFanSpeedService) {
	    this.autoFanSpeedService.updateCharacteristic(Characteristic.On, rawValue === 0);
	}
    };

    /** Writes one raw fan level and reconciles cache only after success. */
    IntesisWebDevice.prototype.writeFanSpeedRaw = function (rawValue, userID, deviceID, serviceID, callback) {
	this.platform.setValue(userID, deviceID, serviceID, rawValue, err => {
	    if (!err) {
		if (this.details.services) this.details.services.fanSpeed.value = rawValue;
		this.updateFanSpeedState(rawValue);
	    }
	    callback(err);
	});
    };

    /** Validates and writes a nonzero manual fan percentage. */
    IntesisWebDevice.prototype.setFanSpeedValue = function (value, userID, deviceID, serviceID, callback) {
	const percentage = Number(value);
	// RotationSpeed zero is a HomeKit power gesture; rejecting it prevents the
	// manual-speed service from becoming another physical power control.
	if (!Number.isFinite(percentage) || percentage < 25 || percentage > 100) {
	    callback(Error("Manual fan speed must be between 25% and 100%."));
	    return;
	}
	this.writeFanSpeedRaw(
	    this.dataMap.fanSpeed.intesis(percentage), userID, deviceID, serviceID, callback);
    };

    /** Enables raw auto speed or restores the retained manual raw level. */
    IntesisWebDevice.prototype.setAutomaticFanSpeed = function (value, userID, deviceID, serviceID, callback) {
	this.writeFanSpeedRaw(
	    value ? 0 : this.lastManualFanRaw, userID, deviceID, serviceID, callback);
    };

    /** Publishes one cached axis and mirrors the generic control when UIDs match. */
    IntesisWebDevice.prototype.updateAxisSwingState = function (axisName, rawValue) {
	const services = this.details && this.details.services;
	if (!services) return;
	const axis = services[axisName];
	const axisService = axisName === "horizontalVanes"
	    ? this.horizontalSwingService
	    : this.verticalSwingService;
	if (axisService) axisService.updateCharacteristic(Characteristic.On, rawValue === 10);
	if (axis && services.swingMode && axis.service_id === services.swingMode.service_id) {
	    services.swingMode.value = rawValue === 10 ? 10 : 0;
	    this.heaterCoolerService.updateCharacteristic(
		Characteristic.SwingMode,
		this.dataMap.swingMode.homekit(services.swingMode.value));
	}
    };

    /** Mirrors a generic SwingMode value onto the one axis with the same UID. */
    IntesisWebDevice.prototype.updateSwingAxisStateByServiceID = function (serviceID, rawValue) {
	const services = this.details && this.details.services;
	if (!services) return;
	for (const axisName of ["horizontalVanes", "verticalVanes"]) {
	    const axis = services[axisName];
	    if (axis && axis.service_id === serviceID) {
		axis.value = rawValue;
		this.updateAxisSwingState(axisName, rawValue);
		return;
	    }
	}
    };

    /** Applies one normalized polling snapshot to cached and HomeKit state. */
    IntesisWebDevice.prototype.updateData = function (newDetails) {
	if (!newDetails || !newDetails.services) {
	    this.log.debug(`${this.name}: Skipping update (no services data)`);
	    return;
	}
	const oldDetails = this.details;
	this.details = newDetails;
	const services = newDetails.services;
	for (const serviceName in services) {
	    const value = services[serviceName].value;
	    const oldValue = oldDetails.services ? oldDetails.services[serviceName]?.value : null;
	    const changed = oldValue !== null && oldValue !== value;
	    switch (serviceName) {
		case "power":
		    this.updateOperatingState();
		    if (changed) {
			this.log(`${this.name}: Power changed: ${this.dataMap.power.homekit[oldValue]} → ${this.dataMap.power.homekit[value]}`);
		    }
		    break;
		case "userMode": {
		    const target = this.dataMap.userMode.homekit(value);
		    // Auxiliary dry/fan modes intentionally leave the retained native
		    // HeaterCooler target untouched.
		    if (target !== undefined) {
			this.lastHeaterCoolerTarget = target;
			this.heaterCoolerService.updateCharacteristic(Characteristic.TargetHeaterCoolerState, target);
		    }
		    this.updateOperatingState();
		    if (changed) this.log(`${this.name}: Intesis mode changed: ${oldValue} → ${value}`);
		    break;
		}
		case "fanSpeed":
		    this.updateFanSpeedState(value);
		    if (changed) this.log(`${this.name}: Intesis fan speed changed: ${oldValue} → ${value}`);
		    break;
		case "setpointTemp":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.CoolingThresholdTemperature, value)
			.updateCharacteristic(Characteristic.HeatingThresholdTemperature, value);
		    if (changed) this.log(`${this.name}: Setpoint temp changed: ${oldValue}°C → ${value}°C`);
		    break;
		case "currentTemp":
		    this.heaterCoolerService.updateCharacteristic(Characteristic.CurrentTemperature, value);
		    if (changed) this.log(`${this.name}: Current temp changed: ${oldValue}°C → ${value}°C`);
		    break;
		case "swingMode":
		    this.heaterCoolerService.updateCharacteristic(
			Characteristic.SwingMode, this.dataMap.swingMode.homekit(value));
		    this.updateSwingAxisStateByServiceID(services.swingMode.service_id, value);
		    if (changed) {
			this.log(`${this.name}: Swing mode changed: ${this.dataMap.swingMode.homekit(oldValue)} → ${this.dataMap.swingMode.homekit(value)}`);
		    }
		    break;
		case "horizontalVanes":
		    this.updateAxisSwingState("horizontalVanes", value);
		    if (changed) this.log(`${this.name}: Horizontal swing changed: ${oldValue} → ${value}`);
		    break;
		case "verticalVanes":
		    this.updateAxisSwingState("verticalVanes", value);
		    if (changed) this.log(`${this.name}: Vertical swing changed: ${oldValue} → ${value}`);
		    break;
	    }
	}
    };

    /** Delegates each discovered capability to its feature wiring module. */
    IntesisWebDevice.prototype.addService = function (serviceName, service, userID, deviceID) {
	switch (serviceName) {
	    case "power":
		setupPower(this, service, userID, deviceID);
		setupAuxiliaryModeHandlers(this, userID, deviceID);
		this.updateOperatingState();
		break;
	    case "userMode":
		setupUserMode(this, service, userID, deviceID);
		break;
	    case "fanSpeed":
		setupFanSpeed(this, service, userID, deviceID);
		break;
	    case "setpointTemp":
		setupSetpoint(this, service, userID, deviceID);
		break;
	    case "currentTemp":
		setupCurrentTemperature(this, service);
		break;
	    case "swingMode":
		setupSwing(this, service, userID, deviceID);
		break;
	    case "horizontalVanes":
		setupAxisSwing(this, "horizontalVanes", service, userID, deviceID);
		break;
	    case "verticalVanes":
		setupAxisSwing(this, "verticalVanes", service, userID, deviceID);
		break;
	}
    };

    return IntesisWebDevice;
}

module.exports = {createIntesisWebDevice};
