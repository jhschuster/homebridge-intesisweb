/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

/** Applies stable display and configured names to a HomeKit service. */
function configureServiceName(service, name, Characteristic) {
    service.updateCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName && typeof service.addOptionalCharacteristic === "function") {
	service.addOptionalCharacteristic(Characteristic.ConfiguredName);
	service.updateCharacteristic(Characteristic.ConfiguredName, name);
    }
    return service;
}

module.exports = {configureServiceName};
