import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PetlibroPlatformAccessory } from './petlibroPlatformAccessory';
import { PetlibroAPI } from './petlibroApi';

export class PetlibroPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly apiClient: PetlibroAPI;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.apiClient = new PetlibroAPI(config, log);

    this.api.on('didFinishLaunching', async () => {
      const devices = await this.apiClient.getDevices();
      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.deviceId);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        new PetlibroPlatformAccessory(this, accessory, device.deviceId);
        this.api.registerPlatformAccessories('homebridge-petlibro', 'PetlibroPlatform', [accessory]);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }
}