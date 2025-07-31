# Polar Wet Food Feeder API Documentation

This document provides comprehensive API documentation for the PetLibro Polar Wet Food Feeder (PLAF109), extracted from the Home Assistant integration Python code.

## Overview

The Polar Wet Food Feeder differs significantly from standard PetLibro feeders. Instead of dispensing dry food portions, it has:
- **3 rotating food trays** that can be positioned under a door
- **A controllable door** that opens/closes to allow access to food
- **Manual feeding control** via start/stop commands (not portion-based)
- **Audio feedback** capabilities
- **Schedule repositioning** for timed feeding plans

## Device Detection

**Model Number:** `PLAF109`
**Device Name:** Usually contains "Polar" in the name

## API Endpoints

All endpoints use the base URL: `https://api.us.petlibro.com`

### Authentication Headers
```javascript
{
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'token': accessToken,
  'source': 'ANDROID',
  'language': 'EN',
  'timezone': 'America/New_York', // or user's timezone
  'version': '1.3.45'
}
```

### 1. Manual Feed Control

#### Start Manual Feeding (Open Door)
```
POST /device/device/setManualFeedNow
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number",
  "requestId": "unique_request_id"
}
```

**Response (Success):**
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "manualFeedId": "feed_session_id"
  }
}
```

**Notes:**
- Opens the feeder door to allow pet access to current tray
- Returns a `manualFeedId` that must be stored for stopping the feed session
- Door remains open until explicitly closed

#### Stop Manual Feeding (Close Door)
```
POST /device/device/setStopFeedNow
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number",
  "manualFeedId": "feed_session_id_from_start",
  "requestId": "unique_request_id"
}
```

**Response (Success):**
```json
{
  "code": 0,
  "msg": "success"
}
```

**Notes:**
- Closes the feeder door
- Requires the `manualFeedId` from the start command
- Ends the current feeding session

### 2. Tray Rotation

#### Rotate Food Bowl
```
POST /device/device/setRotateFoodBowl
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number",
  "requestId": "unique_request_id"
}
```

**Response (Success):**
```json
{
  "code": 0,
  "msg": "success"
}
```

**Notes:**
- Rotates to the next tray position (cycles through 3 positions)
- Does not open/close the door
- Tray positions are typically numbered 0, 1, 2 (or 1, 2, 3 for display)

### 3. Audio Control

#### Play Feed Audio
```
POST /device/device/setFeedAudio
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number",
  "requestId": "unique_request_id"
}
```

**Response (Success):**
```json
{
  "code": 0,
  "msg": "success"
}
```

**Notes:**
- Plays feeding-related audio/sounds
- Can be used to call pets to the feeder
- Independent of door/tray operations

### 4. Device Status Queries

#### Get Device Grain Status
```
POST /device/device/grainStatus
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number"
}
```

#### Get Real-time Device Info
```
POST /device/device/realInfo
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number"
}
```

#### Get Wet Feeding Plan
```
POST /device/device/wetFeedingPlan
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number"
}
```

#### Get Today's Feeding Plan
```
POST /device/device/feedingPlanTodayNew
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number"
}
```

## Device Properties (from Status Responses)

### Battery Information
- `batteryState`: String indicating battery status ("low", "normal", etc.)
- `batteryDisplayType`: Float representing battery percentage
- `electricQuantity`: Integer battery level

### Device Status
- `online`: Boolean indicating if device is connected
- `platePosition`: Integer (0-2) indicating current tray position
- `barnDoorError`: Boolean indicating if door is blocked
- `temperature`: Float temperature in Celsius
- `whetherInSleepMode`: Boolean sleep mode status

### Connectivity
- `wifiRssi`: Integer WiFi signal strength
- `wifiSsid`: String WiFi network name

### Feeding Status
- `manualFeedId`: Integer/String ID of active manual feed session (null if none)
- `surplusGrain`: Boolean indicating if food is available
- `enableFeedingPlan`: Boolean indicating if scheduled feeding is enabled

## Schedule Management

### Reposition Schedule
```
POST /device/device/setRepositionSchedule
```

**Request Body:**
```json
{
  "deviceSn": "device_serial_number",
  "feedingPlan": [
    {
      "id": "plan_item_id",
      "plate": 1,
      "label": "Morning Feed",
      "executionStartTime": "08:00",
      "executionEndTime": "08:30"
    }
  ],
  "templateName": "Daily Feeding Plan",
  "requestId": "unique_request_id"
}
```

**Notes:**
- Used to update/modify scheduled feeding plans
- Each plan item specifies which tray (plate) to use and timing
- Requires existing feeding plan data to modify

## Error Handling

### Common Error Codes
- `code: 0` - Success
- `code: 1001` - Authentication failed
- `code: 1002` - Device not found
- `code: 1003` - Device offline
- `code: 2001` - Invalid parameters

### Error Response Format
```json
{
  "code": error_code,
  "msg": "error_description"
}
```

## Implementation Notes

### Request ID Generation
Generate unique request IDs for each API call. Example implementation:
```javascript
generateRequestId() {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}
```

### Manual Feed Session Management
- Always store the `manualFeedId` from start commands
- Use the stored ID for stop commands
- Track session state to prevent orphaned sessions

### Tray Position Tracking
- Maintain local counter for current tray position
- Increment and wrap around (0→1→2→0) on each rotation
- Update UI to show current tray number

### Timeout Considerations
- Use appropriate timeouts (10-15 seconds) for API calls
- Handle network failures gracefully
- Implement retry logic for critical operations

## Differences from Standard Feeders

| Feature | Standard Feeders | Polar Wet Food Feeder |
|---------|------------------|----------------------|
| Feeding Method | Portion dispensing | Door open/close |
| Food Storage | Internal hopper | 3 external trays |
| Feed Command | `manualFeeding` | `setManualFeedNow` |
| Stop Command | N/A (automatic) | `setStopFeedNow` |
| Tray Control | N/A | `setRotateFoodBowl` |
| Audio | N/A | `setFeedAudio` |
| Session Management | None | Manual feed ID tracking |

## HomeKit Integration Recommendations

1. **Door Control**: Use toggle switch (ON = open, OFF = close)
2. **Tray Rotation**: Use momentary switch with position display
3. **Audio**: Use momentary switch for audio feedback
4. **Status Display**: Show current tray position in service names
5. **Error Handling**: Reset switch states on API failures

This documentation captures all the essential API knowledge from the Python implementation, allowing safe removal of the reference file.
