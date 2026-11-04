import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RdpClient } from '../src/rdp.mjs';

test('RDP extension tools are exposed over MCP and fail closed without profile config', async () => {
 const transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], env: { ...process.env, ZEN_RDP_PORT: '', ZEN_RDP_PROFILE: '', ZEN_NATIVE_PORT: '', ZEN_NATIVE_PROFILE: '' }, stderr: 'pipe' });
 transport.stderr?.on('data', () => {});
 const client = new Client({ name: 'rdp-contract-test', version: '1.0.0' });
 try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'zen_extension_install'));
  assert(tools.some(tool => tool.name === 'zen_extension_status'));
  assert(tools.some(tool => tool.name === 'zen_extension_verify'));
  for (const name of ['zen_css_profile_status', 'zen_css_profile_verify', 'zen_css_profile_import', 'zen_css_profile_restore']) assert(tools.some(tool => tool.name === name));
  const result = await client.callTool({ name: 'zen_extension_status', arguments: { id: 'browserflow@example.test' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ZEN_RDP_PORT and ZEN_RDP_PROFILE/);
 } finally { await client.close(); }
});

test('RDP request demultiplexing preserves actor events before the matching reply', async () => {
 const client = Object.create(RdpClient.prototype);
 client.timeout = 100;
 const events = [
  { from: 'root', type: 'tabListChanged' },
  { from: 'watcher1', type: 'target-available-form', target: { url: 'moz-extension://fixture/_generated_background_page.html' } },
  { from: 'root', type: 'addonListChanged' },
 ];
 client.events = [...events, { from: 'root', tabs: [{ actor: 'tab1', url: 'https://example.test/' }] }];
 client.socket = { write() {} };
 client.connectSocketOnly = async () => {};
 const response = await client.call('root', 'listTabs');
 assert.equal(response.tabs.length, 1);
 assert.deepEqual(client.events, events);
 client.events.push(
  { from: 'root', tabs: [{ actor: 'stale-tab', url: 'https://old.example/' }] },
  { from: 'root', addons: [{ actor: 'addon1', id: '{fixture}' }] },
 );
 const addons = await client.call('root', 'listAddons');
 assert.equal(addons.addons[0].id, '{fixture}');
 assert.deepEqual(client.events, [...events, { from: 'root', tabs: [{ actor: 'stale-tab', url: 'https://old.example/' }] }]);
 client.events.push({ from: 'root' });
 assert.deepEqual(await client.call('root', 'connect', { frontendVersion: '158.0' }), { from: 'root' });
});

test('CSS background target discovery consumes fresh target forms on repeated refreshes', async () => {
 const client = Object.create(RdpClient.prototype);
 client.events = [];
 client.sequence = 0;
 client.call = async (to, type) => {
  if (to === 'root' && type === 'listAddons') return { from: 'root', addons: [{ id: '{91aa3897-2634-4a8a-9092-279db23a7689}', actor: 'addonActor', manifestURL: 'moz-extension://fixture-id/manifest.json' }] };
  if (to === 'addonActor' && type === 'getWatcher') return { from: to, watcher: { actor: 'addonWatcher' } };
  if (to === 'addonWatcher' && type === 'watchTargets') {
   client.sequence++;
   client.events.push({ from: to, type: 'target-available-form', target: { url: 'moz-extension://fixture-id/_generated_background_page.html', consoleActor: `freshConsole${client.sequence}` } });
   return { from: to };
  }
  if (to === 'addonWatcher' && type === 'unwatchTargets') {
   client.events.push({ from: to, type: 'target-destroyed-form', target: { consoleActor: `freshConsole${client.sequence}` } });
   return { from: to };
  }
  throw new Error(`Unexpected fake RDP call ${to}.${type}`);
 };
 const first = await client._cssBackgroundActor();
 await client.call(first.watcherId, 'unwatchTargets');
 client._discardWatcherTargetEvents(first.watcherId);
 const second = await client._cssBackgroundActor();
 assert.equal(first.actor, 'freshConsole1');
 assert.equal(second.actor, 'freshConsole2');
 assert.equal(client.events.some(event => event.type === 'target-available-form' || event.type === 'target-destroyed-form'), false);
});

test('RDP one-way requests write without waiting for an acknowledgement', async () => {
 const client = Object.create(RdpClient.prototype);
 let packet;
 client.socket = { write(bytes) { packet = Buffer.from(bytes); } };
 client.connectSocketOnly = async () => {};
 await client.sendOneWay('watcher1', 'unwatchTargets', { targetType: 'frame' });
 const colon = packet.indexOf(58);
 assert.equal(Number(packet.subarray(0, colon).toString()), packet.length - colon - 1);
 assert.deepEqual(JSON.parse(packet.subarray(colon + 1).toString()), { to: 'watcher1', type: 'unwatchTargets', targetType: 'frame' });
});

test('CSS verification distinguishes discarded domain tabs from no matching tabs', async () => {
 const client = Object.create(RdpClient.prototype);
 assert.deepEqual(client._cssVerificationSummary({ matchedTabs: 17, discardedTabs: 17, loadedTabs: 0 }, 0, 0), {
  matchedTabs: 17, discardedTabs: 17, loadedTabs: 0, inspectableTabs: 0, verifiedTabs: 0,
  allTabsVerified: false, verificationState: 'no_loaded_tabs',
 });
 assert.equal(client._cssVerificationSummary({ matchedTabs: 0, discardedTabs: 0, loadedTabs: 0 }, 0, 0).verificationState, 'no_matching_tabs');
 assert.equal(client._cssVerificationSummary({ matchedTabs: 3, discardedTabs: 1, loadedTabs: 2 }, 2, 2).verificationState, 'partial');
 assert.equal(client._cssVerificationSummary({ matchedTabs: 2, discardedTabs: 0, loadedTabs: 2 }, 2, 2).verificationState, 'verified');
 assert.equal(client._cssVerificationSummary({ matchedTabs: 2, discardedTabs: 0, loadedTabs: 2 }, 1, 1).allTabsVerified, false);
});

test('CSS domain tab summary uses a domain-filtered background query and returns counts only', async () => {
 const client = Object.create(RdpClient.prototype);
 client._cssBackgroundActor = async () => ({ actor: 'background-console', watcherId: 'background-watcher' });
 let expression;
 client.asyncValue = async (value, actor) => {
  expression = value;
  assert.equal(actor, 'background-console');
  return JSON.stringify({ matchingTabs: 17, discardedTabs: 17, loadedTabs: 0 });
 };
 let unwatched;
 client.sendOneWay = async (...args) => { unwatched = args; };
 client._discardWatcherTargetEvents = () => {};
 assert.deepEqual(await client._cssDomainTabState({ domain: 'korben.info' }), { matchedTabs: 17, discardedTabs: 17, loadedTabs: 0 });
 assert.match(expression, /browser\.tabs\.query\(\{url:/);
 assert.match(expression, /korben\.info/);
 assert.doesNotMatch(expression, /tabs\.map\(tab=>tab\.url/);
 assert.deepEqual(unwatched, ['background-watcher', 'unwatchTargets', { targetType: 'frame' }]);
});
