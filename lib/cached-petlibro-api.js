const PetLibroAPI = require('./petlibro-api');

/**
 * Cache entry structure
 */
class CacheEntry {
  constructor(data, ttl) {
    this.data = data;
    this.timestamp = Date.now();
    this.expiresAt = Date.now() + ttl;
  }

  isValid() {
    return Date.now() < this.expiresAt;
  }

  getAge() {
    return Date.now() - this.timestamp;
  }
}

/**
 * Cached wrapper for PetLibroAPI with intelligent caching strategies
 */
class CachedPetLibroAPI {
  constructor(config) {
    this.api = new PetLibroAPI(config);
    this.cache = new Map();
    this.config = config;
    
    // Cache durations in milliseconds
    this.CACHE_DURATIONS = {
      authentication: 50 * 60 * 1000,    // 50 minutes (tokens expire in 1 hour)
      deviceList: 30 * 60 * 1000,        // 30 minutes (devices don't change often)
      deviceRealInfo: 2 * 60 * 1000,     // 2 minutes (temperature/tray position)
      feedingStatus: 30 * 1000,          // 30 seconds (active feeding state)
      controlAction: 5 * 1000             // 5 seconds (recent control actions)
    };
    
    // Cache statistics for monitoring
    this.stats = {
      hits: 0,
      misses: 0,
      invalidations: 0,
      errors: 0
    };
    
    // Background refresh intervals
    this.backgroundRefreshEnabled = true;
    this.refreshIntervals = new Map();
    
    this.log = console.log; // Will be overridden by the calling code
  }

  /**
   * Set logger instance
   */
  setLogger(logger) {
    this.log = logger;
    this.api.setLogger(logger);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests * 100).toFixed(1) : 0;
    
    return {
      ...this.stats,
      totalRequests,
      hitRate: `${hitRate}%`,
      cacheSize: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }

  /**
   * Clear all cache entries
   */
  clearCache() {
    const clearedEntries = this.cache.size;
    this.cache.clear();
    this.stats.invalidations += clearedEntries;
    this.log(`🗑️ Cleared ${clearedEntries} cache entries`);
  }

  /**
   * Clear specific cache entries by pattern
   */
  invalidateCache(pattern) {
    let invalidated = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        invalidated++;
      }
    }
    this.stats.invalidations += invalidated;
    if (invalidated > 0) {
      this.log(`🗑️ Invalidated ${invalidated} cache entries matching: ${pattern}`);
    }
  }

  /**
   * Get cached data or fetch from API
   */
  async getCachedData(cacheKey, fetchFunction, cacheDuration, forceRefresh = false) {
    // Check cache first (unless forcing refresh)
    if (!forceRefresh && this.cache.has(cacheKey)) {
      const entry = this.cache.get(cacheKey);
      if (entry.isValid()) {
        this.stats.hits++;
        const age = Math.round(entry.getAge() / 1000);
        this.log(`💾 Cache hit for ${cacheKey} (age: ${age}s)`);
        return entry.data;
      } else {
        // Remove expired entry
        this.cache.delete(cacheKey);
      }
    }

    // Cache miss - fetch from API
    this.stats.misses++;
    this.log(`🌐 Cache miss for ${cacheKey} - fetching from API`);
    
    try {
      const result = await fetchFunction();
      
      // Cache successful results
      if (result && result.success) {
        const entry = new CacheEntry(result, cacheDuration);
        this.cache.set(cacheKey, entry);
        this.log(`💾 Cached ${cacheKey} for ${Math.round(cacheDuration / 1000)}s`);
      }
      
      return result;
    } catch (error) {
      this.stats.errors++;
      this.log(`❌ Error fetching ${cacheKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Authentication with caching
   */
  async authenticate(forceRefresh = false) {
    const cacheKey = `auth:${this.config.email}`;
    
    return this.getCachedData(
      cacheKey,
      () => this.api.authenticate(),
      this.CACHE_DURATIONS.authentication,
      forceRefresh
    );
  }

  /**
   * Get devices with caching
   */
  async getDevices(forceRefresh = false) {
    const cacheKey = `devices:${this.config.email}`;
    
    return this.getCachedData(
      cacheKey,
      () => this.api.getDevices(),
      this.CACHE_DURATIONS.deviceList,
      forceRefresh
    );
  }

  /**
   * Get device real-time info with caching
   */
  async getDeviceRealInfo(deviceId, forceRefresh = false) {
    const cacheKey = `realInfo:${deviceId}`;
    
    return this.getCachedData(
      cacheKey,
      () => this.api.getDeviceRealInfo(deviceId),
      this.CACHE_DURATIONS.deviceRealInfo,
      forceRefresh
    );
  }

  /**
   * Manual feed with cache invalidation
   */
  async manualFeed(deviceId, portions) {
    const result = await this.api.manualFeed(deviceId, portions);
    
    if (result.success) {
      // Invalidate device status cache after feeding
      this.invalidateCache(`realInfo:${deviceId}`);
      this.invalidateCache(`feedingStatus:${deviceId}`);
    }
    
    return result;
  }

  /**
   * Set manual feed with cache invalidation
   */
  async setManualFeed(deviceId, start) {
    const result = await this.api.setManualFeed(deviceId, start);
    
    if (result.success) {
      // Invalidate device status cache after feed control
      this.invalidateCache(`realInfo:${deviceId}`);
      this.invalidateCache(`feedingStatus:${deviceId}`);
      
      // Cache the control action briefly to prevent rapid repeated calls
      const actionKey = `controlAction:setManualFeed:${deviceId}:${start}`;
      const entry = new CacheEntry(result, this.CACHE_DURATIONS.controlAction);
      this.cache.set(actionKey, entry);
    }
    
    return result;
  }

  /**
   * Stop manual feed with cache invalidation
   */
  async stopManualFeed(deviceId, feedId) {
    const result = await this.api.stopManualFeed(deviceId, feedId);
    
    if (result.success) {
      // Invalidate device status cache after stopping feed
      this.invalidateCache(`realInfo:${deviceId}`);
      this.invalidateCache(`feedingStatus:${deviceId}`);
    }
    
    return result;
  }

  /**
   * Rotate tray with cache invalidation
   */
  async rotateTray(deviceId) {
    const result = await this.api.rotateTray(deviceId);
    
    if (result.success) {
      // Invalidate tray position cache after rotation
      this.invalidateCache(`realInfo:${deviceId}`);
      
      // Cache the rotation action briefly to prevent rapid repeated calls
      const actionKey = `controlAction:rotateTray:${deviceId}`;
      const entry = new CacheEntry(result, this.CACHE_DURATIONS.controlAction);
      this.cache.set(actionKey, entry);
    }
    
    return result;
  }

  /**
   * Play audio with cache invalidation
   */
  async playAudio(deviceId) {
    const result = await this.api.playAudio(deviceId);
    
    if (result.success) {
      // Cache the audio action briefly to prevent rapid repeated calls
      const actionKey = `controlAction:playAudio:${deviceId}`;
      const entry = new CacheEntry(result, this.CACHE_DURATIONS.controlAction);
      this.cache.set(actionKey, entry);
    }
    
    return result;
  }

  /**
   * Start background refresh for critical data
   */
  startBackgroundRefresh(deviceId) {
    if (!this.backgroundRefreshEnabled) return;
    
    const refreshKey = `refresh:${deviceId}`;
    
    // Don't start multiple refresh intervals for the same device
    if (this.refreshIntervals.has(refreshKey)) {
      return;
    }
    
    // Refresh device real info every 90 seconds (before 2-minute cache expires)
    const interval = setInterval(async () => {
      try {
        await this.getDeviceRealInfo(deviceId, true);
        this.log(`🔄 Background refresh completed for device ${deviceId}`);
      } catch (error) {
        this.log(`⚠️ Background refresh failed for device ${deviceId}:`, error.message);
      }
    }, 90 * 1000);
    
    this.refreshIntervals.set(refreshKey, interval);
    this.log(`🔄 Started background refresh for device ${deviceId}`);
  }

  /**
   * Stop background refresh
   */
  stopBackgroundRefresh(deviceId) {
    const refreshKey = `refresh:${deviceId}`;
    
    if (this.refreshIntervals.has(refreshKey)) {
      clearInterval(this.refreshIntervals.get(refreshKey));
      this.refreshIntervals.delete(refreshKey);
      this.log(`⏹️ Stopped background refresh for device ${deviceId}`);
    }
  }

  /**
   * Stop all background refresh intervals
   */
  stopAllBackgroundRefresh() {
    for (const [key, interval] of this.refreshIntervals) {
      clearInterval(interval);
    }
    this.refreshIntervals.clear();
    this.log(`⏹️ Stopped all background refresh intervals`);
  }

  /**
   * Cleanup method for graceful shutdown
   */
  cleanup() {
    this.stopAllBackgroundRefresh();
    this.clearCache();
  }

  /**
   * Get cache entry info for debugging
   */
  getCacheEntryInfo(cacheKey) {
    if (!this.cache.has(cacheKey)) {
      return null;
    }
    
    const entry = this.cache.get(cacheKey);
    return {
      key: cacheKey,
      age: Math.round(entry.getAge() / 1000),
      ttl: Math.round((entry.expiresAt - Date.now()) / 1000),
      valid: entry.isValid(),
      data: entry.data
    };
  }

  /**
   * Debug method to log cache status
   */
  logCacheStatus() {
    const stats = this.getCacheStats();
    this.log('📊 Cache Statistics:', {
      hitRate: stats.hitRate,
      totalRequests: stats.totalRequests,
      cacheSize: stats.cacheSize,
      backgroundRefreshActive: this.refreshIntervals.size
    });
    
    // Log cache entries
    for (const key of this.cache.keys()) {
      const info = this.getCacheEntryInfo(key);
      this.log(`  ${key}: age=${info.age}s, ttl=${info.ttl}s, valid=${info.valid}`);
    }
  }
}

module.exports = CachedPetLibroAPI;
