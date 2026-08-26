/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {configureServiceName} = require("../support/hap-helpers");

/** Creates the linked manual Fanv2 and separate automatic-speed switch. */
function createFanSpeedServices(details, Service, Characteristic) {
    if (!details.services || !details.services.fanSpeed) {
	return {fanSpeedService: null, autoFanSpeedService: null};
    }
    return {
	fanSpeedService: configureServiceName(
	    new Service.Fanv2("Fan Speed", "fan-speed"), "Fan Speed", Characteristic),
	autoFanSpeedService: configureServiceName(
	    new Service.Switch("Fan Auto", "auto-fan-speed"),
	    "Fan Auto",
	    Characteristic)
    };
}

/** Wires manual and automatic fan controls to the shared device state. */
function setupFanSpeed(device, service, userID, deviceID) {
    const {Characteristic} = device;
    const serviceID = service.service_id;
    device.fanSpeedService
	.getCharacteristic(Characteristic.Active)
	.on("get", callback => {
	    const services = device.details.services;
	    callback(undefined, services && services.power && services.power.value === 1
		? Characteristic.Active.ACTIVE
		: Characteristic.Active.INACTIVE);
	})
	.on("set", (_value, callback) => {
	    // Fanv2 Active is status-only: HomeKit toggle gestures must never write
	    // physical power or change the HVAC mode.
	    device.enqueueMutation(finish => {
		device.updateFanServicePowerState();
		finish();
		setImmediate(() => device.updateFanServicePowerState());
	    }, callback);
	});
    if (Characteristic.CurrentFanState) {
	device.fanSpeedService
	    .getCharacteristic(Characteristic.CurrentFanState)
	    .on("get", callback => {
		const services = device.details.services;
		callback(undefined, services && services.power && services.power.value === 1
		    ? Characteristic.CurrentFanState.IDLE
		    : Characteristic.CurrentFanState.INACTIVE);
	    });
    }
    device.fanSpeedService
	.addCharacteristic(Characteristic.RotationSpeed)
	.setProps({maxValue: 100, minValue: 25, minStep: 25})
	.on("get", callback => {
	    const services = device.details.services;
	    services && services.fanSpeed
		? callback(undefined, device.dataMap.fanSpeed.homekit(device.lastManualFanRaw))
		: callback(Error(), undefined);
	})
	.on("set", (value, callback) => {
	    device.log.debug(`${device.name}: fanSpeed SET`, value);
	    device.enqueueMutation(
		finish => device.setFanSpeedValue(value, userID, deviceID, serviceID, finish),
		callback);
	})
	.updateValue(device.dataMap.fanSpeed.homekit(device.lastManualFanRaw));
    device.autoFanSpeedService
	.getCharacteristic(Characteristic.On)
	.on("get", callback => {
	    const services = device.details.services;
	    const rawValue = services && services.fanSpeed && services.fanSpeed.value;
	    callback(undefined, device.isPhysicallyPowered() && rawValue === 0);
	})
	.on("set", (value, callback) => {
	    device.log.debug(`${device.name}: automatic fan speed SET`, value);
	    device.enqueueMutation(finish => {
		device.setAutomaticFanSpeed(value, userID, deviceID, serviceID, err => {
		    finish(err);
		    // HAP may optimistically apply the requested switch value after its
		    // callback. Reassert effective state once that assignment completes.
		    setImmediate(() => {
			const services = device.details.services;
			if (services && services.fanSpeed) {
			    device.updateFanSpeedState(services.fanSpeed.value);
			}
		    });
		});
	    }, callback);
	});
    // Raw zero belongs exclusively to the automatic-speed switch; the manual
    // slider continues to display the retained nonzero level.
    device.fanSpeedConfigured = true;
    device.updateFanSpeedState(service.value);
}

module.exports = {createFanSpeedServices, setupFanSpeed};
