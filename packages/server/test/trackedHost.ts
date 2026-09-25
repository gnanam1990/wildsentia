import { afterEach } from 'vitest';
import { SimHost as Host, type SimHostOptions } from '../src/simHost.js';
const hosts: Host[] = [];
export class SimHost extends Host {
  constructor(options: SimHostOptions) { super(options); hosts.push(this); }
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.abort(); });
