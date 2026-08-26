/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const {createMappings, isNativeMode} = require("../lib/device/mappings");

const Characteristic = {
    Active: {INACTIVE: 0, ACTIVE: 1},
    TargetHeaterCoolerState: {AUTO: 0, HEAT: 1, COOL: 2},
    SwingMode: {SWING_DISABLED: 0, SWING_ENABLED: 1}
};
const mappings = createMappings(Characteristic);

test("mode mappings preserve native HVAC targets and omit auxiliary modes", () => {
    assert.equal(mappings.power.intesis(Characteristic.Active.INACTIVE), 0);
    assert.equal(mappings.power.intesis(Characteristic.Active.ACTIVE), 1);
    assert.deepEqual(mappings.power.homekit, [Characteristic.Active.INACTIVE, Characteristic.Active.ACTIVE]);
    assert.equal(mappings.userMode.intesis(Characteristic.TargetHeaterCoolerState.AUTO), 0);
    assert.equal(mappings.userMode.intesis(Characteristic.TargetHeaterCoolerState.HEAT), 1);
    assert.equal(mappings.userMode.intesis(Characteristic.TargetHeaterCoolerState.COOL), 4);
    assert.equal(mappings.userMode.homekit(0), Characteristic.TargetHeaterCoolerState.AUTO);
    assert.equal(mappings.userMode.homekit(1), Characteristic.TargetHeaterCoolerState.HEAT);
    assert.equal(mappings.userMode.homekit(4), Characteristic.TargetHeaterCoolerState.COOL);
    assert.equal(mappings.userMode.homekit(2), undefined);
    assert.equal(mappings.userMode.homekit(3), undefined);
    assert.deepEqual([0, 1, 2, 3, 4].map(isNativeMode), [true, true, false, false, true]);
});

test("fan speed and swing mappings retain their bounded wire values", () => {
    assert.deepEqual([25, 50, 75, 100].map(mappings.fanSpeed.intesis), [1, 2, 3, 4]);
    assert.deepEqual([1, 2, 3, 4].map(mappings.fanSpeed.homekit), [25, 50, 75, 100]);
    assert.equal(mappings.swingMode.intesis(Characteristic.SwingMode.SWING_ENABLED), 10);
    assert.equal(mappings.swingMode.homekit(10), Characteristic.SwingMode.SWING_ENABLED);
    assert.equal(mappings.swingMode.homekit(0), Characteristic.SwingMode.SWING_DISABLED);
});
