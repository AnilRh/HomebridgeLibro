// Unofficial plugin, not affiliated with PetLibro
// Use at your own risk
// Check PetLibro's ToS before use

const axios = require('axios');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerPlatform("homebridge-petlibro", "PetLibroPlatform", PetLibroPlatform);
};

class PetLibroPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
  
  discoverDevices() {
    try {
      // Create a single feeder accessory
      const uuid = this.api.hap.uuid.generate('petlibro-feeder-' + (this.config.name || 'default'));
      
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      
      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        new PetLibroFeeder(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', this.config.name || 'Pet Feeder');
        const accessory = new this.api.platformAccessory(this.config.name || 'Pet Feeder', uuid);
        new PetLibroFeeder(this, accessory);
        this.api.registerPlatformAccessories("homebridge-petlibro", "PetLibroPlatform", [accessory]);
      }
    } catch (error) {
      this.log.error('Failed to discover/create devices:', error.message);
      // Don't throw - let Homebridge continue with other plugins
    }
  }
}

class PetLibroFeeder {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.config = platform.config;
    this.name = this.config.name || 'Pet Feeder';
    
    // PetLibro API configuration
    this.email = this.config.email;
    this.password = this.config.password;
    this.deviceId = this.config.deviceId;
    
    // Use the correct API endpoint
    this.baseUrl = this.config.apiEndpoint || 'https://api.us.petlibro.com';
    
    // Device type detection
    this.deviceModel = null;
    this.isPolarFeeder = false;
    this.currentTrayPosition = 0;
    this.manualFeedId = null;
    this.currentTemperature = 20.0; // Default temperature in Celsius
    this.lastDataUpdate = Date.now(); // Initialize cache timestamp
    this.cacheValidityMs = 5 * 60 * 1000; // 5 minutes cache
    
    // Authentication tokens
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    
    // Set accessory information
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'PetLibro')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, 'Smart Feeder')
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.deviceId || 'Unknown')
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, '1.0.0');
    
    // Services will be set up after device detection
    this.switchService = null;
    this.rotateTrayService = null;
    this.audioService = null;
    this.trayPositionSensor = null;
    this.temperatureSensor = null;
    
    // Auto-authenticate on startup (with error handling)
    this.authenticate().then(() => {
      this.setupServices();
    }).catch(error => {
      this.log.error('Failed to authenticate during startup:', error.message);
      this.log.error('Plugin will continue to retry authentication when used');
    });
  }
  
  setupServices() {
    this.log('🔧 Setting up services for device type:', this.isPolarFeeder ? 'Polar Feeder' : 'Standard Feeder');
    
    if (this.isPolarFeeder) {
      this.setupPolarServices();
    } else {
      this.setupStandardServices();
    }
  }
  
  setupStandardServices() {
    // Get or create the switch service for standard feeders
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) 
      || this.accessory.addService(this.platform.api.hap.Service.Switch);
    
    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.name);
    
    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }
  
  setupPolarServices() {
    // Remove old services if they exist
    const oldRotateService = this.accessory.getService('Rotate Tray');
    if (oldRotateService) {
      this.accessory.removeService(oldRotateService);
    }
    const oldTrayPositionService = this.accessory.getService('Tray Position');
    if (oldTrayPositionService) {
      this.accessory.removeService(oldTrayPositionService);
    }
    
    // Door Control - Toggle switch (on = open door, off = close door)
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) 
      || this.accessory.addService(this.platform.api.hap.Service.Switch);
    
    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, `${this.name} Door`);
    
    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(this.getPolarDoorState.bind(this))
      .onSet(this.setPolarDoorState.bind(this));
    
    // Tray Selection - Fan slider (0-33% = tray 1, 34-66% = tray 2, 67-100% = tray 3)
    this.trayFanService = this.accessory.getService('Tray Selection') 
      || this.accessory.addService(this.platform.api.hap.Service.Fan, 'Tray Selection', 'tray-selection');
    
    this.trayFanService.setCharacteristic(this.platform.api.hap.Characteristic.Name, `${this.name} Tray Selection`);
    
    // Fan On/Off characteristic - always on when tray is selected
    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(() => true) // Always on
      .onSet(() => {}); // Ignore off commands
    
    // Rotation Speed characteristic - maps to tray position
    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
      .onGet(async () => {
        try {
          this.log('🔍 HomeKit requesting tray position data');
          await this.updateTrayPosition();
          const percentage = this.trayPositionToPercentage(this.currentTrayPosition);
          this.log(`📊 Returning tray position: ${this.currentTrayPosition} (${percentage}%)`);
          return percentage;
        } catch (error) {
          this.log.error('Error in tray position onGet:', error.message);
          return this.trayPositionToPercentage(this.currentTrayPosition);
        }
      })
      .onSet(async (value) => {
        try {
          this.log(`🎯 Setting tray position to ${value}%`);
          const targetTray = this.percentageToTrayPosition(value);
          await this.setTrayPosition(targetTray);
        } catch (error) {
          this.log.error('Error setting tray position:', error.message);
          throw error;
        }
      });
    
    // Play Audio - Momentary switch
    this.audioService = this.accessory.getService('Play Audio') 
      || this.accessory.addService(this.platform.api.hap.Service.Switch, 'Play Audio', 'play-audio');
    
    this.audioService.setCharacteristic(this.platform.api.hap.Characteristic.Name, `${this.name} Audio`);
    
    this.audioService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(() => false) // Always return false for momentary switch
      .onSet(this.playAudio.bind(this));
    
    // Real Temperature Sensor - Shows actual device temperature
    this.temperatureSensor = this.accessory.getService('Temperature') 
      || this.accessory.addService(this.platform.api.hap.Service.TemperatureSensor, 'Temperature', 'device-temperature');
    
    this.temperatureSensor.setCharacteristic(this.platform.api.hap.Characteristic.Name, `${this.name} Temperature`);
    
    this.temperatureSensor.getCharacteristic(this.platform.api.hap.Characteristic.CurrentTemperature)
      .onGet(async () => {
        try {
          this.log('🌡️ HomeKit requesting temperature data');
          // Fetch fresh data if cache is stale, then return actual device temperature
          await this.updateTrayPosition();
          const value = this.currentTemperature;
          this.log(`🌡️ Returning temperature: ${value}°C`);
          return value;
        } catch (error) {
          this.log.error('Error in temperature onGet:', error.message);
          return this.currentTemperature;
        }
      });
    
    // Get initial tray position and temperature from device
    this.log('🚀 Setting up Polar services - fetching initial data');
    this.updateTrayPosition(true).catch(error => {
      this.log.error('Failed to get initial tray position:', error.message);
    });
  }
  
  // Helper methods for tray position and percentage conversion
  trayPositionToPercentage(trayPosition) {
    // Convert tray position (0, 1, 2) to discrete percentage values
    switch (trayPosition) {
      case 0: return 0;   // Tray 1 = 0%
      case 1: return 50;  // Tray 2 = 50%
      case 2: return 100; // Tray 3 = 100%
      default: return 50; // Default to tray 2
    }
  }
  
  percentageToTrayPosition(percentage) {
    // Convert percentage to tray position with snap-to behavior
    if (percentage <= 25) return 0;      // 0-25% → Tray 1
    if (percentage <= 75) return 1;      // 26-75% → Tray 2
    return 2;                            // 76-100% → Tray 3
  }
  
  async setTrayPosition(targetTray) {
    // Smart rotation logic - API only supports forward (counter-clockwise) rotation
    await this.updateTrayPosition(); // Get current position
    
    const currentTray = this.currentTrayPosition;
    if (currentTray === targetTray) {
      this.log(`🎯 Already at target tray ${targetTray + 1}`);
      return;
    }
    
    // Calculate rotations needed (forward only, with wraparound)
    const totalTrays = 3;
    const rotations = (targetTray - currentTray + totalTrays) % totalTrays;
    
    this.log(`🔄 Moving from tray ${currentTray + 1} to ${targetTray + 1} (${rotations} rotations)`);
    
    // Perform the rotations
    for (let i = 0; i < rotations; i++) {
      this.log(`🔄 Rotation ${i + 1}/${rotations}`);
      await this.rotateTray();
      // Small delay between rotations
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Update the fan service to reflect the new position with canonical percentage
    const newPercentage = this.trayPositionToPercentage(targetTray);
    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
      .updateValue(newPercentage);
    
    this.log(`✅ Successfully moved to tray ${targetTray + 1} (slider snapped to ${newPercentage}%)`);
  }
  
  // Hash password like the HomeAssistant plugin does
  hashPassword(password) {
    return crypto.createHash('md5').update(password).digest('hex');
  }
  
  async authenticate() {
    if (!this.email || !this.password) {
      throw new Error('Email and password are required in config');
    }

    try {
      this.log('Authenticating with PetLibro API using HomeAssistant format...');
      
      // Use the exact constants from the HomeAssistant plugin
      const payload = {
        appId: 1, // APPID = 1 from the HomeAssistant code
        appSn: 'c35772530d1041699c87fe62348507a8', // APPSN from the HomeAssistant code
        country: this.config.country || 'US',
        email: this.email,
        password: this.hashPassword(this.password), // Hash the password like HomeAssistant does
        phoneBrand: '',
        phoneSystemVersion: '',
        timezone: this.config.timezone || 'America/New_York',
        thirdId: null,
        type: null
      };
      
      this.log('Using exact HomeAssistant format');
      this.log('Endpoint:', `${this.baseUrl}/member/auth/login`);
      this.log('Payload:', JSON.stringify({
        ...payload,
        password: payload.password.substring(0, 8) + '...' // Don't log full hashed password
      }, null, 2));
      
      const response = await axios.post(`${this.baseUrl}/member/auth/login`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PetLibro/1.3.45',
          'Accept': 'application/json',
          'Accept-Language': 'en-US',
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': payload.timezone,
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      this.log('Response status:', response.status);
      this.log('Response data:', JSON.stringify(response.data, null, 2));
      
      // Check for success - HomeAssistant expects token in data.token
      const data = response.data;
      if (data && data.code === 0) {
        this.log('🎉 Authentication successful with exact HomeAssistant format!');
        
        // Look for token in data.token like HomeAssistant does
        if (data.data && data.data.token) {
          this.accessToken = data.data.token;
          this.refreshToken = data.data.refresh_token || null;
          
          const expiresIn = data.data.expires_in || 3600;
          this.tokenExpiry = Date.now() + (expiresIn * 1000);
          
          this.log('Authentication successful!');
          this.log('Token (first 20 chars):', this.accessToken.substring(0, 20) + '...');
          
          // Always get device list for model detection
          await this.getDevices();
          return; // Success!
        } else {
          this.log('⚠️ Success response but no token found in data.token');
          this.log('Full data object:', JSON.stringify(data, null, 2));
          throw new Error('Authentication succeeded but no token found in data.token');
        }
      } else if (data && data.code) {
        const errorMsg = data.msg || data.message || 'Unknown error';
        this.log(`❌ Authentication failed: ${errorMsg} (code: ${data.code})`);
        throw new Error(`Authentication failed: ${errorMsg} (code: ${data.code})`);
      } else {
        this.log(`❌ Unexpected response format`);
        throw new Error('Unexpected response format');
      }
      
    } catch (error) {
      this.log.error('Authentication failed:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  async refreshAuthToken() {
    if (!this.refreshToken) {
      return this.authenticate();
    }
    
    try {
      const response = await axios.post(`${this.baseUrl}/member/auth/refresh`, {
        refresh_token: this.refreshToken
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`
        }
      });
      
      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        this.log('Token refreshed successfully');
      }
    } catch (error) {
      this.log.warn('Token refresh failed, re-authenticating...');
      return this.authenticate();
    }
  }
  
  async getDevices() {
    try {
      this.log('🔍 Fetching device list from PetLibro API...');
      await this.ensureAuthenticated();
      
      // Use the correct endpoint from HomeAssistant integration
      const endpoint = '/device/device/list';
      
      this.log(`🔄 Trying devices endpoint: ${this.baseUrl}${endpoint}`);
      
      const response = await axios.post(`${this.baseUrl}${endpoint}`, {}, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'token': this.accessToken, // HomeAssistant uses 'token' header
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': this.config.timezone || 'America/New_York',
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      this.log(`📊 Devices response status: ${response.status}`);
      this.log(`📋 Devices response data:`, JSON.stringify(response.data, null, 2));
      
      // Check for successful response
      if (response.data && response.data.code === 0 && response.data.data) {
        const devices = response.data.data;
        
        if (Array.isArray(devices) && devices.length > 0) {
          // Find the target device
          let targetDevice = null;
          
          if (this.deviceId) {
            // If deviceId is configured, find the matching device
            targetDevice = devices.find(device => {
              const deviceSn = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
              return deviceSn === this.deviceId;
            });
            
            if (!targetDevice) {
              this.log(`⚠️ Configured deviceId '${this.deviceId}' not found in device list`);
              this.log(`📋 Available devices:`, devices.map(d => ({
                id: d.deviceSn || d.device_id || d.deviceId || d.id || d.serial,
                name: d.deviceName || d.device_name || d.name || d.productName,
                model: d.productIdentifier || d.deviceModel || d.model
              })));
              // Fall back to first device
              targetDevice = devices[0];
            }
          } else {
            // If no deviceId configured, use the first device and set deviceId
            targetDevice = devices[0];
            this.deviceId = targetDevice.deviceSn || targetDevice.device_id || targetDevice.deviceId || targetDevice.id || targetDevice.serial;
          }
          
          if (targetDevice) {
            const deviceName = targetDevice.deviceName || targetDevice.device_name || targetDevice.name || targetDevice.productName || 'Unknown Device';
            
            // Detect device model and type
            this.deviceModel = targetDevice.productIdentifier || 'Unknown';
            this.isPolarFeeder = this.deviceModel === 'PLAF109' || deviceName.toLowerCase().includes('polar');
            
            if (this.isPolarFeeder) {
              this.log(`🐧 Detected Polar Wet Food Feeder (${this.deviceModel})`);
              // Update accessory model info
              this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
                .setCharacteristic(this.platform.api.hap.Characteristic.Model, 'Polar Wet Food Feeder');
            } else {
              this.log(`🍽️ Detected standard feeder (${this.deviceModel})`);
            }
            
            this.log(`✅ Found device: ${deviceName} (ID: ${this.deviceId})`);
            this.log(`📱 Device details:`, JSON.stringify(targetDevice, null, 2));
            return;
          }
        } else {
          this.log('⚠️ No devices found in response data array');
        }
      } else if (response.data && response.data.code !== 0) {
        const errorMsg = response.data.msg || 'Unknown error';
        this.log(`❌ Device list API error: ${errorMsg} (code: ${response.data.code})`);
      } else {
        this.log('❌ Unexpected response format from device list endpoint');
      }
      
    } catch (error) {
      this.log.error('💥 Failed to get devices:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
    }
  }
  
  async ensureAuthenticated() {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.refreshAuthToken();
    }
  }
  
  // Polar Feeder Methods
  async updateTrayPosition(forceUpdate = false) {
    try {
      // Check if we have fresh data (within 5 minutes) and not forcing update
      const now = Date.now();
      const cacheAge = (now - this.lastDataUpdate) / 1000; // seconds
      if (!forceUpdate && (now - this.lastDataUpdate) < this.cacheValidityMs) {
        this.log(`💾 Using cached temperature data (${Math.round(cacheAge)}s old, cache valid for ${this.cacheValidityMs/1000}s)`);
        return;
      }
      
      this.log(`🔄 Fetching fresh temperature data (cache ${Math.round(cacheAge)}s old, forceUpdate: ${forceUpdate})`);
      
      await this.ensureAuthenticated();
      
      // Get real-time device info to get current tray position
      const response = await axios.post(`${this.baseUrl}/device/device/realInfo`, {
        id: this.deviceId,
        deviceSn: this.deviceId
      }, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'token': this.accessToken,
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': this.config.timezone || 'America/New_York',
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      this.log(`📊 API Response status: ${response.status}`);
      this.log(`📊 API Response data:`, JSON.stringify(response.data, null, 2));
      
      if (response.data && response.data.code === 0 && response.data.data) {
        const realInfo = response.data.data;
        this.log(`🔍 Raw device data:`, JSON.stringify(realInfo, null, 2));
        
        // Try different possible field names for plate position
        const platePosition = realInfo.platePosition || realInfo.plate || realInfo.currentPlate || 0;
        
        // Try different possible field names for temperature
        const deviceTemperature = realInfo.temperature || realInfo.temp || realInfo.currentTemp || 20.0;
        
        this.log(`🔍 Extracted values - platePosition: ${platePosition}, temperature: ${deviceTemperature}`);
        
        // Update current tray position (ensure it's 1-based for display)
        this.currentTrayPosition = platePosition;
        
        // Update current temperature (ensure it's in Celsius)
        this.currentTemperature = deviceTemperature;
        
        // Update cache timestamp
        this.lastDataUpdate = Date.now();
        
        this.log(`🌡️ Current temperature from device: ${deviceTemperature}°C`);
        this.log(`🍽️ Current tray position from device: ${platePosition} (display: ${platePosition})`);
        
        // Update HomeKit services with new values
        if (this.trayPositionSensor) {
          const displayPosition = platePosition || 1; // Ensure at least 1
          this.trayPositionSensor.getCharacteristic(this.platform.api.hap.Characteristic.CurrentTemperature)
            .updateValue(displayPosition);
          this.log(`📲 Pushing tray position update to HomeKit: ${displayPosition}`);
        }
        
        if (this.temperatureSensor) {
          this.temperatureSensor.getCharacteristic(this.platform.api.hap.Characteristic.CurrentTemperature)
            .updateValue(deviceTemperature);
          this.log(`📲 Pushing temperature update to HomeKit: ${deviceTemperature}°C`);
        }
        
      } else {
        this.log('⚠️ Failed to get device real info or invalid response format');
        this.log('📊 Response structure:', {
          hasData: !!response.data,
          code: response.data?.code,
          hasDataField: !!(response.data?.data),
          dataKeys: response.data?.data ? Object.keys(response.data.data) : []
        });
      }
    } catch (error) {
      this.log.error('Failed to get current tray position:', error.message);
    }
  }
  
  async getPolarDoorState() {
    try {
      // Return current door state based on manual feed status
      return this.manualFeedId !== null;
    } catch (error) {
      this.log.error('Failed to get door state:', error.message);
      return false;
    }
  }
  
  async setPolarDoorState(value) {
    try {
      this.log(`🚪 ${value ? 'Opening' : 'Closing'} door for Polar feeder`);
      await this.ensureAuthenticated();
      
      if (value) {
        // Open door - start manual feeding
        await this.triggerPolarFeed(true);
      } else {
        // Close door - stop manual feeding
        await this.triggerPolarFeed(false);
      }
      
    } catch (error) {
      this.log.error(`Failed to ${value ? 'open' : 'close'} door:`, error.message);
      // Reset switch state on error
      setTimeout(() => {
        if (this.switchService) {
          this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(!value);
        }
      }, 100);
    }
  }
  
  async rotateTray(value) {
    if (!value) {
      this.log('Rotate tray switch turned OFF (ignored - this is a momentary switch)');
      return;
    }
    
    try {
      this.log('🔄 Rotating tray for Polar feeder');
      await this.ensureAuthenticated();
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot rotate tray');
      }
      
      const requestId = this.generateRequestId();
      
      const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/platePositionChange`, {
        deviceSn: this.deviceId,
        plate: 1  // The plate ID doesn't matter - device rotates one bowl counter-clockwise
      }, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'token': this.accessToken,
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': this.config.timezone || 'America/New_York',
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      if (response.data && response.data.code === 0) {
        this.log('✅ Tray rotation successful');
        
        // Get the actual current tray position from the device after rotation
        setTimeout(() => {
          this.updateTrayPosition(true).catch(error => {
            this.log.error('Failed to update tray position after rotation:', error.message);
          });
        }, 1000); // Wait a moment for the device to update its position
        
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Tray rotation failed: ${errorMsg}`);
      }
      
    } catch (error) {
      this.log.error('Failed to rotate tray:', error.message);
    } finally {
      // Reset momentary switch
      setTimeout(() => {
        if (this.rotateTrayService) {
          this.rotateTrayService.getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }
      }, 100);
    }
  }
  
  async playAudio(value) {
    if (!value) {
      this.log('Play audio switch turned OFF (ignored - this is a momentary switch)');
      return;
    }
    
    try {
      this.log('🔊 Playing audio for Polar feeder');
      await this.ensureAuthenticated();
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot play audio');
      }
      
      const requestId = this.generateRequestId();
      
      const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/feedAudio`, {
        deviceSn: this.deviceId
      }, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'token': this.accessToken,
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': this.config.timezone || 'America/New_York',
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      if (response.data && response.data.code === 0) {
        this.log('✅ Audio playback successful');
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Audio playback failed: ${errorMsg}`);
      }
      
    } catch (error) {
      this.log.error('Failed to play audio:', error.message);
    } finally {
      // Reset momentary switch
      setTimeout(() => {
        if (this.audioService) {
          this.audioService.getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }
      }, 100);
    }
  }
  
  async triggerPolarFeed(start) {
    try {
      await this.ensureAuthenticated();
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot control feeding');
      }
      
      const requestId = this.generateRequestId();
      
      if (start) {
        // Start manual feeding (open door)
        this.log('📡 Sending manual feed start command to Polar feeder');
        
        const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/manualFeedNow`, {
          deviceSn: this.deviceId,
          plate: 1  // The plate ID doesn't matter - device feeds from current bowl
        }, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'token': this.accessToken,
            'source': 'ANDROID',
            'language': 'EN',
            'timezone': this.config.timezone || 'America/New_York',
            'version': '1.3.45'
          },
          timeout: 10000
        });
        
        this.log(`📊 Start feed response status: ${response.status}`);
        this.log(`📊 Start feed response data:`, JSON.stringify(response.data, null, 2));
        
        if (response.data && response.data.code === 0) {
          this.log('✅ Manual feed started successfully');
          // Store the manual feed ID for stopping later - try different possible field names
          this.manualFeedId = response.data.data?.manualFeedId || response.data.data?.feedId || response.data.data?.id;
          
          if (!this.manualFeedId) {
            this.log('⚠️ No feed ID returned from API, cannot stop feed later');
            this.log('📊 Available data fields:', Object.keys(response.data.data || {}));
          } else {
            this.log(`📝 Stored manual feed ID: ${this.manualFeedId}`);
          }
        } else {
          const errorMsg = response.data?.msg || 'Unknown error';
          throw new Error(`Manual feed start failed: ${errorMsg}`);
        }
        
      } else {
        // Stop manual feeding (close door)
        if (!this.manualFeedId) {
          this.log('⚠️ No active manual feed to stop');
          return;
        }
        
        this.log(`📡 Sending manual feed stop command to Polar feeder with feedId: ${this.manualFeedId}`);
        
        const stopPayload = {
          deviceSn: this.deviceId,
          feedId: this.manualFeedId
        };
        this.log(`📝 Stop feed payload:`, JSON.stringify(stopPayload, null, 2));
        
        const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/stopFeedNow`, stopPayload, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'token': this.accessToken,
            'source': 'ANDROID',
            'language': 'EN',
            'timezone': this.config.timezone || 'America/New_York',
            'version': '1.3.45'
          },
          timeout: 10000
        });
        
        this.log(`📊 Stop feed response status: ${response.status}`);
        this.log(`📊 Stop feed response data:`, JSON.stringify(response.data, null, 2));
        
        if (response.data && response.data.code === 0) {
          this.log('✅ Manual feed stopped successfully');
          this.manualFeedId = null;
        } else {
          const errorMsg = response.data?.msg || 'Unknown error';
          const errorCode = response.data?.code || 'Unknown code';
          this.log(`❌ Stop feed failed - Code: ${errorCode}, Message: ${errorMsg}`);
          throw new Error(`Manual feed stop failed: ${errorMsg}`);
        }
      }
      
    } catch (error) {
      this.log.error(`Failed to ${start ? 'start' : 'stop'} manual feeding:`, error.message);
      throw error;
    }
  }
  
  async getOn() {
    this.log('Switch state requested - returning false (momentary switch)');
    // Always return false since this is a momentary switch for feeding
    return false;
  }
  
  async setOn(value) {
    this.log(`Switch setOn called with value: ${value}`);
    
    if (value) {
      this.log('🍽️ Feed button tapped! Triggering manual feeding...');
      
      try {
        await this.triggerFeeding();
        this.log('✅ Feeding command completed successfully');
        
        // Reset switch to off after 1 second (momentary behavior)
        setTimeout(() => {
          this.log('🔄 Resetting switch to OFF state');
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 1000);
      } catch (error) {
        this.log.error('❌ Failed to trigger feeding:', error.message);
        
        // Reset switch to off immediately on error
        setTimeout(() => {
          this.log('🔄 Resetting switch to OFF state (due to error)');
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 100);
        
        // Don't throw the error - just log it to prevent breaking HomeKit
      }
    } else {
      this.log('Switch turned OFF (ignored - this is a momentary switch)');
    }
  }
  
  async triggerFeeding() {
    try {
      this.log('🔐 Ensuring authentication before feeding...');
      await this.ensureAuthenticated();
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot send feed command');
      }
      
      this.log(`📡 Sending manual feed command to device: ${this.deviceId}`);
      this.log(`🥘 Portions to dispense: ${this.config.portions || 1}`);
      
      // Use the exact endpoint and format from HomeAssistant
      const feedData = {
        deviceSn: this.deviceId,
        grainNum: parseInt(this.config.portions || 1), // Ensure it's an integer
        requestId: this.generateRequestId() // Generate unique request ID like HomeAssistant
      };
      
      this.log('📤 Feed request payload:', JSON.stringify(feedData, null, 2));
      this.log(`🔄 Using HomeAssistant endpoint: ${this.baseUrl}/device/device/manualFeeding`);
      
      const response = await axios.post(`${this.baseUrl}/device/device/manualFeeding`, feedData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'token': this.accessToken, // HomeAssistant uses 'token' header
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': this.config.timezone || 'America/New_York',
          'version': '1.3.45'
        },
        timeout: 15000 // 15 second timeout for feed commands
      });
      
      this.log(`📊 Feed response status: ${response.status}`);
      this.log(`📋 Feed response data:`, JSON.stringify(response.data, null, 2));
      
      // Check for success based on HomeAssistant code
      if (response.status === 200) {
        // HomeAssistant expects the response to be an integer or success code
        if (typeof response.data === 'number' || 
            (response.data && response.data.code === 0) ||
            response.data === 0) {
          
          this.log('✅ Manual feeding triggered successfully!');
          return;
        } else {
          this.log(`⚠️ Feed command sent but unexpected response:`, JSON.stringify(response.data, null, 2));
        }
      }
      
      throw new Error(`Feed command failed with status ${response.status}`);
      
    } catch (error) {
      this.log.error('💥 Failed to trigger feeding:', error.message);
      if (error.response) {
        this.log.error('   Response status:', error.response.status);
        this.log.error('   Response data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  // Generate unique request ID like HomeAssistant does
  generateRequestId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
  
  getServices() {
    const services = [];
    
    if (this.switchService) {
      services.push(this.switchService);
    }
    
    if (this.isPolarFeeder) {
      if (this.rotateTrayService) {
        services.push(this.rotateTrayService);
      }
      if (this.audioService) {
        services.push(this.audioService);
      }
      if (this.trayPositionSensor) {
        services.push(this.trayPositionSensor);
      }
      if (this.temperatureSensor) {
        services.push(this.temperatureSensor);
      }
    }
    
    return services;
  }
}