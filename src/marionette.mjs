import net from 'node:net';
import { realpath } from 'node:fs/promises';

// Length-prefixed UTF-8 frames; never retry a command that might have mutated Zen.
export class MarionetteClient {
  constructor({ port, profile, timeout = 15000 }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native port');
    if (!profile || !profile.startsWith('/')) throw new Error('An absolute native profile path is required');
    this.port = port; this.profile = profile; this.timeout = timeout;
    this.pending = new Map(); this.sequence = 0; this.queue = Promise.resolve();
  }
  async connect() {
    if (this.socket && !this.socket.destroyed && this.ready) return;
    const expected = await realpath(this.profile);
    this.buffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket?.destroy(); reject(new Error('Native connection timed out')); }, this.timeout);
      this.hello = () => { clearTimeout(timer); resolve(); };
      this.socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket.on('data', chunk => this.receive(chunk));
      this.socket.on('error', error => { clearTimeout(timer); reject(error); this.fail(error); });
      this.socket.on('close', () => this.fail(new Error('Native connection closed')));
    });
    try {
      const session = await this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
      const actual = session.capabilities?.['moz:profile'];
      if (!actual || await realpath(actual) !== expected) throw new Error('Native profile mismatch: access refused');
      await this.send('Marionette:SetContext', { value: 'chrome' });
      const identity = await this.send('WebDriver:ExecuteScript', { script: 'return {profile: Services.dirsvc.get("ProfD", Ci.nsIFile).path, zen: !!window.gZenWorkspaces};', args: [], newSandbox: false });
      if (!identity.value?.zen || await realpath(identity.value.profile) !== expected) throw new Error('Expected Zen profile is not available');
      this.ready = true;
    } catch (error) { await this.disconnect(); throw error; }
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const colon = this.buffer.indexOf(58);
        if (colon < 0) { if (this.buffer.length > 12) throw new Error('Invalid native frame'); return; }
        const header = this.buffer.subarray(0, colon).toString();
        if (!/^\d+$/.test(header)) throw new Error('Invalid native frame length');
        const size = Number(header);
        if (size > 32 * 1024 * 1024) throw new Error('Native frame too large');
        if (this.buffer.length < colon + 1 + size) return;
        const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + size).toString());
        this.buffer = this.buffer.subarray(colon + 1 + size);
        if (!Array.isArray(message)) { if (message.marionetteProtocol !== 3) throw new Error('Unsupported Marionette protocol'); this.hello?.(); continue; }
        const [type, id, error, result] = message;
        if (type !== 1 || !this.pending.has(id)) continue;
        const call = this.pending.get(id); clearTimeout(call.timer); this.pending.delete(id);
        if (error) call.reject(new Error(`${error.error}: ${error.message}`)); else call.resolve(result);
      }
    } catch (error) { this.fail(error); this.socket?.destroy(); }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native command timed out (${method}); outcome may be unknown, do not retry blindly`)); this.socket?.destroy(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      const data = Buffer.from(JSON.stringify([0, id, method, params]));
      this.socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));
    });
  }
  fail(error) { this.ready = false; for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); } this.pending.clear(); }
  run(task) { const next = this.queue.then(async () => { await this.connect(); return task(this); }); this.queue = next.catch(() => {}); return next; }
  async disconnect() {
    if (this.socket && !this.socket.destroyed) { try { await this.send('WebDriver:DeleteSession'); } catch {} this.socket.destroy(); }
    this.ready = false;
  }
}
