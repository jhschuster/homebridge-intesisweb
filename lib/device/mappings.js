/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

/** Creates pure Intesis/HomeKit value translations for the active HAP types. */
function createMappings(Characteristic) {
    return {
	power: {
	    /** Maps HomeKit Active to Intesis power UID values. */
	    intesis(homekitValue) {
		return homekitValue === Characteristic.Active.ACTIVE ? 1 : 0;
	    },
	    homekit: [
		Characteristic.Active.INACTIVE,
		Characteristic.Active.ACTIVE
	    ]
	},
	userMode: {
	    /** Maps native HeaterCooler targets to Intesis operating modes. */
	    intesis(homekitValue) {
		switch (homekitValue) {
		    case Characteristic.TargetHeaterCoolerState.HEAT:
			return 1;
		    case Characteristic.TargetHeaterCoolerState.COOL:
			return 4;
		    default:
			return 0;
		}
	    },
	    /** Maps Intesis native modes, leaving auxiliary modes unrepresented. */
	    homekit(intesisValue) {
		switch (intesisValue) {
		    case 0:
			return Characteristic.TargetHeaterCoolerState.AUTO;
		    case 1:
			return Characteristic.TargetHeaterCoolerState.HEAT;
		    case 4:
			return Characteristic.TargetHeaterCoolerState.COOL;
		    default:
			return undefined;
		}
	    }
	},
	fanSpeed: {
	    /** Maps the four HomeKit percentage steps to Intesis manual levels. */
	    intesis(homekitValue) {
		const percentage = Math.min(100, Math.max(25, Number(homekitValue) || 25));
		return Math.min(4, Math.max(1, Math.round(percentage / 25)));
	    },
	    /** Maps an Intesis manual level to its HomeKit percentage step. */
	    homekit(intesisValue) {
		const rawLevel = Math.min(4, Math.max(1, Number(intesisValue) || 1));
		return rawLevel * 25;
	    }
	},
	swingMode: {
	    /** Maps HomeKit swing enablement to the AC Cloud swing sentinel. */
	    intesis(homekitValue) {
		return homekitValue === Characteristic.SwingMode.SWING_ENABLED ? 10 : 0;
	    },
	    /** Maps the AC Cloud swing sentinel to HomeKit enablement. */
	    homekit(intesisValue) {
		return intesisValue === 10
		    ? Characteristic.SwingMode.SWING_ENABLED
		    : Characteristic.SwingMode.SWING_DISABLED;
	    }
	}
    };
}

/** Identifies modes representable by HomeKit's HeaterCooler target. */
function isNativeMode(mode) {
    return mode === 0 || mode === 1 || mode === 4;
}

module.exports = {createMappings, isNativeMode};
