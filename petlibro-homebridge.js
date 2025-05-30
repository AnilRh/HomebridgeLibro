const axios = require('axios');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerAccessory("homebridge-petlibro", "PetLibroFeeder", PetLibroFeeder);
};

class PetLibroFeeder {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.name = config.name || 'Pet Feeder';
    
    // PetLibro API configuration
    this.email = config.email;
    this.password = config.password;
    this.deviceId = config.deviceId;
    this.baseUrl = 'https://app.petlibro.com';
    
    // Authentication tokens
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    
    // Service setup
    this.switchService = new Service.Switch(this.name);
    this.informationService = new Service.AccessoryInformation();
    
    this.setupInformationService();
    this.setupSwitchService();
    
    // Auto-authenticate on startup
    this.authenticate();
  }
  
  setupInformationService() {
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'PetLibro')
      .setCharacteristic(Characteristic.Model, 'Smart Feeder')
      .setCharacteristic(Characteristic.SerialNumber, this.deviceId || 'Unknown')
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');
  }
  
  setupSwitchService() {
    this.switchService
      .getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }
  
  async authenticate() {
    try {
      this.log('Authenticating with PetLibro API...');
      
      const response = await axios.post(`${this.baseUrl}/v3/user/login`, {
        email: this.email,
        password: this.password,
        platform: 'ios'
      }, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PetLibro/1.0.0',
          'Accept': 'application/json'
        }
      });
      
      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        this.log('Successfully authenticated with PetLibro API');
        
        // Get device list if deviceId not specified
        if (!this.deviceId) {
          await this.getDevices();
        }
      } else {
        throw new Error('Invalid authentication response');
      }
    } catch (error) {
      this.log.error('Authentication failed:', error.message);
      throw error;
    }
  }
  
  async refreshAuthToken() {
    if (!this.refreshToken) {
      return this.authenticate();
    }
    
    try {
      const response = await axios.post(`${this.baseUrl}/v3/user/refresh`, {
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
      await this.ensureAuthenticated();
      
      const response = await axios.get(`${this.baseUrl}/v3/devices`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.devices && response.data.devices.length > 0) {
        this.deviceId = response.data.devices[0].device_id;
        this.log(`Found device: ${response.data.devices[0].device_name} (${this.deviceId})`);
      }
    } catch (error) {
      this.log.error('Failed to get devices:', error.message);
    }
  }
  
  async ensureAuthenticated() {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.refreshAuthToken();
    }
  }
  
  async getOn() {
    // Always return false since this is a momentary switch for feeding
    return false;
  }
  
  async setOn(value) {
    if (value) {
      await this.triggerFeeding();
      
      // Reset switch to off after 1 second (momentary behavior)
      setTimeout(() => {
        this.switchService
          .getCharacteristic(Characteristic.On)
          .updateValue(false);
      }, 1000);
    }
  }
  
  async triggerFeeding() {
    try {
      await this.ensureAuthenticated();
      
      if (!this.deviceId) {
        throw new Error('Device ID not found');
      }
      
      this.log('Triggering manual feeding...');
      
      // This endpoint may need adjustment based on the actual API
      const response = await axios.post(`${this.baseUrl}/v3/devices/${this.deviceId}/feed`, {
        portions: this.config.portions || 1,
        type: 'manual'
      }, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.success) {
        this.log('Manual feeding triggered successfully');
      } else {
        throw new Error('Feeding request failed');
      }
    } catch (error) {
      this.log.error('Failed to trigger feeding:', error.message);
      throw new Error('Failed to trigger feeding');
    }
  }
  
  getServices() {
    return [this.informationService, this.switchService];
  }
}
