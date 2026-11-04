import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve('.test-runtime');
await mkdir(root, { recursive: true });
const testDir = await mkdtemp(path.join(root, 'rdp-'));
const profile = path.join(testDir, 'profile');
const wrongProfile = path.join(testDir, 'wrong-profile');
const extensionId = 'zen-mcp-rdp-test@example.invalid';
const binary = process.env.ZEN_BINARY || '/Applications/Zen.app/Contents/MacOS/zen';
let browser;
let client;
let transport;
let serverLog = [];

async function freePort() {
 const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
 const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function waitPort(port, proc) {
 for (let i = 0; i < 100; i++) {
  if (proc.exitCode !== null) throw new Error(`Zen exited early (${proc.exitCode})`);
  try { await new Promise((resolve, reject) => { const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(); }); s.once('error', reject); }); return; }
  catch { await new Promise(resolve => setTimeout(resolve, 200)); }
 }
 throw new Error('Zen RDP did not become available');
}
async function startBrowser(port) {
 browser = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--start-debugger-server', String(port), 'about:blank'], { stdio: 'ignore' });
 await waitPort(port, browser);
}
async function stopBrowser() {
 if (!browser || browser.exitCode !== null) return;
 browser.kill('SIGTERM');
 await Promise.race([once(browser, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out stopping isolated Zen test process')), 10000))]);
 browser = null;
}
async function openMcp(port, authorizedProfile) {
 serverLog = [];
 transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], env: { ...process.env, ZEN_RDP_PORT: String(port), ZEN_RDP_PROFILE: authorizedProfile, ZEN_NATIVE_PORT: '', ZEN_NATIVE_PROFILE: '', ZEN_DEBUG_PORT: '9222' }, stderr: 'pipe' });
 transport.stderr?.on('data', chunk => serverLog.push(chunk.toString()));
 client = new Client({ name: 'rdp-isolated-integration', version: '1.0.0' });
 await client.connect(transport);
}
async function closeMcp() { if (client) await client.close(); client = null; transport = null; }
async function call(name, args) {
 const result = await client.callTool({ name, arguments: args });
 if (result.isError) throw new Error(`${result.content?.[0]?.text || `${name} failed`}\nserver stderr: ${serverLog.join('')}`);
 return JSON.parse(result.content[0].text);
}
async function expectError(name, args, pattern) {
 const result = await client.callTool({ name, arguments: args });
 assert.equal(result.isError, true);
 assert.match(result.content?.[0]?.text || '', pattern, serverLog.join(''));
}
async function makeXpi(version) {
 const dir = path.join(testDir, `addon-${version}`); await mkdir(dir, { recursive: true });
 await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Zen MCP isolated test', version, browser_specific_settings: { gecko: { id: extensionId } } }));
 const xpi = path.join(testDir, `addon-${version}.xpi`);
 execFileSync('/usr/bin/zip', ['-q', xpi, 'manifest.json'], { cwd: dir });
 const sha256 = createHash('sha256').update(await readFile(xpi)).digest('hex');
 return { path: xpi, id: extensionId, version, sha256 };
}

try {
 await mkdir(profile); await mkdir(wrongProfile);
 const prefs = { 'xpinstall.signatures.required': false, 'devtools.debugger.remote-enabled': true, 'devtools.chrome.enabled': true, 'devtools.debugger.prompt-connection': false, 'devtools.debugger.force-local': true, 'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false, 'zen.welcome-screen.seen': true, 'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false };
 await writeFile(path.join(profile, 'user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
 const port = await freePort(); await startBrowser(port);

 // RDP profile mismatch must fail before any extension mutation.
 await openMcp(port, wrongProfile);
 await expectError('zen_extension_status', { id: extensionId }, /profile mismatch/i);
 await closeMcp();

 await openMcp(port, profile);
 await expectError('zen_extension_status', { id: extensionId }, /not installed/i);
 const v10 = await makeXpi('1.0');
 const first = await call('zen_extension_install', v10);
 assert.equal(first.id, extensionId); assert.equal(first.version, '1.0'); assert.equal(first.sha256, v10.sha256); assert.equal(first.active, true); assert.equal(first.permanent, true);
 const noOp = await call('zen_extension_install', v10);
 assert.equal(noOp.version, '1.0'); assert.equal(noOp.sha256, v10.sha256);
 const v11 = await makeXpi('1.1');
 const updated = await call('zen_extension_install', v11);
 assert.equal(updated.version, '1.1'); assert.equal(updated.sha256, v11.sha256);
 const forced = await call('zen_extension_install', { ...v11, force: true });
 assert.equal(forced.version, '1.1'); assert.equal(forced.sha256, v11.sha256);
 await call('zen_extension_verify', { id: extensionId, version: '1.1', sha256: v11.sha256 });
 await closeMcp();
 await openMcp(port, profile);
 const nextServerStatus = await call('zen_extension_status', { id: extensionId });
 assert.equal(nextServerStatus.version, '1.1'); assert.equal(nextServerStatus.sha256, v11.sha256);
 await closeMcp(); await stopBrowser();

 await startBrowser(port); await openMcp(port, profile);
 const afterRestart = await call('zen_extension_verify', { id: extensionId, version: '1.1', sha256: v11.sha256 });
 assert.equal(afterRestart.active, true); assert.equal(afterRestart.permanent, true);
 console.log(JSON.stringify({ ok: true, checks: 11, profile: 'isolated test profile only', versions: ['1.0', '1.1'], restartVerified: true }));
} catch (error) {
 console.error(error.stack || error); process.exitCode = 1;
} finally {
 await closeMcp().catch(() => {});
 await stopBrowser().catch(error => { console.error(error.message); process.exitCode = 1; });
 await rm(testDir, { recursive: true, force: true });
}
