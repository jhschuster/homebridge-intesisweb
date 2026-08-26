/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

const {createPlatform} = require("./lib/platform");
const {createIntesisWebDevice} = require("./lib/device/intesis-device");

const testing = {};

/** Registers the static IntesisWeb platform with Homebridge's HAP types. */
function register(homebridge) {
    const Service = homebridge.hap.Service;
    const Characteristic = homebridge.hap.Characteristic;
    const IntesisWebDevice = createIntesisWebDevice({Service, Characteristic});
    const IntesisWeb = createPlatform({IntesisWebDevice});

    testing.IntesisWebDevice = IntesisWebDevice;
    testing.IntesisWeb = IntesisWeb;
    homebridge.registerPlatform("homebridge-intesisweb", "IntesisWeb", IntesisWeb);
}

module.exports = register;
module.exports._testing = testing;
