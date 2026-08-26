/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {parseVista} = require('../lib/vista-parser');

const requiredState = `
  <a href="/device/setVal?id=123&uid=1&value=1&userId=456">state</a>
  <script>
    var selectedOnOff = 1;
    var selectedUsermode = 4;
    var selectedfanspeed = 2;
  </script>
`;

test('parses a normal numeric setpoint', () => {
    const body = `${requiredState}
      <div class="key_value">70.0&deg;F</div>
      <script>setTempCelsiusConsignaHeader(123, '21.5');</script>
    `;

    const services = parseVista(body);

    assert.equal(services.setpointTemp.value, 21.5);
    assert.equal(services.setpointTemp.defaulted, false);
    assert.ok(Math.abs(services.currentTemp.value - 21.111111) < 0.00001);
});

test('keeps the device usable when fan mode renders an unavailable setpoint', () => {
    const debugMessages = [];
    const body = `${requiredState.replace('selectedUsermode = 4', 'selectedUsermode = 3')}
      <div class="key_value">70.0&deg;F</div>
      <div id="setpoint" class="keyBox">
        <div class="header">setpoint temperature</div>
        <div class="key_value">-- &deg;F</div>
      </div>
    `;

    const services = parseVista(body, {
        log: {debug: message => debugMessages.push(message), error: () => {}}
    });

    assert.equal(services.userMode.value, 3);
    assert.equal(services.setpointTemp.defaulted, true);
    assert.equal(services.setpointTemp.raw_value, null);
    assert.equal(services.setpointTemp.value, services.currentTemp.value);
    assert.equal(debugMessages.length, 1);
});

test('clamps a missing-setpoint fallback to the lower HeaterCooler threshold boundary', () => {
    const body = `${requiredState.replace('selectedUsermode = 4', 'selectedUsermode = 3')}
      <div class="key_value">40.0&deg;F</div>
    `;

    const services = parseVista(body);

    assert.ok(services.currentTemp.value < 10);
    assert.equal(services.setpointTemp.value, 10);
    assert.equal(services.setpointTemp.defaulted, true);
});

test('clamps a missing-setpoint fallback to the upper HeaterCooler threshold boundary', () => {
    const body = `${requiredState.replace('selectedUsermode = 4', 'selectedUsermode = 3')}
      <div class="key_value">104.0&deg;F</div>
    `;

    const services = parseVista(body);

    assert.equal(services.currentTemp.value, 40);
    assert.equal(services.setpointTemp.value, 35);
    assert.equal(services.setpointTemp.defaulted, true);
});

test('does not clamp a real setpoint reported outside the temporary fallback range', () => {
    const body = `${requiredState}
      <div class="key_value">70.0&deg;F</div>
      <script>setTempCelsiusConsignaHeader(123, '36.0');</script>
    `;

    const services = parseVista(body);

    assert.equal(services.setpointTemp.value, 36);
    assert.equal(services.setpointTemp.defaulted, false);
});

test('uses the configured current-temperature fallback when telemetry is absent', () => {
    const services = parseVista(`${requiredState}
      <script>setTempCelsiusConsignaHeader(123, '21.5');</script>
    `, {defaultCurrentTemp: 18.5});

    assert.equal(services.currentTemp.value, 18.5);
    assert.equal(services.currentTemp.defaulted, 1);
    assert.equal(services.setpointTemp.value, 21.5);
});

test('falls back from current temperature to setpoint and then a neutral value', () => {
    const setpointOnly = parseVista(`${requiredState}
      <script>setTempCelsiusConsignaHeader(123, '19.5');</script>
    `);
    const noTemperature = parseVista(requiredState);

    assert.equal(setpointOnly.currentTemp.value, 19.5);
    assert.equal(setpointOnly.currentTemp.defaulted, 2);
    assert.equal(noTemperature.currentTemp.value, 20);
    assert.equal(noTemperature.currentTemp.defaulted, 3);
    assert.equal(noTemperature.setpointTemp.value, 20);
});

test('parses negative Celsius telemetry without accepting malformed numbers', () => {
    const negative = parseVista(`${requiredState}
      <div class="key_value">-2.5&deg;C</div>
      <script>setTempCelsiusConsignaHeader(123, '18.0');</script>
    `);
    const malformed = parseVista(`${requiredState}
      <div class="key_value">20..5&deg;C</div>
      <script>setTempCelsiusConsignaHeader(123, '18.0');</script>
    `);

    assert.equal(negative.currentTemp.value, -2.5);
    assert.equal(negative.currentTemp.defaulted, 0);
    assert.equal(malformed.currentTemp.value, 18);
    assert.equal(malformed.currentTemp.defaulted, 2);
});

test('parses the user modes advertised by current AC Cloud controls', () => {
    const body = `${requiredState}
      <div class="key_value">20.0&deg;C</div>
      <script>setTempCelsiusConsignaHeader(123, '21.5');</script>
      <button onclick="setUID(123, 2, 0, &quot;usermode&quot;)">auto</button>
      <button onclick="setUID(123,2,1,'usermode')">heat</button>
      <button onclick="setUID(deviceId, 2, 2, &quot;usermode&quot;)">dry</button>
      <button onclick="setUID(123, 2, 3, &quot;usermode&quot;)">fan</button>
      <button onclick="setUID(123, 2, 4, &quot;usermode&quot;)">cool</button>
      <button onclick="setUID(123, 2, 4, &quot;usermode&quot;)">duplicate cool</button>
    `;

    const services = parseVista(body);

    assert.deepEqual(services.userMode.supported_values, [0, 1, 2, 3, 4]);
});

test('leaves optional mode capabilities absent for backward markup without controls', () => {
    const body = `${requiredState}
      <div class="key_value">20.0&deg;C</div>
      <script>setTempCelsiusConsignaHeader(123, '21.5');</script>
    `;

    const services = parseVista(body);

    assert.equal(Object.hasOwn(services.userMode, 'supported_values'), false);
});

test('parses current AC Cloud horizontal and vertical swing variables', () => {
    const body = `${requiredState}
      <div class="key_value">20.0&deg;C</div>
      <script>
        setTempCelsiusConsignaHeader(123, '21.5');
        var selectedhswing = 10;
        var selectedvswing = 0;
      </script>
    `;

    const horizontal = parseVista(body, {swingMode: 'H'});
    const vertical = parseVista(body, {swingMode: 'V'});

    assert.deepEqual(horizontal.horizontalVanes, {service_id: 6, value: 10});
    assert.deepEqual(horizontal.verticalVanes, {service_id: 5, value: 0});
    assert.deepEqual(horizontal.swingMode, {service_id: 6, value: 10});
    assert.deepEqual(vertical.swingMode, {service_id: 5, value: 0});
});

test('falls back to the available swing axis when the configured axis is absent', () => {
    const verticalOnlyBody = `${requiredState}
      <div class="key_value">20.0&deg;C</div>
      <script>
        setTempCelsiusConsignaHeader(123, '21.5');
        var selectedvswing = 10;
      </script>
    `;

    const services = parseVista(verticalOnlyBody, {swingMode: 'H'});

    assert.equal(services.horizontalVanes, undefined);
    assert.deepEqual(services.verticalVanes, {service_id: 5, value: 10});
    assert.deepEqual(services.swingMode, {service_id: 5, value: 10});
});

test('retains compatibility with legacy vane variable names', () => {
    const body = `${requiredState}
      <div class="key_value">20.0&deg;C</div>
      <script>
        setTempCelsiusConsignaHeader(123, '21.5');
        var selectedhvane = 0;
        var selectedvvane = 10;
      </script>
    `;

    const services = parseVista(body, {swingMode: 'V'});

    assert.deepEqual(services.horizontalVanes, {service_id: 6, value: 0});
    assert.deepEqual(services.verticalVanes, {service_id: 5, value: 10});
    assert.deepEqual(services.swingMode, {service_id: 5, value: 10});
});

test('does not log raw response content when a required field is absent', () => {
    const errors = [];
    const marker = 'SENSITIVE_DEVICE_MARKER';

    const services = parseVista(`<html>${marker}</html>`, {
        log: {debug: () => {}, error: message => errors.push(message)}
    });

    assert.equal(services, null);
    assert.equal(errors.some(message => message.includes(marker)), false);
});
