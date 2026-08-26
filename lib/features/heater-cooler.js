/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

/** Wires HeaterCooler power/status without claiming auxiliary-mode power. */
function setupPower(device, service, userID, deviceID) {
    const {Characteristic} = device;
    device.heaterCoolerService
	.getCharacteristic(Characteristic.Active)
	.on("get", callback => {
	    const services = device.details.services;
	    callback(undefined, services && services.power.value === 1 && device.isNativeMode(services.userMode.value)
		? Characteristic.Active.ACTIVE
		: Characteristic.Active.INACTIVE);
	})
	.on("set", (value, callback) => {
	    device.log(`${device.name}: Heater/Cooler active SET`, value);
	    device.enqueueMutation(
		finish => device.setHeaterCoolerActive(value, userID, deviceID, finish),
		callback);
	})
	.updateValue(service.value === 1 && device.isNativeMode(device.details.services.userMode.value)
	    ? Characteristic.Active.ACTIVE
	    : Characteristic.Active.INACTIVE);
    device.heaterCoolerService
	.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
	.on("get", callback => {
	    const services = device.details.services;
	    const active = services && services.power.value === 1 && device.isNativeMode(services.userMode.value);
	    callback(undefined, active
		? Characteristic.CurrentHeaterCoolerState.IDLE
		: Characteristic.CurrentHeaterCoolerState.INACTIVE);
	});
}

/** Wires native auto/heat/cool target selection and retention. */
function setupUserMode(device, service, userID, deviceID) {
    const {Characteristic} = device;
    const serviceID = service.service_id;
    const targetCharacteristic = device.heaterCoolerService
	.getCharacteristic(Characteristic.TargetHeaterCoolerState)
	.on("get", callback => {
	    device.details.services && device.lastHeaterCoolerTarget !== undefined
		? callback(undefined, device.lastHeaterCoolerTarget)
		: callback(Error(), undefined);
	})
	.on("set", (value, callback) => {
	    const intesisValue = device.dataMap.userMode.intesis(value);
	    device.log.debug(`${device.name}: userMode SET`, value, intesisValue);
	    device.enqueueMutation(finish => {
		device.platform.setValue(userID, deviceID, serviceID, intesisValue, err => {
		    if (!err) {
			if (device.details.services) device.details.services.userMode.value = intesisValue;
			device.lastHeaterCoolerTarget = value;
			device.heaterCoolerService.updateCharacteristic(Characteristic.TargetHeaterCoolerState, value);
			device.updateOperatingState();
		    }
		    finish(err);
		});
	    }, callback);
	});
    targetCharacteristic.updateValue(device.lastHeaterCoolerTarget);
}

/** Wires the shared Intesis setpoint to both HeaterCooler thresholds. */
function setupSetpoint(device, service, userID, deviceID) {
    const {Characteristic} = device;
    const serviceID = service.service_id;
    const setpoint = device.details.services.setpointTemp;
    const props = {
	maxValue: setpoint && setpoint.max_value ? setpoint.max_value : 35,
	minValue: setpoint && setpoint.min_value ? setpoint.min_value : 10,
	minStep: setpoint && setpoint.step ? setpoint.step : 1
    };
    /** Adds one threshold backed by AC Cloud's single shared setpoint UID. */
    const addThreshold = (type, label) => {
	device.heaterCoolerService
	    .addCharacteristic(type)
	    .setProps(props)
	    .on("get", callback => {
		device.details.services
		    ? callback(undefined, device.details.services.setpointTemp.value)
		    : callback(Error(), undefined);
	    })
	    .on("set", (value, callback) => {
		device.log.debug(`${device.name}: setpointTemp ${label} SET`, value, Math.round(value * 10));
		device.enqueueMutation(finish => {
		    device.platform.setValue(userID, deviceID, serviceID, Math.round(value * 10), err => {
			if (!err) {
			    if (device.details.services) device.details.services.setpointTemp.value = value;
			    device.heaterCoolerService.updateCharacteristic(type, value);
			}
			finish(err);
		    });
		}, callback);
	    })
	    .updateValue(service.value);
    };
    addThreshold(Characteristic.CoolingThresholdTemperature, "cool");
    addThreshold(Characteristic.HeatingThresholdTemperature, "heat");
}

/** Wires the read-only current-temperature characteristic. */
function setupCurrentTemperature(device, service) {
    const {Characteristic} = device;
    device.heaterCoolerService
	.getCharacteristic(Characteristic.CurrentTemperature)
	.on("get", callback => {
	    device.details.services
		? callback(undefined, device.details.services.currentTemp.value)
		: callback(Error(), undefined);
	})
	.updateValue(service.value);
}

module.exports = {setupPower, setupUserMode, setupSetpoint, setupCurrentTemperature};
