import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class PetlibroAPI {
  private token: string | null = null;
  private readonly baseUrl = 'https://api.us.petlibro.com';
  private readonly headers = {
    'Content-Type': 'application/json',
    'appId': '5f99958e68eb4aef84d8dd4b',
    'timeZone': 'America/New_York',
  };

  constructor(private config: any, private log: any) {}

  private md5(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  async login(): Promise<void> {
    const url = this.baseUrl + '/user/login';
    const data = {
      reqId: uuidv4(),
      appId: this.headers.appId,
      timeZone: this.headers.timeZone,
      email: this.config.email,
      password: this.md5(this.config.password),
    };

    const response = await axios.post(url, data, { headers: this.headers });
    this.log.debug('Login response:', response.data);

    if (response.data.code !== 0) {
      throw new Error(`Login failed: ${response.data.msg}`);
    }

    this.token = response.data.data.token;
    this.headers['Authorization'] = this.token;
  }

  async getDevices() {
    if (!this.token) await this.login();

    const url = this.baseUrl + '/device/device/list';
    const response = await axios.post(url, { reqId: uuidv4() }, { headers: this.headers });

    return response.data.data.deviceList || [];
  }

  async feed(deviceId: string): Promise<void> {
    if (!this.token) await this.login();

    const url = this.baseUrl + '/device/grain/feed';
    const data = {
      reqId: uuidv4(),
      deviceId,
      feedType: 1,
      portions: this.config.portion || 1,
    };

    await axios.post(url, data, { headers: this.headers });
  }
}