// Unofficial plugin, not affiliated with PetLibro
// Use at your own risk
// Check PetLibro's ToS before use

const axios = require('axios');
const crypto = require('crypto');
const CachedPetLibroAPI = require('./lib/cached-petlibro-api');
const { StandardFeeder, PolarFeeder } = require('./lib/feeder-devices');

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
    this.name = this.config.name || 'PetLibro Feeder';
    
    // Initialize cached API client
    this.api = new CachedPetLibroAPI({
      email: this.config.email,
      password: this.config.password,
      timezone: this.config.timezone
    });
    
    // Set logger for the API
    this.api.setLogger(this.log);
    
    // Initialize device (with error handling)
    this.initializeDevice().catch(error => {
      this.log.error('Failed to initialize device during startup:', error.message);
      this.log.error('Plugin will continue to retry initialization when used');
    });
  }
  
  async initializeDevice() {
    try {
      this.log('🔐 Authenticating with PetLibro API...');
      const result = await this.api.authenticate();
      
      if (result.success) {
        this.log('✅ Authentication successful!');
        this.log('Token (first 20 chars):', result.token.substring(0, 20) + '...');
        
        // Get device list for model detection
        await this.getDevices();
        
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
        
        this.setupServices();
      }
    } catch (error) {
      this.log.error('❌ Authentication failed:', error.message);
      throw error;
    }
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
      // Update our internal position tracking after each rotation
      this.currentTrayPosition = (this.currentTrayPosition + 1) % totalTrays;
      this.log(`📍 Internal position updated to tray ${this.currentTrayPosition + 1}`);
      // Small delay between rotations
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Verify we're at the expected position
    if (this.currentTrayPosition !== targetTray) {
      this.log.warn(`⚠️ Position mismatch! Expected tray ${targetTray + 1}, internal shows tray ${this.currentTrayPosition + 1}`);
      this.currentTrayPosition = targetTray; // Force correct position
    }
    
    // Update the fan service to reflect the new position with canonical percentage
    const newPercentage = this.trayPositionToPercentage(targetTray);
    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
      .updateValue(newPercentage);
    
    this.log(`✅ Successfully moved to tray ${targetTray + 1} (slider snapped to ${newPercentage}%)`);
  }
  

  
  async authenticate() {
    try {
      this.log('🔐 Authenticating with PetLibro API...');
      const result = await this.api.authenticate();
      
      if (result.success) {
        this.log('✅ Authentication successful!');
        this.log('Token (first 20 chars):', result.token.substring(0, 20) + '...');
        
        // Get device list for model detection
        await this.getDevices();
      }
    } catch (error) {
      this.log.error('❌ Authentication failed:', error.message);
      throw error;
    }
  }
  

  
  async getDevices() {
    try {
      this.log('🔍 Fetching device list from PetLibro API...');
      const result = await this.api.getDevices();
      
      if (result.success) {
        const devices = result.devices;
        
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
      
      // Get real-time device info using the API layer
      const result = await this.api.getDeviceRealInfo(this.deviceId);
      
      if (result.success) {
        const realInfo = result.data;
        this.log(`🔍 Raw device data:`, JSON.stringify(realInfo, null, 2));
        
        // Try different possible field names for plate position
        const platePosition = realInfo.platePosition || realInfo.plate || realInfo.currentPlate || 0;
        
        // Try different possible field names for temperature
        const deviceTemperature = realInfo.temperature || realInfo.temp || realInfo.currentTemp || 20.0;
        
        this.log(`🔍 Extracted values - platePosition: ${platePosition}, temperature: ${deviceTemperature}`);
        
        // Update current tray position
        this.currentTrayPosition = platePosition;
        
        // Update current temperature
        this.currentTemperature = deviceTemperature;
        
        // Update cache timestamp
        this.lastDataUpdate = Date.now();
        
        this.log(`🌡️ Current temperature from device: ${deviceTemperature}°C`);
        this.log(`🍽️ Current tray position from device: ${platePosition}`);
        
        // Update HomeKit services with new values
        if (this.trayFanService) {
          const percentage = this.trayPositionToPercentage(platePosition);
          this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
            .updateValue(percentage);
          this.log(`📲 Pushing tray position update to HomeKit: ${platePosition} (${percentage}%)`);
        }
        
        if (this.temperatureSensor) {
          this.temperatureSensor.getCharacteristic(this.platform.api.hap.Characteristic.CurrentTemperature)
            .updateValue(deviceTemperature);
          this.log(`📲 Pushing temperature update to HomeKit: ${deviceTemperature}°C`);
        }
        
      } else {
        this.log('⚠️ Failed to get device real info');
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
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot rotate tray');
      }
      
      const result = await this.api.rotateTray(this.deviceId);
      
      if (result.success) {
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
      this.log('🎧 Playing audio for Polar feeder');
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot play audio');
      }
      
      const result = await this.api.playAudio(this.deviceId);
      
      if (result.success) {
        this.log('✅ Audio playback successful');
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
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot control feeding');
      }
      
      if (start) {
        // Start manual feeding (open door)
        this.log('📡 Sending manual feed start command to Polar feeder');
        
        const result = await this.api.setManualFeed(this.deviceId, true);
        
        if (result.success) {
          this.log('✅ Manual feed started successfully');
          
          // Store the manual feed ID for stopping later
          this.manualFeedId = result.feedId;
          
          if (!this.manualFeedId) {
            this.log('⚠️ No feed ID returned from API, cannot stop feed later');
          } else {
            this.log(`📝 Stored manual feed ID: ${this.manualFeedId}`);
          }
        }
        
      } else {
        // Stop manual feeding (close door)
        if (!this.manualFeedId) {
          this.log('⚠️ No active manual feed to stop');
          return;
        }
        
        this.log(`📡 Sending manual feed stop command to Polar feeder with feedId: ${this.manualFeedId}`);
        
        const result = await this.api.stopManualFeed(this.deviceId, this.manualFeedId);
        
        if (result.success) {
          this.log('✅ Manual feed stopped successfully');
          this.manualFeedId = null;
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
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot send feed command');
      }
      
      this.log(`📡 Sending manual feed command to device: ${this.deviceId}`);
      this.log(`🍘 Portions to dispense: ${this.config.portions || 1}`);
      
      const result = await this.api.manualFeed(this.deviceId, parseInt(this.config.portions || 1));
      
      if (result.success) {
        this.log('✅ Manual feeding triggered successfully!');
        return;
      }
      
      throw new Error('Feed command failed');
      
    } catch (error) {
      this.log.error('💥 Failed to trigger feeding:', error.message);
      if (error.response) {
        this.log.error('   Response data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
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