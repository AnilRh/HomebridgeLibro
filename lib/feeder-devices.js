const { Service, Characteristic } = require('hap-nodejs');

// Note: This file expects the API instance to be passed in as a CachedPetLibroAPI instance

/**
 * Base class for all PetLibro feeder devices
 */
class BaseFeeder {
  constructor(platform, accessory, config, api) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;
    this.api = api;
    this.log = platform.log;
    
    this.deviceId = null;
    this.deviceModel = null;
    this.services = [];
  }

  /**
   * Initialize the feeder device
   */
  async initialize() {
    await this.authenticate();
    this.setupServices();
  }

  /**
   * Authenticate with the API
   */
  async authenticate() {
    const result = await this.api.authenticate();
    if (result.success) {
      await this.discoverDevice();
    }
  }

  /**
   * Discover and configure the device
   */
  async discoverDevice() {
    const result = await this.api.getDevices();
    if (result.success) {
      const devices = result.devices;
      
      // Find the device by configured deviceId or first available
      let targetDevice = null;
      if (this.config.deviceId) {
        targetDevice = devices.find(device => device.deviceId === this.config.deviceId);
        if (!targetDevice) {
          this.log(`⚠️ Configured device ID ${this.config.deviceId} not found`);
          this.log('📋 Available devices:', devices.map(d => `${d.deviceName} (${d.deviceId})`).join(', '));
        }
      }
      
      if (!targetDevice && devices.length > 0) {
        targetDevice = devices[0];
        this.log(`🎯 Using first available device: ${targetDevice.deviceName} (${targetDevice.deviceId})`);
      }
      
      if (targetDevice) {
        this.deviceId = targetDevice.deviceId;
        this.deviceModel = targetDevice.deviceModel;
        this.deviceName = targetDevice.deviceName;
        
        this.log(`✅ Device configured: ${this.deviceName} (Model: ${this.deviceModel})`);
        
        // Update accessory information
        this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
          .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'PetLibro')
          .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.deviceModel || 'Unknown')
          .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.deviceId || 'Unknown');
      }
    }
  }

  /**
   * Setup HomeKit services - to be implemented by subclasses
   */
  setupServices() {
    throw new Error('setupServices must be implemented by subclass');
  }

  /**
   * Get all services for this device
   */
  getServices() {
    return this.services;
  }
}

/**
 * Standard PetLibro feeder (Granary, Space, Air, etc.)
 */
class StandardFeeder extends BaseFeeder {
  constructor(platform, accessory, config, api) {
    super(platform, accessory, config, api);
  }

  setupServices() {
    // Create manual feed switch service
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) ||
      this.accessory.addService(this.platform.api.hap.Service.Switch);

    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, 
      `${this.config.name || 'PetLibro Feeder'} Manual Feed`);

    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onSet(this.handleFeedSwitch.bind(this));

    this.services.push(this.switchService);
  }

  async handleFeedSwitch(value) {
    if (value) {
      this.log('🍽️ Manual feed switch turned ON - triggering feeding');
      
      try {
        await this.triggerFeeding();
        
        // Reset switch to off after successful feed
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
}

/**
 * Polar Wet Food Feeder (PLAF109) with advanced controls
 */
class PolarFeeder extends BaseFeeder {
  constructor(platform, accessory, config, api) {
    super(platform, accessory, config, api);
    
    // Polar-specific state
    this.manualFeedId = null;
    this.currentTrayPosition = 1;
    this.currentTemperature = 20.0;
    this.lastDataUpdate = 0;
    this.cacheValidityMs = 5 * 60 * 1000; // 5 minutes
  }

  setupServices() {
    this.setupDoorControl();
    this.setupTrayControl();
    this.setupAudioControl();
    this.setupTemperatureSensor();
  }

  setupDoorControl() {
    // Door control switch
    this.doorService = this.accessory.getService('Door Control') ||
      this.accessory.addService(this.platform.api.hap.Service.Switch, 'Door Control', 'door');

    this.doorService.setCharacteristic(this.platform.api.hap.Characteristic.Name, 
      `${this.config.name || 'Polar Feeder'} Door`);

    this.doorService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onSet(this.handleDoorSwitch.bind(this));

    this.services.push(this.doorService);
  }

  setupTrayControl() {
    // Tray selection fan service (slider)
    this.trayFanService = this.accessory.getService('Tray Selection') ||
      this.accessory.addService(this.platform.api.hap.Service.Fan, 'Tray Selection', 'tray');

    this.trayFanService.setCharacteristic(this.platform.api.hap.Characteristic.Name, 
      `${this.config.name || 'Polar Feeder'} Tray`);

    // Configure fan characteristics for tray selection
    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onSet(() => true); // Always on for slider functionality

    this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.handleTraySelection.bind(this))
      .onGet(this.getTrayPosition.bind(this));

    this.services.push(this.trayFanService);
  }

  setupAudioControl() {
    // Ring Bell button using StatelessProgrammableSwitch
    this.audioService = this.accessory.getService('Ring Bell') ||
      this.accessory.addService(this.platform.api.hap.Service.StatelessProgrammableSwitch, 'Ring Bell', 'audio');

    this.audioService.setCharacteristic(this.platform.api.hap.Characteristic.Name, 
      `${this.config.name || 'Polar Feeder'} Ring Bell`);

    // Configure button properties
    this.audioService.setCharacteristic(this.platform.api.hap.Characteristic.ServiceLabelIndex, 1);
    
    // For StatelessProgrammableSwitch, we need to handle the button press event
    // The button press is detected when HomeKit tries to read the ProgrammableSwitchEvent
    this.audioService.getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent)
      .onGet(async () => {
        // When HomeKit requests the button state, it means the button was pressed
        this.log('🔔 Ring bell button pressed!');
        
        // Trigger the audio playback
        this.handleAudioButton().catch(error => {
          this.log.error('Button press handler error:', error.message);
        });
        
        // Return the single press event
        return this.platform.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
      });

    this.services.push(this.audioService);
  }

  setupTemperatureSensor() {
    // Temperature sensor
    this.temperatureSensor = this.accessory.getService('Temperature') ||
      this.accessory.addService(this.platform.api.hap.Service.TemperatureSensor, 'Temperature', 'temp');

    this.temperatureSensor.setCharacteristic(this.platform.api.hap.Characteristic.Name, 
      `${this.config.name || 'Polar Feeder'} Temperature`);

    this.temperatureSensor.getCharacteristic(this.platform.api.hap.Characteristic.CurrentTemperature)
      .onGet(this.getTemperature.bind(this));

    this.services.push(this.temperatureSensor);
  }

  // Door control methods
  async handleDoorSwitch(value) {
    try {
      this.log(`🚪 ${value ? 'Opening' : 'Closing'} door for Polar feeder`);
      
      if (value) {
        // Open door - start manual feeding
        await this.startManualFeed();
      } else {
        // Close door - stop manual feeding
        await this.stopManualFeed();
      }
      
    } catch (error) {
      this.log.error(`Failed to ${value ? 'open' : 'close'} door:`, error.message);
      // Reset switch state on error
      setTimeout(() => {
        this.doorService.getCharacteristic(this.platform.api.hap.Characteristic.On)
          .updateValue(!value);
      }, 100);
    }
  }

  async startManualFeed() {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot control feeding');
    }
    
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
  }

  async stopManualFeed() {
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

  // Tray control methods
  async handleTraySelection(value) {
    try {
      const targetTray = this.percentageToTrayPosition(value);
      this.log(`🎯 Tray selection: ${value}% -> Tray ${targetTray}`);
      
      await this.rotateTrayToPosition(targetTray);
      
      // Snap to canonical percentage for the selected tray
      const canonicalPercentage = this.trayPositionToPercentage(targetTray);
      if (canonicalPercentage !== value) {
        setTimeout(() => {
          this.trayFanService.getCharacteristic(this.platform.api.hap.Characteristic.RotationSpeed)
            .updateValue(canonicalPercentage);
        }, 100);
      }
      
    } catch (error) {
      this.log.error('Failed to select tray:', error.message);
    }
  }

  async getTrayPosition() {
    await this.updateDeviceData();
    return this.trayPositionToPercentage(this.currentTrayPosition);
  }

  async rotateTrayToPosition(targetTray) {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot rotate tray');
    }
    
    // Update current position first
    await this.updateDeviceData(true);
    
    const currentTray = this.currentTrayPosition;
    if (currentTray === targetTray) {
      this.log(`✅ Tray already at position ${targetTray}`);
      return;
    }
    
    // Calculate optimal rotation path
    const rotations = this.calculateOptimalRotations(currentTray, targetTray);
    this.log(`🔄 Rotating tray ${rotations} times: ${currentTray} -> ${targetTray}`);
    
    for (let i = 0; i < rotations; i++) {
      const result = await this.api.rotateTray(this.deviceId);
      
      if (result.success) {
        this.log(`✅ Tray rotation ${i + 1}/${rotations} successful`);
        
        // Update internal state after each rotation
        this.currentTrayPosition = (this.currentTrayPosition % 3) + 1;
        
        // Wait between rotations
        if (i < rotations - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else {
        throw new Error(`Tray rotation ${i + 1} failed`);
      }
    }
    
    // Update device data after rotation sequence
    setTimeout(() => {
      this.updateDeviceData(true).catch(error => {
        this.log.error('Failed to update tray position after rotation:', error.message);
      });
    }, 1000);
  }

  calculateOptimalRotations(current, target) {
    // Calculate forward rotations needed (1->2->3->1)
    let rotations = 0;
    let pos = current;
    
    while (pos !== target && rotations < 3) {
      pos = (pos % 3) + 1;
      rotations++;
    }
    
    return rotations;
  }

  percentageToTrayPosition(percentage) {
    if (percentage <= 33) return 1;
    if (percentage <= 66) return 2;
    return 3;
  }

  trayPositionToPercentage(position) {
    switch (position) {
      case 1: return 0;
      case 2: return 50;
      case 3: return 100;
      default: return 0;
    }
  }

  // Audio control methods
  async handleAudioButton() {
    try {
      this.log('🔔 Ring bell button pressed for Polar feeder');
      
      if (!this.deviceId) {
        throw new Error('Device ID not found - cannot play audio');
      }
      
      const result = await this.api.playAudio(this.deviceId);
      
      if (result.success) {
        this.log('✅ Bell ring successful');
      }
      
    } catch (error) {
      this.log.error('Failed to ring bell:', error.message);
    }
  }

  // Temperature sensor methods
  async getTemperature() {
    await this.updateDeviceData();
    return this.currentTemperature;
  }

  async updateDeviceData(forceUpdate = false) {
    try {
      // Check if we have fresh data (within 5 minutes) and not forcing update
      const now = Date.now();
      const cacheAge = (now - this.lastDataUpdate) / 1000; // seconds
      if (!forceUpdate && (now - this.lastDataUpdate) < this.cacheValidityMs) {
        this.log(`💾 Using cached device data (${Math.round(cacheAge)}s old, cache valid for ${this.cacheValidityMs/1000}s)`);
        return;
      }
      
      this.log(`🔄 Fetching fresh device data (cache ${Math.round(cacheAge)}s old, forceUpdate: ${forceUpdate})`);
      
      // Get real-time device info using the API layer
      const result = await this.api.getDeviceRealInfo(this.deviceId);
      
      if (result.success) {
        const realInfo = result.data;
        this.log(`🔍 Raw device data:`, JSON.stringify(realInfo, null, 2));
        
        // Try different possible field names for plate position
        const platePosition = realInfo.platePosition || realInfo.plate || realInfo.currentPlate || 1;
        
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
      this.log.error('Failed to get current device data:', error.message);
    }
  }
}

module.exports = {
  BaseFeeder,
  StandardFeeder,
  PolarFeeder
};
