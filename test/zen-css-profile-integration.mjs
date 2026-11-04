import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RdpClient } from '../src/rdp.mjs';
import { ZEN_INTERNET_CSS_ADDON } from '../src/zen-css-profile.mjs';

const repo = path.resolve('.');
const runtime = path.join(repo, '.test-runtime');
await mkdir(runtime, { recursive: true });
const testDir = await mkdtemp(path.join(runtime, 'zen-css-profile-'));
const profile = path.join(testDir, 'profile');
const xpiPath = process.env.ZEN_INTERNET_CSS_XPI;
const binary = process.env.ZEN_BINARY || '/Applications/Zen.app/Contents/MacOS/zen';
const fixtureDomain = 'rdpfixture.localhost';
const styleFile = `${fixtureDomain}.css`;
const settingsKey = `transparentZenSettings.${fixtureDomain}`;
const featureCSS = {
  transparency: '#zen-css-fixture { background-color: rgb(255, 0, 0) !important; }',
  'fixture cosmetic': '.zen-css-fixture { border: 7px solid rgb(0, 128, 0) !important; }\n.article-content { background-color: rgb(12, 34, 56) !important; }',
};
const fixture = { website: { [styleFile]: featureCSS }, mapping: {} };
const seededStyles = {
  preservedRootValue: { marker: 'keep-root' },
  website: {
    'other.invalid.css': { untouched: 'body { color: red; }' },
    [styleFile]: { existingFeature: '.existing { color: blue; }' },
  },
  mapping: { 'other.invalid.css': ['mapped.invalid'] },
};
const seededData = {
  styles: seededStyles,
  stylesMapping: { mapping: { 'other.invalid.css': ['mapped.invalid'] } },
  userStylesMapping: { mapping: { 'custom.invalid.css': ['custom-target.invalid'] } },
  'transparentZenSettings': {
    autoUpdate: false,
    disableDarkReader: false,
    disableFooter: false,
    disableHover: false,
    enableStyling: true,
    disableTransparency: false,
    enableLogs: false,
    fallbackBackgroundList: [],
    forceStyling: false,
    keepGlobalMarker: 'global-preserved',
    whitelistMode: false,
    whitelistStyleMode: false,
    welcomeShown: false,
  },
  [settingsKey]: { transparency: false, keepSiteMarker: 'site-preserved' },
};

let browser;
let rdp;
let mcpClient;
let mcpTransport;
const mcpLog = [];
let fixtureServer;
const browserLog = path.join(testDir, 'zen.log');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (browser.exitCode !== null) throw new Error(`Zen exited early (${browser.exitCode})`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('Isolated Zen RDP endpoint did not start');
}

async function startZen(port) {
  const prefs = {
    'xpinstall.signatures.required': false,
    'devtools.debugger.remote-enabled': true,
    'devtools.chrome.enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.debugger.force-local': true,
    'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false,
    'zen.welcome-screen.seen': true,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
  };
  await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
    .join('\n'));
  const logHandle = await open(browserLog, 'a');
  browser = spawn(binary, [
    '--headless', '--no-remote', '--profile', profile,
    '--start-debugger-server', String(port), 'about:blank',
  ], { stdio: ['ignore', logHandle.fd, logHandle.fd] });
  await logHandle.close();
  await waitForPort(port);
  rdp = new RdpClient({ port, profile, timeout: 12000 });
  await rdp.connect();
}

async function stopZen() {
  await rdp?.disconnect().catch(() => {});
  rdp = null;
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([
      once(browser, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out stopping isolated Zen')), 10000)),
    ]);
  }
  browser = null;
}

async function openMcp(port) {
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'server.mjs')],
    env: { ...process.env, ZEN_RDP_PORT: String(port), ZEN_RDP_PROFILE: profile, ZEN_NATIVE_PORT: '', ZEN_NATIVE_PROFILE: '' },
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', chunk => mcpLog.push(chunk.toString()));
  mcpClient = new Client({ name: 'zen-css-profile-isolated-e2e', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);
}

async function closeMcp() {
  if (mcpClient) await mcpClient.close();
  mcpClient = null;
  mcpTransport = null;
}

async function connectDirect(port) {
  rdp = new RdpClient({ port, profile, timeout: 12000 });
  await rdp.connect();
}

async function callMcp(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${result.content?.[0]?.text || `${name} failed`}\nMCP stderr: ${mcpLog.join('')}`);
  return JSON.parse(result.content[0].text);
}

async function expectMcpError(name, args, pattern) {
  const result = await mcpClient.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should return an MCP error`);
  assert.match(result.content?.[0]?.text || '', pattern, mcpLog.join(''));
}

async function findBackgroundTarget() {
  const response = await rdp.call('root', 'listAddons');
  const addon = (response.addons || []).find(item => item.id === ZEN_INTERNET_CSS_ADDON.id);
  if (!addon) {
    const installed = await rdp.getAddon(ZEN_INTERNET_CSS_ADDON.id, undefined, ZEN_INTERNET_CSS_ADDON.version, false).catch(error => ({ error: String(error.message || error) }));
    const summary = { from: response.from, type: response.type, keys: Object.keys(response).sort(), addonsArray: Array.isArray(response.addons), addonCount: Array.isArray(response.addons) ? response.addons.length : null, expectedIdPresent: false, installed: installed && { active: installed.active, permanent: installed.permanent, version: installed.version, error: installed.error } };
    throw new Error(`Official CSS add-on missing from root.listAddons response: ${JSON.stringify(summary)}`);
  }
  assert.equal(addon.debuggable, true, 'official CSS add-on should be debuggable in the isolated profile');
  const background = await rdp._cssBackgroundActor();
  const extensionOrigin = addon.manifestURL.replace(/\/manifest\.json$/, '');
  return { addon, watcher: background.watcherId, target: { targetType: 'frame', url: `${extensionOrigin}/_generated_background_page.html`, consoleActor: background.actor } };
}

async function withFreshBackgroundTarget(action) {
  const { target, watcher } = await findBackgroundTarget();
  try {
    return await action(target);
  } finally {
    rdp.sendOneWay(watcher, 'unwatchTargets', { targetType: 'frame' });
    rdp._discardWatcherTargetEvents(watcher);
  }
}

async function backgroundValue(target, expression) {
  const originalActor = rdp.consoleActor;
  rdp.consoleActor = target.consoleActor;
  try {
    return await rdp.asyncValue(expression);
  } finally {
    rdp.consoleActor = originalActor;
  }
}

async function chromeValue(expression) {
  return rdp.asyncValue(expression);
}

async function readFixtureStorage() {
  const id = JSON.stringify(ZEN_INTERNET_CSS_ADDON.id);
  const keys = JSON.stringify(['styles', 'stylesMapping', 'userStylesMapping', 'transparentZenSettings', settingsKey]);
  const raw = await chromeValue(`(async()=>{const id=${id};const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');const {ExtensionStorageIDB}=ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');const extension=ExtensionParent.GlobalManager.getExtension(id);const selected=await ExtensionStorageIDB.selectBackend({extension});if(!selected.backendEnabled)throw Error('IDB backend unavailable');const principal=selected.storagePrincipal.deserialize(ExtensionStorageIDB,true);const db=await ExtensionStorageIDB.open(principal);return JSON.stringify(await db.get(${keys}))})()`);
  return JSON.parse(raw);
}

async function installFixtureSeed(target) {
  const requiredDefaults = ['enableStyling', 'autoUpdate', 'forceStyling', 'whitelistMode', 'whitelistStyleMode', 'disableTransparency', 'disableHover', 'disableFooter', 'disableDarkReader', 'enableLogs', 'fallbackBackgroundList'];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const raw = await backgroundValue(target, `browser.storage.local.get(['transparentZenSettings','stylesMapping','skipThemingList','skipForceThemingList','fallbackBackgroundList']).then(JSON.stringify)`);
    const data = JSON.parse(raw);
    const initialized = requiredDefaults.every(key => Object.hasOwn(data.transparentZenSettings || {}, key))
      && data.stylesMapping && Array.isArray(data.skipThemingList)
      && Array.isArray(data.skipForceThemingList) && Array.isArray(data.fallbackBackgroundList);
    if (initialized) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const currentRaw = await backgroundValue(target, `browser.storage.local.get(['transparentZenSettings','stylesMapping','skipThemingList','skipForceThemingList','fallbackBackgroundList']).then(JSON.stringify)`);
  const current = JSON.parse(currentRaw);
  assert.ok(requiredDefaults.every(key => Object.hasOwn(current.transparentZenSettings || {}, key)), 'official extension settings initialization should finish before fixture seeding');
  assert.ok(current.stylesMapping && Array.isArray(current.skipThemingList) && Array.isArray(current.skipForceThemingList) && Array.isArray(current.fallbackBackgroundList), 'official extension storage initialization should finish before fixture seeding');
  const values = JSON.stringify(seededData);
  await backgroundValue(target, `browser.storage.local.set(${values})`);
}

async function addChangeProbe(target) {
  await backgroundValue(target, `(()=>{globalThis.__zenCssProbe=[];globalThis.__zenCssListener=(changes,area)=>{globalThis.__zenCssProbe.push({area,keys:Object.keys(changes)})};browser.storage.onChanged.addListener(globalThis.__zenCssListener);return true})()`);
}

async function takeChangeProbe(target) {
  const raw = await backgroundValue(target, `JSON.stringify(globalThis.__zenCssProbe||[])`);
  await backgroundValue(target, `(()=>{if(globalThis.__zenCssListener)browser.storage.onChanged.removeListener(globalThis.__zenCssListener);delete globalThis.__zenCssListener;delete globalThis.__zenCssProbe;return true})()`);
  return JSON.parse(raw);
}

async function readChangeProbe(target) {
  return JSON.parse(await backgroundValue(target, `JSON.stringify(globalThis.__zenCssProbe||[])`));
}

async function openFixtureTabs(target, ...urls) {
  const raw = await backgroundValue(target, `Promise.all(${JSON.stringify(urls)}.map(async url=>{const tab=await browser.tabs.create({url,active:false});return {id:tab.id,url}})).then(JSON.stringify)`);
  return JSON.parse(raw);
}

async function discardFixtureTab(target, tabId) {
  const deadline = Date.now() + 10000;
  let current;
  do {
    current = JSON.parse(await backgroundValue(target, `browser.tabs.get(${JSON.stringify(tabId)}).then(tab=>JSON.stringify({discarded:tab.discarded===true,status:tab.status,active:tab.active===true}))`));
    if (current.discarded || current.status === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(current?.status, 'complete', 'the secondary fixture tab should finish loading before it is discarded');
  const raw = await backgroundValue(target, `(async()=>{await browser.tabs.discard(${JSON.stringify(tabId)});const tab=await browser.tabs.get(${JSON.stringify(tabId)});return JSON.stringify({discarded:tab.discarded===true,status:tab.status,active:tab.active===true})})()`);
  return JSON.parse(raw);
}

async function readFixtureTabState(target, tabId) {
  const raw = await backgroundValue(target, `browser.tabs.get(${JSON.stringify(tabId)}).then(tab=>JSON.stringify({discarded:tab.discarded===true,status:tab.status,active:tab.active===true}))`);
  return JSON.parse(raw);
}

async function readPageResult(tabUrl) {
  let descriptor;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !descriptor) {
    const response = await rdp.call('root', 'listTabs');
    descriptor = (response.tabs || []).find(tab => tab.url === tabUrl);
    if (!descriptor) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(descriptor, `fixture tab is available: ${tabUrl}`);
  const form = await rdp.call(descriptor.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true });
  const watcher = form.watcher || form;
  assert.ok(watcher.actor, `fixture tab watcher is available: ${tabUrl}`);
  try {
    const watched = await rdp.call(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const targetForPage = value => {
      const target = value.target || value.targetForm || value;
      return value.from === watcher.actor && target.url === tabUrl && target.consoleActor;
    };
    let target = [watched, ...rdp.events].find(targetForPage);
    if (!target) target = await rdp._takeMessage(value => value.type === 'target-available-form' && targetForPage(value), 5000);
    const consoleActor = (target.target || target.targetForm || target).consoleActor;
    assert.ok(consoleActor, `fixture tab console actor is available: ${tabUrl}`);
    const originalActor = rdp.consoleActor;
    rdp.consoleActor = consoleActor;
    try {
      const raw = await rdp.asyncValue(`JSON.stringify((()=>{const el=document.getElementById('zen-css-fixture');const article=document.querySelector('.article-content');const sheet=document.getElementById('zeninternet-styles');return {hasSheet:!!sheet,hasFixtureRule:!!sheet?.textContent.includes('.zen-css-fixture'),hasTransparencyRule:!!sheet?.textContent.includes('#zen-css-fixture'),hasArticleRule:!!sheet?.textContent.includes('.article-content'),border:getComputedStyle(el).borderTopWidth,background:getComputedStyle(el).backgroundColor,articleBackground:article?getComputedStyle(article).backgroundColor:null}})())`);
      return JSON.parse(raw);
    } finally {
      rdp.consoleActor = originalActor;
    }
  } finally {
    rdp.sendOneWay(watcher.actor, 'unwatchTargets', { targetType: 'frame' });
  }
}

async function fixtureTabSummary() {
  const { tabs = [] } = await rdp.call('root', 'listTabs');
  return tabs.map(tab => {
    try {
      const url = new URL(tab.url);
      return ['rdpfixture.localhost', 'sentinel.localhost'].includes(url.hostname)
        ? { protocol: url.protocol, hostname: url.hostname, urlLength: tab.url.length, actorAvailable: Boolean(tab.actor) }
        : null;
    } catch { return null; }
  }).filter(Boolean);
}

async function waitForFixtureTabs(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await fixtureTabSummary();
    if (summary.some(tab => tab.hostname === fixtureDomain) && summary.some(tab => tab.hostname === 'sentinel.localhost')) return summary;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture tabs did not become visible through RDP: ${JSON.stringify(await fixtureTabSummary())}`);
}

try {
  if (!xpiPath) throw new Error('Set ZEN_INTERNET_CSS_XPI to the official, unmodified Zen Internet 3.2.0 XPI');
  await mkdir(runtime, { recursive: true });
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(testDir, 'state'), { recursive: true, mode: 0o700 });
  process.env.XDG_STATE_HOME = path.join(testDir, 'state');
  const officialXpi = await readFile(xpiPath);
  const digest = createHash('sha256').update(officialXpi).digest('hex');
  const sourceHash = digest;
  const copiedXpi = path.join(testDir, 'zen-internet-official.xpi');
  await writeFile(copiedXpi, officialXpi, { mode: 0o600, flag: 'wx' });
  assert.equal(createHash('sha256').update(await readFile(copiedXpi)).digest('hex'), sourceHash, 'fixture XPI copy must be byte-identical');

  const fixturePath = path.join(testDir, `${fixtureDomain}.styles.json`);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const httpPort = await freePort();
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Zen CSS isolated fixture</title><div id="zen-css-fixture" class="zen-css-fixture">Fixture</div><article class="article-content">Synthetic article style evidence</article>');
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(httpPort, '127.0.0.1', resolve);
  });
  const fixtureUrl = `http://${fixtureDomain}:${httpPort}/fixture`;
  const sentinelUrl = `http://sentinel.localhost:${httpPort}/sentinel`;
  const port = await freePort();
  await startZen(port);

  const installed = await rdp.installXpi({
    path: copiedXpi,
    id: ZEN_INTERNET_CSS_ADDON.id,
    version: ZEN_INTERNET_CSS_ADDON.version,
    sha256: sourceHash,
  });
  assert.equal(installed.active, true);
  assert.equal(installed.permanent, true);
  assert.equal(installed.sha256, sourceHash);

  const { target } = await findBackgroundTarget();
  assert.equal(target.targetType, 'frame');
  assert.match(target.url, /_generated_background_page\.html$/);
  await installFixtureSeed(target);
  const discardedFixtureUrl = `${fixtureUrl}/discarded`;
  const tabs = await openFixtureTabs(target, fixtureUrl, discardedFixtureUrl, sentinelUrl);
  assert.equal(tabs.length, 3);
  console.log(JSON.stringify({ tabsBeforeImport: await waitForFixtureTabs() }));
  const discardState = await discardFixtureTab(target, tabs[1].id);
  assert.deepEqual(discardState, { discarded: true, status: 'complete', active: false }, 'the secondary fixture tab should be discarded without activation');
  await addChangeProbe(target);
  const before = await readFixtureStorage();
  assert.deepEqual(before.styles, seededStyles);
  assert.deepEqual(before[settingsKey], seededData[settingsKey]);
  await rdp.disconnect();
  rdp = null;
  await openMcp(port);
  const listedTools = await mcpClient.listTools();
  const cssToolNames = listedTools.tools.map(tool => tool.name).filter(name => name.startsWith('zen_css_profile_'));
  assert.deepEqual(cssToolNames.sort(), ['zen_css_profile_import', 'zen_css_profile_restore', 'zen_css_profile_status', 'zen_css_profile_verify'].sort());
  const status = await callMcp('zen_css_profile_status', { domain: fixtureDomain });
  assert.equal(status.domain, fixtureDomain);
  assert.equal(status.storageReadOnly, true);
  const verifyBefore = await callMcp('zen_css_profile_verify', { profilePath: fixturePath, domain: fixtureDomain });
  assert.equal(verifyBefore.matchesStoredProfile, false, 'read-only verify should report the absent fixture profile');

  const imported = await callMcp('zen_css_profile_import', { profilePath: fixturePath, domain: fixtureDomain });
  assert.equal(imported.domain, fixtureDomain);
  assert.equal(imported.stored, true);
  assert.equal(imported.readbackVerified, true);
  assert.ok(imported.backupPath.startsWith(path.join(testDir, 'state')));
  assert.equal(imported.pageApplication.attemptedLoadedTabs, 1, 'import should refresh only the loaded fixture tab');
  assert.equal(imported.pageApplication.skippedDiscardedTabs, 1, 'import should skip the discarded fixture tab');
  assert.equal(imported.pageApplication.refreshedTabs, 1, 'the compatibility refresh count should reflect attempted loaded tabs');
  assert.equal(imported.pageApplication.pageEvidence.stylesheetMatches, 1);
  assert.deepEqual(imported.pageApplication.pageEvidence.articleContentBackgrounds, [{ backgroundColor: 'rgb(12, 34, 56)', hasBackgroundImage: false }], 'import should report computed style evidence from the loaded article fixture only');
  const verifyAfter = await callMcp('zen_css_profile_verify', { profilePath: fixturePath, domain: fixtureDomain });
  assert.equal(verifyAfter.matchesStoredProfile, true, 'read-only verify should match the stored fixture profile');
  assert.equal(verifyAfter.pageApplication.matchedTabs, 2, 'verification should count both domain tabs');
  assert.equal(verifyAfter.pageApplication.loadedTabs, 1);
  assert.equal(verifyAfter.pageApplication.discardedTabs, 1);
  assert.equal(verifyAfter.pageApplication.inspectableTabs, 1);
  assert.equal(verifyAfter.pageApplication.rdpCandidates, 1);
  assert.equal(verifyAfter.pageApplication.verifiedTabs, 1, 'read-only verify should inspect the loaded fixture page');
  assert.equal(verifyAfter.pageApplication.verificationState, 'partial');
  assert.equal(verifyAfter.pageApplication.allTabsVerified, false, 'discarded pages must prevent an all-tabs verified claim');
  assert.deepEqual(verifyAfter.pageApplication.pageEvidence, {
    stylesheetMatches: 1,
    articleContentBackgrounds: [{ backgroundColor: 'rgb(12, 34, 56)', hasBackgroundImage: false }],
  }, 'read-only evidence should include the loaded article fixture and no sample from the discarded tab');
  await closeMcp();
  await connectDirect(port);
  const pageAfterApply = await readPageResult(tabs[0].url);
  const sentinelAfterApply = await readPageResult(tabs[2].url);
  console.log(JSON.stringify({ importPageApplication: imported.pageApplication, verifyPageApplication: verifyAfter.pageApplication, pageAfterApply, sentinelAfterApply }));

  const afterApply = await readFixtureStorage();
  assert.deepEqual(afterApply.styles.website[styleFile], {
    ...seededStyles.website[styleFile],
    ...featureCSS,
  });
  assert.deepEqual(afterApply.styles.website['other.invalid.css'], seededStyles.website['other.invalid.css']);
  assert.deepEqual(afterApply.styles.preservedRootValue, seededStyles.preservedRootValue);
  assert.deepEqual(afterApply.styles.mapping, seededStyles.mapping);
  assert.deepEqual(afterApply.stylesMapping, seededData.stylesMapping);
  assert.deepEqual(afterApply.userStylesMapping, seededData.userStylesMapping);
  assert.deepEqual(afterApply.transparentZenSettings, seededData.transparentZenSettings);
  assert.deepEqual(afterApply[settingsKey], seededData[settingsKey], 'false and absent feature switches must remain unchanged');
  assert.equal(pageAfterApply.hasFixtureRule, true, 'enabled absent feature should be applied to the fixture page');
  assert.equal(pageAfterApply.border, '7px', 'fixture CSS should affect the local page');
  assert.equal(pageAfterApply.background, 'rgba(0, 0, 0, 0)', 'disabled transparency feature should stay unapplied');
  assert.equal(pageAfterApply.hasArticleRule, true, 'the loaded fixture DOM should contain the article style rule');
  assert.equal(pageAfterApply.articleBackground, 'rgb(12, 34, 56)', 'the loaded article element should report the expected computed background');
  assert.equal(pageAfterApply.hasTransparencyRule, false, 'false switch should exclude the disabled CSS rule');
  assert.equal(sentinelAfterApply.hasSheet, false, 'non-matching local tab should remain unchanged');
  const discardedStateAfterApply = await withFreshBackgroundTarget(target => readFixtureTabState(target, tabs[1].id));
  assert.deepEqual(discardedStateAfterApply, discardState, 'the discarded page must remain unloaded after import and verification');
  const applyEvents = await withFreshBackgroundTarget(readChangeProbe);
  assert.ok(applyEvents.some(event => event.area === 'local' && event.keys.includes('styles')), 'browser.storage.onChanged should receive the styles update');

  // A targeted feature change must make restore refuse without touching storage.
  const conflictingStyles = {
    ...afterApply.styles,
    website: {
      ...afterApply.styles.website,
      [styleFile]: { ...afterApply.styles.website[styleFile], 'fixture cosmetic': '.zen-css-fixture { display: none !important; }' },
    },
  };
  await withFreshBackgroundTarget(target => backgroundValue(target, `browser.storage.local.set({styles:${JSON.stringify(conflictingStyles)}})`));
  await rdp.disconnect();
  rdp = null;
  await openMcp(port);
  await expectMcpError('zen_css_profile_restore', { backupPath: imported.backupPath, domain: fixtureDomain }, /changed since import/i);
  await closeMcp();
  await connectDirect(port);
  const afterConflict = await readFixtureStorage();
  assert.deepEqual(afterConflict.styles.website[styleFile], conflictingStyles.website[styleFile], 'conflict refusal must not partially restore the CSS entry');

  // Unrelated domain and switch edits made after import must survive a targeted restore.
  const unrelatedAfterImport = { changedDuringTest: 'preserve this concurrent update' };
  const latestStyles = {
    ...afterConflict.styles,
    website: {
      ...afterConflict.styles.website,
      [styleFile]: { ...afterConflict.styles.website[styleFile], 'fixture cosmetic': featureCSS['fixture cosmetic'] },
      'other.invalid.css': unrelatedAfterImport,
    },
  };
  await withFreshBackgroundTarget(target => backgroundValue(target, `browser.storage.local.set({styles:${JSON.stringify(latestStyles)},${JSON.stringify(settingsKey)}:{transparency:true,keepSiteMarker:'changed during fixture'}})`));
  await rdp.disconnect();
  rdp = null;
  await openMcp(port);
  const restored = await callMcp('zen_css_profile_restore', { backupPath: imported.backupPath, domain: fixtureDomain });
  assert.equal(restored.restored, true);
  assert.equal(restored.readbackVerified, true);
  assert.equal(restored.pageApplication.verifiedTabs, 1, 'restored CSS should be verified on the loaded fixture tab');
  assert.equal(restored.pageApplication.verificationState, 'partial', 'the discarded fixture tab remains outside page inspection');
  const verifyRestored = await callMcp('zen_css_profile_verify', { profilePath: fixturePath, domain: fixtureDomain });
  assert.equal(verifyRestored.matchesStoredProfile, false, 'verify should be read-only and report that imported CSS was restored');
  await closeMcp();
  await connectDirect(port);
  const afterRestore = await readFixtureStorage();
  assert.deepEqual(afterRestore.styles.website[styleFile], seededStyles.website[styleFile]);
  assert.deepEqual(afterRestore.styles.website['other.invalid.css'], unrelatedAfterImport);
  assert.deepEqual(afterRestore.styles.mapping, seededStyles.mapping);
  assert.deepEqual(afterRestore.stylesMapping, seededData.stylesMapping);
  assert.deepEqual(afterRestore.userStylesMapping, seededData.userStylesMapping);
  assert.deepEqual(afterRestore.transparentZenSettings, seededData.transparentZenSettings);
  assert.deepEqual(afterRestore[settingsKey], { transparency: true, keepSiteMarker: 'changed during fixture' });
  const pageAfterRestore = await readPageResult(tabs[0].url);
  assert.equal(pageAfterRestore.hasFixtureRule, false, 'restore should remove the imported fixture CSS');
  const sentinelAfterRestore = await readPageResult(tabs[2].url);
  assert.equal(sentinelAfterRestore.hasSheet, false, 'targeted restore should leave the sentinel tab unchanged');
  const discardedStateAfterRestore = await withFreshBackgroundTarget(target => readFixtureTabState(target, tabs[1].id));
  assert.deepEqual(discardedStateAfterRestore, discardState, 'restore must not activate or load the discarded fixture tab');

  const probeEvents = await withFreshBackgroundTarget(readChangeProbe);
  assert.ok(probeEvents.some(event => event.area === 'local' && event.keys.includes('styles')), 'restore notification should reach browser.storage.onChanged');
  await withFreshBackgroundTarget(takeChangeProbe);
  console.log(JSON.stringify({ ok: true, fixtureDomain, checks: 76, mcpTools: cssToolNames, officialXpiHash: sourceHash, isolatedProfile: true, notificationVerified: true, backupRestored: true }));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await closeMcp().catch(error => { console.error(error.message); process.exitCode = 1; });
  await stopZen().catch(error => { console.error(error.message); process.exitCode = 1; });
  await new Promise(resolve => fixtureServer?.close(resolve) ?? resolve());
  try {
    if (process.exitCode && await readFile(browserLog, 'utf8').catch(() => '')) {
      const log = await readFile(browserLog, 'utf8');
      console.error(`Isolated Zen log tail:\n${log.slice(-6000)}`);
    }
  } catch {}
  await rm(testDir, { recursive: true, force: true });
}
