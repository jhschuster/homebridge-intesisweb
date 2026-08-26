/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {configureServiceName} = require("../support/hap-helpers");

/** Creates capability-gated fan-only and dry switch identities. */
function createAuxiliaryModeServices(details, Service, Characteristic) {
    const supportedModes = details.services && details.services.userMode
	? details.services.userMode.supported_values
	: undefined;
    return {
	fanOnlyService: Array.isArray(supportedModes) && supportedModes.includes(3)
	    ? configureServiceName(new Service.Switch("Fan Only", "fan-only"), "Fan Only", Characteristic)
	    : null,
	dryService: Array.isArray(supportedModes) && supportedModes.includes(2)
	    ? configureServiceName(new Service.Switch("Dry Mode", "dry-mode"), "Dry Mode", Characteristic)
	    : null
    };
}

/** Wires fan-only and dry switches to their serialized mode commands. */
function setupAuxiliaryModeHandlers(device, userID, deviceID) {
    const {Characteristic} = device;
    if (device.fanOnlyService) {
	device.fanOnlyService
	    .getCharacteristic(Characteristic.On)
	    .on("get", callback => {
		const services = device.details.services;
		callback(undefined, Boolean(services && services.power.value === 1 && services.userMode.value === 3));
	    })
	    .on("set", (value, callback) => {
		device.enqueueMutation(
		    finish => device.setFanOnlyActive(value, userID, deviceID, finish),
		    callback);
	    });
    }
    if (device.dryService) {
	device.dryService
	    .getCharacteristic(Characteristic.On)
	    .on("get", callback => {
		const services = device.details.services;
		callback(undefined, Boolean(services && services.power.value === 1 && services.userMode.value === 2));
	    })
	    .on("set", (value, callback) => {
		device.enqueueMutation(
		    finish => device.setDryActive(value, userID, deviceID, finish),
		    callback);
	    });
    }
}

module.exports = {createAuxiliaryModeServices, setupAuxiliaryModeHandlers};
