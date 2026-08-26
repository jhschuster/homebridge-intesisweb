/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {configureServiceName} = require("../support/hap-helpers");

/** Creates separate visible switches for each vane axis reported by AC Cloud. */
function createSwingServices(details, Service, Characteristic) {
    const services = details.services || {};
    return {
	horizontalSwingService: services.horizontalVanes
	    ? configureServiceName(
		new Service.Switch("Horizontal Swing", "horizontal-swing"),
		"Horizontal Swing",
		Characteristic)
	    : null,
	verticalSwingService: services.verticalVanes
	    ? configureServiceName(
		new Service.Switch("Vertical Swing", "vertical-swing"),
		"Vertical Swing",
		Characteristic)
	    : null
    };
}

/** Wires one vane-axis switch to its parsed Intesis service UID. */
function setupAxisSwing(device, axisName, service, userID, deviceID) {
    const {Characteristic} = device;
    const axisService = axisName === "horizontalVanes"
	? device.horizontalSwingService
	: device.verticalSwingService;
    if (!axisService) return;
    const serviceID = service.service_id;
    axisService
	.getCharacteristic(Characteristic.On)
	.on("get", callback => {
	    const axis = device.details.services && device.details.services[axisName];
	    axis ? callback(undefined, axis.value === 10) : callback(Error(), undefined);
	})
	.on("set", (value, callback) => {
	    const intesisValue = value ? 10 : 0;
	    device.log.debug(`${device.name}: ${axisName} SET`, Boolean(value), intesisValue);
	    device.enqueueMutation(finish => {
		let transportCompleted = false;
		device.platform.setValue(userID, deviceID, serviceID, intesisValue, err => {
		    // Ignore a misbehaving transport's later completion so an initial
		    // error cannot be followed by a stale successful cache update.
		    if (transportCompleted) return;
		    transportCompleted = true;
		    if (!err) {
			if (device.details.services && device.details.services[axisName]) {
			    device.details.services[axisName].value = intesisValue;
			}
			// Only the axis selected by the generic SwingMode UID mirrors it.
			device.updateAxisSwingState(axisName, intesisValue);
		    }
		    finish(err);
		});
	    }, callback);
	})
	.updateValue(service.value === 10);
}

/** Wires the parser-selected swing UID to HomeKit SwingMode. */
function setupSwing(device, service, userID, deviceID) {
    const {Characteristic} = device;
    const serviceID = service.service_id;
    device.heaterCoolerService
	.getCharacteristic(Characteristic.SwingMode)
	.on("get", callback => {
	    device.details.services
		? callback(undefined, device.dataMap.swingMode.homekit(device.details.services.swingMode.value))
		: callback(Error(), undefined);
	})
	.on("set", (value, callback) => {
	    const intesisValue = device.dataMap.swingMode.intesis(value);
	    device.log.debug(`${device.name}: swingMode SET`, value, intesisValue);
	    device.enqueueMutation(finish => {
		let transportCompleted = false;
		device.platform.setValue(userID, deviceID, serviceID, intesisValue, err => {
		    if (transportCompleted) return;
		    transportCompleted = true;
		    if (!err) {
			if (device.details.services) device.details.services.swingMode.value = intesisValue;
			device.heaterCoolerService.updateCharacteristic(Characteristic.SwingMode, value);
			// Mirror only the physical axis represented by the configured UID.
			device.updateSwingAxisStateByServiceID(serviceID, intesisValue);
		    }
		    finish(err);
		});
	    }, callback);
	})
	.updateValue(device.dataMap.swingMode.homekit(service.value));
}

module.exports = {createSwingServices, setupAxisSwing, setupSwing};
