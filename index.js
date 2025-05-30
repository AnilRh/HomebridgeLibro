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
    
    // Get or create the switch service
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) 
      || this.accessory.addService(this.platform.api.hap.Service.Switch);
    
    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.name);
    
    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    
    // Auto-authenticate on startup (with error handling)
    this.authenticate().catch(error => {
      this.log.error('Failed to authenticate during startup:', error.message);
      this.log.error('Plugin will continue to retry authentication when used');
    });
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
          
          // Get device list if deviceId not specified
          if (!this.deviceId) {
            await this.getDevices();
          }
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
          const device = devices[0];
          
          // Look for device ID in different possible fields
          this.deviceId = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
          const deviceName = device.deviceName || device.device_name || device.name || 'Unknown Device';
          
          this.log(`✅ Found device: ${deviceName} (ID: ${this.deviceId})`);
          this.log(`📱 Device details:`, JSON.stringify(device, null, 2));
          return;
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
    return [this.informationService, this.switchService];
  }
}