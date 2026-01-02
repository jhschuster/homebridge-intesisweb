# Changelog

All notable changes to this project will be documented in this file.

## [2.0.2] - 2026-01-03

### Added
- Change detection logging for external updates (from physical controller or Intesis app)
- Logs now show "old value → new value" when background polling detects changes
- Only logs actual changes (no spam when values haven't changed)

### Changed
- Updated Node.js version requirement to `>=18.20.4` (was overly specific, now allows any version 18.20.4+)

### Fixed
- No logs appearing when values changed from physical controller or external sources

## [2.0.1] - 2026-01-03

### Added
- Immediate HomeKit status updates after setting values
- `updateCharacteristic()` calls after successful setValue operations

### Fixed
- Delayed status updates in HomeKit after controlling device (was waiting up to 30 seconds for next poll)
- HomeKit now shows updated status immediately after turning AC on/off, changing temperature, mode, fan speed, or swing mode

## [2.0.0] - 2026-01-02

### Breaking Changes
- Minimum Node.js version is now 18.20.4
- Minimum Homebridge version is now 1.6.0

### Added
- Homebridge 2.0 compatibility
- Background polling mechanism for better performance
- Automatic shutdown cleanup for polling interval
- Performance tuning guide in README
- Upgrade guide for users migrating from 1.x

### Changed
- **Major Performance Improvement**: Removed synchronous `refreshConfig()` calls from all characteristic get handlers
- Implemented background polling that runs every `configCacheSeconds` instead of polling on every characteristic request from HomeKit
- Expected CPU usage reduction: 80-90% compared to version 1.x
- Updated `configCacheSeconds` documentation to clarify it now controls background polling interval
- Enhanced README with requirements, performance tuning, testing, and upgrade sections

### Fixed
- High CPU usage caused by excessive polling on every characteristic get request
- Improved efficiency of device state updates

### Notes
- This version is fully compatible with both Homebridge 1.6.x and 2.0.x
- Backward compatible: existing config.json files work without any changes
- No functional changes to device control behavior - all HVAC features work exactly as before
- Users on older Node.js versions (< 18.20.4) should continue using version 1.0.20

## [1.0.20] - 2024-XX-XX

### Fixed
- Fixed X-Requested-With header typo (was X_Requested_With)

## [1.0.19] - 2024-XX-XX

### Fixed
- Fixed typos in code

## [1.0.18] - 2024-XX-XX

### Fixed
- Fixed issue with modifying const variable

## [1.0.17] - 2024-XX-XX

### Changed
- Many fixes and improvements

For earlier version history, see git commit history.
