const axios = require('axios');
const crypto = require('crypto');

/**
 * PetLibro API Client
 * Handles all API interactions with the PetLibro service
 */
class PetLibroAPI {
  constructor(config = {}) {
    this.baseUrl = 'https://api.us.petlibro.com';
    this.email = config.email;
    this.password = config.password;
    this.timezone = config.timezone || 'America/New_York';
    
    // Authentication state
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
    
    // Request timeout
    this.timeout = config.timeout || 10000;
  }

  /**
   * Hash password using MD5 (matches HomeAssistant implementation)
   */
  hashPassword(password) {
    return crypto.createHash('md5').update(password).digest('hex');
  }

  /**
   * Get common headers for API requests
   */
  getHeaders(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
      'source': 'ANDROID',
      'language': 'EN',
      'timezone': this.timezone,
      'version': '1.3.45'
    };

    if (includeAuth && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      headers['token'] = this.accessToken;
    }

    return headers;
  }

  /**
   * Check if current token is expired
   */
  isTokenExpired() {
    return Date.now() >= this.tokenExpiry;
  }

  /**
   * Ensure we have a valid authentication token
   */
  async ensureAuthenticated() {
    if (!this.accessToken || this.isTokenExpired()) {
      if (this.refreshToken) {
        try {
          await this.refreshAuthToken();
        } catch (error) {
          // If refresh fails, do full authentication
          await this.authenticate();
        }
      } else {
        await this.authenticate();
      }
    }
  }

  /**
   * Authenticate with PetLibro API
   */
  async authenticate() {
    if (!this.email || !this.password) {
      throw new Error('Email and password are required');
    }

    try {
      // Use exact HomeAssistant format
      const payload = {
        appId: 1,
        appSn: 'c35772530d1041699c87fe62348507a8',
        country: 'US',
        email: this.email,
        password: this.hashPassword(this.password),
        phoneBrand: '',
        phoneSystemVersion: '',
        timezone: this.timezone,
        thirdId: null,
        type: null
      };

      const response = await axios.post(`${this.baseUrl}/member/auth/login`, payload, {
        headers: this.getHeaders(false),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0 && response.data.data) {
        const data = response.data.data;
        this.accessToken = data.token;
        this.refreshToken = data.refreshToken;
        // Set expiry to 23 hours from now (tokens typically last 24 hours)
        this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
        
        return {
          success: true,
          token: this.accessToken,
          refreshToken: this.refreshToken
        };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Authentication failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Authentication failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Refresh authentication token
   */
  async refreshAuthToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post(`${this.baseUrl}/member/auth/refresh`, {
        refresh_token: this.refreshToken
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        return { success: true, token: this.accessToken };
      } else {
        throw new Error('Invalid refresh response');
      }
    } catch (error) {
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  /**
   * Get list of devices from PetLibro API
   */
  async getDevices() {
    await this.ensureAuthenticated();

    try {
      const response = await axios.post(`${this.baseUrl}/device/device/list`, {}, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0 && response.data.data) {
        return {
          success: true,
          devices: response.data.data
        };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Get devices failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Get devices failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Get devices failed: ${error.message}`);
    }
  }

  /**
   * Get real-time device information
   */
  async getDeviceRealInfo(deviceId) {
    await this.ensureAuthenticated();

    try {
      const response = await axios.post(`${this.baseUrl}/device/device/realInfo`, {
        id: deviceId,
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0 && response.data.data) {
        return {
          success: true,
          data: response.data.data
        };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Get device info failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Get device info failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Get device info failed: ${error.message}`);
    }
  }

  /**
   * Control manual feeding (start/stop)
   */
  async setManualFeed(deviceId, start = true) {
    await this.ensureAuthenticated();

    try {
      if (start) {
        // Start manual feeding
        const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/manualFeedNow`, {
          deviceSn: deviceId,
          plate: 1
        }, {
          headers: this.getHeaders(),
          timeout: this.timeout
        });

        if (response.data && response.data.code === 0) {
          // Try to extract feed ID from response
          let feedId = null;
          if (response.data.data) {
            feedId = response.data.data.manualFeedId || response.data.data.feedId || response.data.data.id;
          }
          
          // If no feed ID in response, generate a placeholder ID
          // This is a workaround for the API not always returning feed IDs
          if (!feedId) {
            feedId = `manual_feed_${deviceId}_${Date.now()}`;
            console.log(`⚠️ No feed ID returned from API, using placeholder: ${feedId}`);
          }
          
          return {
            success: true,
            feedId: feedId
          };
        } else {
          const errorMsg = response.data?.msg || 'Unknown error';
          throw new Error(`Start manual feed failed: ${errorMsg} (code: ${response.data?.code})`);
        }
      } else {
        throw new Error('Stop manual feed requires feedId - use stopManualFeed() method instead');
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Manual feed failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Manual feed failed: ${error.message}`);
    }
  }

  /**
   * Stop manual feeding
   */
  async stopManualFeed(deviceId, feedId) {
    await this.ensureAuthenticated();

    if (!feedId) {
      throw new Error('Feed ID is required to stop manual feeding');
    }

    try {
      // Check if this is a placeholder feed ID (our workaround)
      const isPlaceholderFeedId = feedId.startsWith('manual_feed_');
      
      if (isPlaceholderFeedId) {
        // For placeholder IDs, try to get the actual feed ID from device status
        console.log(`🔍 Attempting to find actual feed ID for placeholder: ${feedId}`);
        
        // Try to get real-time device info to find active feed
        const deviceInfo = await this.getDeviceRealInfo(deviceId);
        if (deviceInfo.success && deviceInfo.data) {
          // Look for active feed ID in device data
          const realFeedId = deviceInfo.data.activeFeedId || deviceInfo.data.currentFeedId || deviceInfo.data.feedId;
          if (realFeedId) {
            console.log(`✅ Found actual feed ID: ${realFeedId}`);
            feedId = realFeedId;
          } else {
            console.log(`⚠️ No active feed ID found in device data, trying direct stop command`);
            // If we can't find a real feed ID, try a direct stop command without feed ID
            return await this.forceStopFeed(deviceId);
          }
        }
      }

      const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/stopFeedNow`, {
        deviceSn: deviceId,
        feedId: feedId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0) {
        return { success: true };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Stop manual feed failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Stop manual feed failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Stop manual feed failed: ${error.message}`);
    }
  }

  /**
   * Force stop feeding without feed ID (fallback method)
   */
  async forceStopFeed(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      // Try multiple approaches to stop feeding
      const approaches = [
        // Approach 1: Try stop with a generic feed ID
        async () => {
          const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/stopFeedNow`, {
            deviceSn: deviceId,
            feedId: 0  // Try with feed ID 0
          }, {
            headers: this.getHeaders(),
            timeout: this.timeout
          });
          return response;
        },
        
        // Approach 2: Try the alternative stop endpoint
        async () => {
          const response = await axios.post(`${this.baseUrl}/device/device/setStopFeedNow`, {
            deviceSn: deviceId
          }, {
            headers: this.getHeaders(),
            timeout: this.timeout
          });
          return response;
        },
        
        // Approach 3: Try manual feed with stop parameter
        async () => {
          const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/manualFeedNow`, {
            deviceSn: deviceId,
            action: 'stop'
          }, {
            headers: this.getHeaders(),
            timeout: this.timeout
          });
          return response;
        }
      ];
      
      for (let i = 0; i < approaches.length; i++) {
        try {
          console.log(`🔄 Trying force stop approach ${i + 1}/${approaches.length}`);
          const response = await approaches[i]();
          
          if (response.data && response.data.code === 0) {
            console.log(`✅ Force stop successful with approach ${i + 1}`);
            return { success: true };
          } else {
            console.log(`⚠️ Approach ${i + 1} failed: ${response.data?.msg || 'Unknown error'}`);
          }
        } catch (error) {
          console.log(`❌ Approach ${i + 1} error: ${error.message}`);
        }
      }
      
      // If all approaches failed
      return { success: false, error: 'All force stop approaches failed' };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Rotate food tray/bowl
   */
  async rotateTray(deviceId) {
    await this.ensureAuthenticated();

    try {
      const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/platePositionChange`, {
        deviceSn: deviceId,
        plate: 1
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0) {
        return { success: true };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Rotate tray failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device grain/food status
   */
  async getDeviceGrainStatus(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/data/grainStatus`, {
        id: deviceId,
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to get device grain status' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device feeding plan for today
   */
  async getDeviceFeedingPlanToday(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/device/getfeedingplantoday_new`, {
        id: deviceId,
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to get feeding plan today' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device wet feeding plan
   */
  async getDeviceWetFeedingPlan(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/device/wetFeedingPlan`, {
        id: deviceId,
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to get wet feeding plan' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device work record/history
   */
  async getDeviceWorkRecord(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/device/workRecord`, {
        id: deviceId,
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to get device work record' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get default matrix settings for device
   */
  async getDefaultMatrix(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.get(`${this.baseUrl}/device/device/getDefaultMatrix`, {
        params: { deviceSn: deviceId },
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to get default matrix' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Play feeding audio
   */
  async playAudio(deviceId) {
    await this.ensureAuthenticated();

    try {
      const response = await axios.post(`${this.baseUrl}/device/wetFeedingPlan/feedAudio`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      if (response.data && response.data.code === 0) {
        return { success: true };
      } else {
        const errorMsg = response.data?.msg || 'Unknown error';
        throw new Error(`Play audio failed: ${errorMsg} (code: ${response.data?.code})`);
      }
    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.msg || 'HTTP error';
        throw new Error(`Play audio failed: ${errorMsg} (status: ${error.response.status})`);
      }
      throw new Error(`Play audio failed: ${error.message}`);
    }
  }
  // ===== ADVANCED FEEDER CONTROLS =====

  /**
   * Set lid close time
   */
  async setLidCloseTime(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setLidCloseTime`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set lid close time' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set lid speed
   */
  async setLidSpeed(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setLidSpeed`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set lid speed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set lid mode
   */
  async setLidMode(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setLidMode`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set lid mode' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Manual lid open
   */
  async setManualLidOpen(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setManualLidOpen`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to open lid manually' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===== WATER DISPENSER CONTROLS =====

  /**
   * Set water dispensing interval
   */
  async setWaterInterval(deviceId, value, currentMode, currentDuration) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setWaterInterval`, {
        deviceSn: deviceId,
        value: value,
        currentMode: currentMode,
        currentDuration: currentDuration
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set water interval' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set water dispensing duration
   */
  async setWaterDispensingDuration(deviceId, value, currentMode, currentInterval) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setWaterDispensingDuration`, {
        deviceSn: deviceId,
        value: value,
        currentMode: currentMode,
        currentInterval: currentInterval
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set water dispensing duration' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set water dispensing mode
   */
  async setWaterDispensingMode(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setWaterDispensingMode`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set water dispensing mode' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===== DISPLAY & INTERFACE CONTROLS =====

  /**
   * Set display icon
   */
  async setDisplayIcon(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setDisplayIcon`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set display icon' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set display text
   */
  async setDisplayText(deviceId, value) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setDisplayText`, {
        deviceSn: deviceId,
        value: value
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to set display text' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Turn display on
   */
  async setDisplayOn(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setDisplayOn`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to turn display on' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Turn display off
   */
  async setDisplayOff(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setDisplayOff`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to turn display off' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Turn sound on
   */
  async setSoundOn(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setSoundOn`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to turn sound on' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Turn sound off
   */
  async setSoundOff(deviceId) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setSoundOff`, {
        deviceSn: deviceId
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to turn sound off' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===== SCHEDULE MANAGEMENT =====

  /**
   * Reposition/modify feeding schedule
   */
  async setRepositionSchedule(deviceId, plan, templateName) {
    try {
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/setting/setRepositionSchedule`, {
        deviceSn: deviceId,
        plan: plan,
        templateName: templateName
      }, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });
      
      if (response.data && response.data.code === 0) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data?.msg || 'Failed to reposition schedule' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===== UTILITY METHODS =====

  /**
   * Logout and clear tokens
   */
  async logout() {
    try {
      if (this.accessToken) {
        await axios.post(`${this.baseUrl}/user/logout`, {}, {
          headers: this.getHeaders(),
          timeout: this.timeout
        });
      }
    } catch (error) {
      // Ignore logout errors
    } finally {
      // Clear tokens regardless of logout success
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiry = 0;
    }
    
    return { success: true };
  }

  /**
   * Set logger instance for debugging
   */
  setLogger(logger) {
    this.log = logger;
  }
}

module.exports = PetLibroAPI;
