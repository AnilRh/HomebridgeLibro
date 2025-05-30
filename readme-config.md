# Homebridge PetLibro Feeder Plugin

A Homebridge plugin to control PetLibro smart feeders through Apple HomeKit. This plugin allows you to trigger manual feeding sessions directly from your iOS Home app.

## Supported Devices

Based on the HomeAssistant integration, this plugin should work with:
- Granary Smart Feeder (PLAF103)
- Space Smart Feeder (PLAF107)
- Air Smart Feeder (PLAF108)
- Polar Wet Food Feeder (PLAF109)
- Granary Smart Camera Feeder (PLAF203)
- One RFID Smart Feeder (PLAF301)

## Installation

1. Install the plugin via npm:
```bash
npm install -g homebridge-petlibro-feeder
```

2. Add the accessory to your Homebridge config.json file.

## Configuration

Add the following to your Homebridge `config.json` in the accessories section:

```json
{
  "accessories": [
    {
      "accessory": "PetLibroFeeder",
      "name": "Pet Feeder",
      "email": "your-petlibro-email@example.com",
      "password": "your-petlibro-password",
      "deviceId": "your-device-id-optional",
      "portions": 1
    }
  ]
}
```

### Configuration Options

| Parameter | Required | Description |
|-----------|----------|-------------|
| `accessory` | Yes | Must be "PetLibroFeeder" |
| `name` | No | Display name for the feeder (default: "Pet Feeder") |
| `email` | Yes | Your PetLibro account email |
| `password` | Yes | Your PetLibro account password |
| `deviceId` | No | Specific device ID (auto-detected if not provided) |
| `portions` | No | Number of portions to dispense (default: 1) |

## Usage

1. After adding the configuration and restarting Homebridge, the feeder will appear as a switch in your Home app.

2. Tap the switch to trigger a manual feeding session.

3. The switch will automatically turn off after 1 second (momentary behavior).

## Important Notes

### Account Limitations
- Only one device can be logged into a PetLibro account at a time
- If you want to keep your phone app connected, create a separate PetLibro account for this plugin and share your device to it

### API Considerations
- This plugin reverse-engineers the PetLibro mobile app API
- API endpoints may change without notice
- The plugin authenticates every hour to maintain connection

## Troubleshooting

### Authentication Issues
1. Verify your email and password are correct
2. Ensure only one device is logged into your PetLibro account
3. Check Homebridge logs for detailed error messages

### Device Not Found
1. If `deviceId` is not specified, the plugin will use the first device found
2. You can find your device ID by checking the Homebridge logs during startup
3. Alternatively, specify the device ID manually in the configuration

### Feeding Not Working
1. Ensure your feeder has food and is powered on
2. Check that the feeder is connected to WiFi
3. Verify the feeder works normally through the official PetLibro app

## Development

This plugin is based on the API calls observed from the HomeAssistant PetLibro integration. The API endpoints may need adjustment based on your specific device model.

### API Endpoints Used
- Authentication: `POST /v3/user/login`
- Token Refresh: `POST /v3/user/refresh`
- Device List: `GET /v3/devices`
- Manual Feed: `POST /v3/devices/{deviceId}/feed`

## Contributing

If you encounter issues or have improvements:
1. Check existing issues on GitHub
2. Provide detailed logs and device information
3. Test with the official PetLibro app to confirm device functionality

## License

MIT License - see LICENSE file for details.
