import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { PetlibroPlatform } from './platform';

export class PetlibroPlatformAccessory {
  private service;

  constructor(
    private readonly platform: PetlibroPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly feederId: string,
  ) {
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSwitchOn.bind(this));
  }

  async handleSwitchOn(value: CharacteristicValue) {
    if (value) {
      await this.platform.apiClient.feed(this.feederId);
    }
  }
}