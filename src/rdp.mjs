import net from 'node:net';
import { realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

// Minimal Firefox Remote Debugging Protocol client. This is intentionally
// separate from the WebDriver transports: RDP chrome actors do not create a
// Marionette/BiDi session.
export class RdpClient {
  constructor({ port, profile, timeout = 15000 }) {
    if (!profile || !profile.startsWith('/')) throw new Error('An absolute RDP profile path is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RDP port');
    this.port = port; this.profile = profile; this.timeout = timeout;
  }
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try { await this.connecting; }
    catch (error) { await this.disconnect(); throw error; }
    finally { this.connecting = null; }
  }
  async _connect() {
    this.expectedProfile = await realpath(this.profile);
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
    this.socket = socket; this.buffer = Buffer.alloc(0); this.events = [];
    socket.on('data', data => { this.buffer = Buffer.concat([this.buffer, data]); this._parse(); });
    socket.on('error', error => { this.socketError = error; });
    socket.on('close', () => { this.socketError ||= new Error('RDP connection closed'); this._wake?.(); this._wake = null; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RDP connection timeout')), this.timeout);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot connect to Zen RDP on 127.0.0.1:${this.port}: ${error.message}`)); });
    });
    const hello = await this._readMessage();
    if (!['gecko', 'browser'].includes(hello.applicationType)) throw new Error(`RDP endpoint is not a supported Gecko browser (${hello.applicationType || 'unknown application type'})`);
    await this.call('root', 'connect', { frontendVersion: '158.0' });
    const proc = await this.call('root', 'getProcess', { id: 0 });
    const processActor = proc.processDescriptor?.actor;
    if (!processActor) throw new Error('RDP process actor unavailable');
    const target = await this.call(processActor, 'getTarget');
    this.consoleActor = target.process?.consoleActor;
    if (!this.consoleActor) throw new Error('RDP process console actor unavailable');
    const identity = await this.evaluate('JSON.stringify({profile:Services.dirsvc.get("ProfD",Ci.nsIFile).path, webdriver:navigator.webdriver, pid:Services.appinfo.processID, app:Services.appinfo.name})');
    const parsed = JSON.parse(identity);
    if (!parsed.profile || await realpath(parsed.profile) !== this.expectedProfile) throw new Error('RDP profile mismatch: access refused');
    if (!/zen/i.test(parsed.app || '')) throw new Error('RDP target is not Zen Browser');
    if (parsed.webdriver) throw new Error('RDP target reports WebDriver automation; refusing extension operation');
    this.pid = parsed.pid;
    this.connected = true;
  }
  _parse() {
    while (true) {
      const colon = this.buffer.indexOf(58); if (colon < 0) { if (this.buffer.length > 16 * 1024 * 1024) { this.socketError = new Error('Oversized RDP frame header'); this.socket?.destroy(); this._wake?.(); } return; }
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) { this.socketError = new Error('Invalid or oversized RDP frame'); this.socket?.destroy(); this._wake?.(); this._wake = null; return; }
      if (this.buffer.length < colon + 1 + length) return;
      const payload = this.buffer.subarray(colon + 1, colon + 1 + length).toString();
      this.buffer = this.buffer.subarray(colon + 1 + length);
      try { this.events.push(JSON.parse(payload)); } catch { this.socketError = new Error('Invalid RDP JSON frame'); }
      this._wake?.(); this._wake = null;
    }
  }
  async _readMessage(timeout = this.timeout) {
    const end = Date.now() + timeout;
    while (!this.events.length) {
      if (this.socketError) throw this.socketError;
      const left = end - Date.now(); if (left <= 0) throw new Error('RDP response timeout');
      await new Promise(resolve => { this._wake = resolve; setTimeout(resolve, left); });
    }
    return this.events.shift();
  }
  async _takeMessage(predicate, timeout = this.timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const index = this.events.findIndex(predicate);
      if (index >= 0) return this.events.splice(index, 1)[0];
      if (this.socketError) throw this.socketError;
      await new Promise(resolve => { this._wake = resolve; setTimeout(resolve, Math.max(1, end - Date.now())); });
    }
    throw new Error('RDP response timeout');
  }
  async call(to, type, args = {}) {
    await this.connectSocketOnly();
    const payload = Buffer.from(JSON.stringify({ to, type, ...args }));
    this.socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
    const msg = await this._takeMessage(item => item.from === to);
    if (msg.error) throw new Error(msg.message || msg.error); return msg;
  }
  async connectSocketOnly() { if (!this.socket) await this.connect(); }
  async evaluate(text) {
    const ack = await this.call(this.consoleActor, 'evaluateJSAsync', { text });
    if (ack.error) throw new Error(ack.message || ack.error);
    const resultID = ack.resultID;
    const msg = await this._takeMessage(item => item.type === 'evaluationResult' && item.resultID === resultID);
    if (msg.hasException) throw new Error('RDP privileged evaluation failed');
    return msg.result;
  }
  async asyncValue(expression) {
    const key = `__zenMcp_${randomUUID().replaceAll('-', '')}`;
    await this.evaluate(`globalThis[${JSON.stringify(key)}]=null; Promise.resolve(${expression}).then(value=>globalThis[${JSON.stringify(key)}]={ok:true,value},error=>globalThis[${JSON.stringify(key)}]={ok:false,error:String(error)}); "started"`);
    const end = Date.now() + this.timeout;
    while (Date.now() < end) {
      const raw = await this.evaluate(`JSON.stringify(globalThis[${JSON.stringify(key)}])`);
      if (raw && raw !== 'null') {
        const result = JSON.parse(raw);
        await this.evaluate(`delete globalThis[${JSON.stringify(key)}]`);
        if (!result.ok) throw new Error(result.error);
        return result.value;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('RDP asynchronous operation timeout');
  }
  async installXpi({ path, id, version, sha256, force = false }) {
    const file = await realpath(path);
    const bytes = await readFile(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sha256.toLowerCase()) throw new Error('XPI SHA-256 mismatch');
    const installed = await this.getAddon(id);
    if (installed && !force && installed.version === version && installed.sha256 === digest && installed.active && !installed.temporary) return installed;
    const encodedPath = JSON.stringify(file);
    const result = await this.asyncValue(`(async()=>{const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");const f=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);f.initWithPath(${encodedPath});const i=await AddonManager.getInstallForFile(f);if(!i?.addon||i.addon.id!==${JSON.stringify(id)})throw Error("XPI add-on ID mismatch");if(i.addon.version!==${JSON.stringify(version)})throw Error("XPI version mismatch");await i.install();return true})()`);
    if (!result) throw new Error('Zen did not confirm XPI installation');
    return this.getAddon(id, digest, version);
  }
  async getAddon(id, expectedHash, expectedVersion, enforceState = true) {
    const addon = await this.asyncValue(`(async()=>{const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");const a=await AddonManager.getAddonByID(${JSON.stringify(id)});return a?{id:a.id,version:a.version,active:a.isActive,temporary:a.temporarilyInstalled,resource:a.getResourceURI("").spec}:null})()`);
    if (!addon) return null;
    const value = await this.evaluate(`JSON.stringify({profile:Services.dirsvc.get("ProfD",Ci.nsIFile).path})`);
    const profile = JSON.parse(value).profile;
    if (await realpath(profile) !== this.expectedProfile) throw new Error('RDP profile changed during operation');
    const installedFile = `${profile}/extensions/${id}.xpi`;
    const digest = createHash('sha256').update(await readFile(installedFile)).digest('hex');
    const info = { id: addon.id, version: addon.version, active: addon.active === true, temporary: addon.temporary === true, permanent: addon.temporary !== true, sha256: digest };
    if (expectedHash && digest !== expectedHash) throw new Error('Installed XPI SHA-256 verification failed');
    if (expectedVersion && addon.version !== expectedVersion) throw new Error('Installed add-on version verification failed');
    if (enforceState && (!info.active || !info.permanent)) throw new Error('Add-on is not permanently installed and active');
    return info;
  }
  async disconnect() { this.socket?.destroy(); this.socket = null; this.connected = false; this.consoleActor = null; this.events = []; }
}
