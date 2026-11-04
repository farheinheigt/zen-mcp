import net from 'node:net';
import { chmod, lstat, mkdir, realpath, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZEN_CSS_PROFILE, ZEN_INTERNET_CSS_ADDON, ZEN_INTERNET_DEFAULT_GLOBAL_SETTINGS, validateZenCssBackup, validateZenCssProfile } from './zen-css-profile.mjs';

const RDP_EVENT_TYPES = new Set([
  'tabListChanged', 'addonListChanged', 'target-available-form', 'target-destroyed-form',
  'resources-available-array', 'resources-destroyed-array', 'resource-available-form', 'resource-destroyed-form',
  'storage-changed', 'storage-actors-updated', 'tabNavigated', 'frameUpdate', 'newSource', 'updatedSource',
  'sourceUpdated', 'consoleAPICall', 'pageError', 'networkEvent', 'networkEventUpdate', 'logMessage',
  'evaluationResult', 'paused', 'resumed', 'lastPrivateContextExited', 'windowGlobalCreated', 'windowGlobalDestroyed',
]);

function cssBackupDirectory() {
  const stateHome = process.env.XDG_STATE_HOME;
  if (!stateHome || !path.isAbsolute(stateHome)) throw new Error('Set XDG_STATE_HOME to an absolute path for private CSS backups');
  return path.join(stateHome, 'zen-mcp', 'css-profile-backups');
}

async function readCssProfileFile(profilePath) {
  const sourcePath = await realpath(profilePath);
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('CSS profile file must be a regular file no larger than 2 MiB');
  const profile = validateZenCssProfile(JSON.parse(await readFile(sourcePath, 'utf8')));
  return { sourcePath, profile };
}

function cssStorageExpression(operation, payload) {
  const addonId = JSON.stringify(ZEN_INTERNET_CSS_ADDON.id);
  const stylesKey = JSON.stringify(ZEN_CSS_PROFILE.stylesKey);
  const styleFile = JSON.stringify(payload.styleFile);
  const settingsKey = JSON.stringify(payload.settingsKey || `${ZEN_CSS_PROFILE.settingsPrefix}${payload.domain}`);
  const request = JSON.stringify(payload);
    const mode = JSON.stringify(operation);
  return `(async()=>{
    const input=${request};const mode=${mode};const addonId=${addonId};
    const {ExtensionStorageIDB}=ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
    const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const extension=ExtensionParent.GlobalManager.getExtension(addonId);if(!extension)throw Error("CSS catalog extension unavailable");
    const backend=await ExtensionStorageIDB.selectBackend({extension});
    if(!backend.backendEnabled||!backend.storagePrincipal)throw Error("CSS catalog local storage backend unavailable");
    const principal=typeof backend.storagePrincipal.deserialize==="function"?backend.storagePrincipal.deserialize(ExtensionStorageIDB,true):backend.storagePrincipal;
    const db=await ExtensionStorageIDB.open(principal,extension.hasPermission("unlimitedStorage"));
    const storeName="storage-local-data";if(!db.db.objectStoreNames.contains(storeName))throw Error("Unexpected CSS catalog storage schema");
    await extension.apiManager.asyncGetAPI("storage",extension);
    const tx=db.transaction(storeName,(mode==="snapshot"||mode==="status"||mode==="effectiveCss"||mode==="globalSettings")?"readonly":"readwrite");const store=tx.objectStore(storeName);
    let committed=false;
    try {
      const oldStyles=(mode==="globalSettings")?undefined:await store.get(${stylesKey});
      const oldSettings=mode==="effectiveCss"?await store.get(${settingsKey}):mode==="globalSettings"?await store.get("transparentZenSettings"):undefined;
      if(oldStyles!==undefined&&(oldStyles===null||typeof oldStyles!=="object"||Array.isArray(oldStyles)))throw Error("Stored styles value has an unsupported shape");
      const styles=oldStyles||{};
      if(styles.website!==undefined&&(styles.website===null||typeof styles.website!=="object"||Array.isArray(styles.website)))throw Error("Stored website styles have an unsupported shape");
      const website=styles.website||{};
      if(website[${styleFile}]!==undefined&&(website[${styleFile}]===null||typeof website[${styleFile}]!=="object"||Array.isArray(website[${styleFile}])))throw Error("Stored domain CSS entry has an unsupported shape");
      const entry=website[${styleFile}]||{};
      if(oldSettings!==undefined&&(oldSettings===null||typeof oldSettings!=="object"||Array.isArray(oldSettings)))throw Error("Stored domain settings have an unsupported shape");
      const settings=oldSettings||{};
      const names=(mode==="status"||mode==="effectiveCss")?Object.keys(entry):mode==="globalSettings"?[]:mode==="restore"?Object.keys(input.record.appliedFeatures):Object.keys(input.features);
      const target={styles:Object.fromEntries(names.map(name=>[name,{exists:Object.hasOwn(entry,name),value:entry[name]}]))};
      const makeEntry=(base,source,restore)=>{const next={...base};for(const name of names){if(restore){const before=source.styles[name];if(before?.exists)next[name]=before.value;else delete next[name];}else next[name]=source[name];}return next;};
      if(mode==="snapshot") { await tx.promiseComplete(); return JSON.stringify({target,features:names}); }
      if(mode==="status") { await tx.promiseComplete(); return JSON.stringify({domain:input.domain,features:names}); }
      if(mode==="globalSettings") { await tx.promiseComplete(); return JSON.stringify({settings:oldSettings}); }
      if(mode==="effectiveCss") {
        if(Object.values(entry).some(value=>typeof value!=="string"||!value.trim()||new TextEncoder().encode(value).byteLength>524288||/@import\\b/i.test(value)))throw Error("Stored domain CSS contains an invalid value");
        const css=Object.entries(entry).filter(([name])=>settings[name]!==false).map(([,value])=>value).join("\\n");
        await tx.promiseComplete();return JSON.stringify({css:css?css+"\\n":""});
      }
      if(mode==="apply") {
        if(JSON.stringify(target)!==JSON.stringify(input.expectedTarget))throw Error("Target CSS features changed since backup; import refused");
        const nextStyles={...styles,website:{...website,[${styleFile}]:makeEntry(entry,input.features,false)}};
        await store.put(nextStyles,${stylesKey});
        const changes={ [${stylesKey}]:{oldValue:oldStyles,newValue:nextStyles} };
        await tx.promiseComplete();committed=true;await ExtensionStorageIDB.notifyListeners(addonId,changes);
        return JSON.stringify({stylesEntry:nextStyles.website[${styleFile}]});
      }
      if(mode==="restore") {
        const record=input.record;const applied=record.applied;
        for(const name of names){if(JSON.stringify(entry[name]??null)!==JSON.stringify(applied.styles[name]??null))throw Error("Target CSS features changed since import; restore refused");}
        const nextEntry=makeEntry(entry,record.backup,true);const nextWebsite={...website};
        if(Object.keys(nextEntry).length)nextWebsite[${styleFile}]=nextEntry;else delete nextWebsite[${styleFile}];
        const nextStyles={...styles,website:nextWebsite};
        await store.put(nextStyles,${stylesKey});
        const changes={ [${stylesKey}]:{oldValue:oldStyles,newValue:nextStyles} };
        await tx.promiseComplete();committed=true;await ExtensionStorageIDB.notifyListeners(addonId,changes);
        return JSON.stringify({stylesEntry:nextStyles.website[${styleFile}]||null});
      }
      throw Error("Unknown CSS storage operation");
    } catch(error) { if(committed)throw Error("CSS transaction committed but its notification failed: "+String(error));try{tx.abort();}catch{}try{await tx.promiseComplete();}catch{}throw error; }
  })()`;
}

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
    this.socketError = null; this.events = []; this.buffer = Buffer.alloc(0);
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
    this.socket = socket;
    socket.on('data', data => { if (this.socket !== socket) return; this.buffer = Buffer.concat([this.buffer, data]); this._parse(); });
    socket.on('error', error => { if (this.socket !== socket) return; this.socketError = error; this.connected = false; });
    socket.on('close', () => { if (this.socket !== socket) return; this.socketError ||= new Error('RDP connection closed'); this.connected = false; this.socket = null; this._wake?.(); this._wake = null; });
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
    if (typeof to !== 'string' || !to) throw new Error(`Invalid RDP actor for ${type}`);
    await this.connectSocketOnly();
    const payload = Buffer.from(JSON.stringify({ to, type, ...args }));
    this.socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
    let msg;
    try { msg = await this._takeMessage(item => item.from === to && this._matchesReply(to, type, item)); }
    catch (error) {
      if (/response timeout/i.test(error.message)) {
        const queued = this.events.slice(0, 5).map(item => `${String(item.from).slice(-18)}/${item.type || 'reply'}[${Object.keys(item).sort().join(',')}]`).join(';');
        error.message = `RDP response timeout waiting ${type} on actor ${typeof to}:${String(to).slice(-18)}; queued actor packets: ${queued || 'none'}`;
        await this.disconnect();
      }
      throw error;
    }
    if (msg.error) throw new Error(msg.message || msg.error); return msg;
  }
  async sendOneWay(to, type, args = {}) {
    if (typeof to !== 'string' || !to) throw new Error(`Invalid RDP actor for ${type}`);
    await this.connectSocketOnly();
    const payload = Buffer.from(JSON.stringify({ to, type, ...args }));
    this.socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
  }
  _matchesReply(to, type, message) {
    if (RDP_EVENT_TYPES.has(message.type)) return false;
    if (message.error) return true;
    if (to === 'root') {
      if (type === 'connect') return typeof message.applicationType === 'string' || Boolean(message.traits) || Object.keys(message).every(key => key === 'from');
      if (type === 'getProcess') return Boolean(message.processDescriptor?.actor);
      if (type === 'listTabs') return Array.isArray(message.tabs);
      if (type === 'listAddons') return Array.isArray(message.addons);
    }
    if (type === 'getTarget') return Boolean(message.process || message.frame || message.target);
    if (type === 'getWatcher') return Boolean(message.watcher?.actor || message.actor);
    if (type === 'evaluateJSAsync') return typeof message.resultID === 'string';
    if (type === 'getStoreObjects') return Array.isArray(message.data);
    if (type === 'substring') return typeof message.substring === 'string';
    return true;
  }
  async connectSocketOnly() { if (!this.socket) await this.connect(); }
  async evaluate(text, consoleActor) {
    const actor = consoleActor ?? this.consoleActor;
    if (typeof actor !== 'string' || !actor) throw new Error('RDP console actor is unavailable');
    const ack = await this.call(actor, 'evaluateJSAsync', { text });
    if (ack.error) throw new Error(ack.message || ack.error);
    const resultID = ack.resultID;
    let msg;
    try { msg = await this._takeMessage(item => item.type === 'evaluationResult' && item.resultID === resultID); }
    catch (error) {
      if (/response timeout/i.test(error.message)) {
        error.message = `RDP response timeout waiting for evaluateJSAsync result (${typeof resultID}); queued result types: ${this.events.filter(item => item.type === 'evaluationResult').slice(0, 5).map(item => typeof item.resultID).join(',') || 'none'}`;
        await this.disconnect();
      }
      throw error;
    }
    if (msg.hasException) throw new Error('RDP privileged evaluation failed');
    return msg.result;
  }
  async asyncValue(expression, consoleActor) {
    if (!this.connected) await this.connect();
    const actor = consoleActor ?? this.consoleActor;
    if (typeof actor !== 'string' || !actor) throw new Error('RDP console actor is unavailable before async evaluation');
    const key = `__zenMcp_${randomUUID().replaceAll('-', '')}`;
    await this.evaluate(`globalThis[${JSON.stringify(key)}]=null; Promise.resolve(${expression}).then(value=>globalThis[${JSON.stringify(key)}]={ok:true,value},error=>globalThis[${JSON.stringify(key)}]={ok:false,error:String(error)}); "started"`, actor);
    const end = Date.now() + this.timeout;
    while (Date.now() < end) {
      const raw = await this.evaluate(`JSON.stringify(globalThis[${JSON.stringify(key)}])`, actor);
      if (raw && raw !== 'null') {
        const result = JSON.parse(raw);
        await this.evaluate(`delete globalThis[${JSON.stringify(key)}]`, actor);
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
  async _cssStorage(operation, payload) {
    const result = await this.asyncValue(cssStorageExpression(operation, payload));
    return typeof result === 'string' ? JSON.parse(result) : result;
  }
  async _cssBackgroundActor() {
    let descriptor;
    for (let attempt = 0; attempt < 12 && !descriptor?.actor; attempt++) {
      const listed = await this.call('root', 'listAddons');
      descriptor = (listed.addons || []).find(addon => addon.id === ZEN_INTERNET_CSS_ADDON.id);
      if (!descriptor?.actor) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!descriptor?.actor) throw new Error('CSS catalog background target unavailable');
    const form = await this.call(descriptor.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true });
    const watcher = form.watcher || form;
    if (!watcher.actor) throw new Error('CSS catalog target watcher unavailable');
    const watcherId = watcher.actor;
    const extensionOrigin = typeof descriptor.manifestURL === 'string' ? descriptor.manifestURL.replace(/\/manifest\.json$/, '') : '';
    if (!extensionOrigin.startsWith('moz-extension://')) throw new Error('CSS catalog extension origin is unavailable');
    this._discardWatcherTargetEvents(watcherId);
    let watched;
    const isBackground = value => {
      const target = value.target || value.targetForm || value;
      return target.url === `${extensionOrigin}/_generated_background_page.html` && typeof target.consoleActor === 'string';
    };
    try {
      watched = await this.call(watcherId, 'watchTargets', { targetType: 'frame' });
      const target = await this._takeMessage(value => value.from === watcherId && value.type === 'target-available-form' && isBackground(value), 5000);
      const selected = target.target || target.targetForm || target;
      return { actor: selected.consoleActor, watcherId };
    } catch (error) {
      await this.sendOneWay(watcherId, 'unwatchTargets', { targetType: 'frame' }).catch(() => {});
      throw error;
    }
  }
  _discardWatcherTargetEvents(watcherId) {
    this.events = this.events.filter(message => message.from !== watcherId || !['target-available-form', 'target-destroyed-form'].includes(message.type));
  }
  async _refreshCssDomain(profile, { requireStored = true } = {}) {
    const target = await this._cssBackgroundActor();
    const expression = `(async()=>{
      const domain=${JSON.stringify(profile.domain)};const styleFile=${JSON.stringify(profile.styleFile)};const expected=${JSON.stringify(profile.features)};
      const settingsKey=${JSON.stringify(`${ZEN_CSS_PROFILE.settingsPrefix}${profile.domain}`)};
      const result=await browser.storage.local.get(["styles",settingsKey]);
      const styles=result.styles||{};const entry=styles.website?.[styleFile]||{};if(${requireStored ? 'true' : 'false'})for(const [name,value] of Object.entries(expected)){if(entry[name]!==value)throw Error("Imported CSS changed before tab refresh");}
      const flags=result[${JSON.stringify(`${ZEN_CSS_PROFILE.settingsPrefix}${profile.domain}`)}]||{};if(flags===null||typeof flags!=="object"||Array.isArray(flags))throw Error("Stored domain feature switches have an unsupported shape");
      if(Object.values(entry).some(value=>typeof value!=="string"||!value.trim()||new TextEncoder().encode(value).byteLength>524288||/@import\\b/i.test(value)))throw Error("Stored domain CSS contains an invalid value");
      const enabled=Object.entries(entry).filter(([name])=>flags[name]!==false).map(([,value])=>value);
      const css=enabled.join("\\n")+(enabled.length?"\\n":"");if(enabled.length)cssCache.set(domain,css);else cssCache.delete(domain);stylingStateCache.delete("styling:"+domain);
      const tabs=await browser.tabs.query({url:["*://"+domain+"/*","*://*."+domain+"/*"]});
      for(const tab of tabs)await applyCSSToTab(tab);
      return JSON.stringify({refreshedTabs:tabs.length});
    })()`;
    let refresh;
    try {
      const raw = await this.asyncValue(expression, target.actor);
      refresh = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } finally {
      await this.sendOneWay(target.watcherId, 'unwatchTargets', { targetType: 'frame' }).catch(() => {});
      this._discardWatcherTargetEvents(target.watcherId);
    }
    return { ...refresh, ...(await this._checkCssDomain(profile)) };
  }
  async _checkCssDomain(profile) {
    const expected = (await this._cssStorage('effectiveCss', { domain: profile.domain, styleFile: profile.styleFile })).css;
    const findCandidates = async () => {
      const listed = await this.call('root', 'listTabs');
      return (listed.tabs || []).filter(tab => {
      try {
        const url = new URL(tab.url);
        return ['http:', 'https:'].includes(url.protocol) && (url.hostname === profile.domain || url.hostname.endsWith(`.${profile.domain}`));
      } catch { return false; }
      });
    };
    let candidates = await findCandidates();
    for (let attempt = 0; candidates.length === 0 && attempt < 8; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      candidates = await findCandidates();
    }
    let verifiedTabs = 0;
    const failures = { watcherUnavailable: 0, targetUnavailable: 0, consoleUnavailable: 0, inspectionFailed: 0, stylesheetMismatch: 0 };
    for (const tab of candidates) {
      if (!tab.actor) { failures.watcherUnavailable++; continue; }
      let watcherId;
      try {
        let watcherForm;
        try { watcherForm = await this.call(tab.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true }); }
        catch { failures.watcherUnavailable++; continue; }
        watcherId = (watcherForm.watcher || watcherForm).actor;
        if (!watcherId) { failures.watcherUnavailable++; continue; }
        this._discardWatcherTargetEvents(watcherId);
        let first;
        try { first = await this.call(watcherId, 'watchTargets', { targetType: 'frame' }); }
        catch { failures.targetUnavailable++; continue; }
        const matchesTab = value => {
          const target = value.target || value.targetForm || value;
          return target.url === tab.url && typeof target.consoleActor === 'string';
        };
        const form = await this._takeMessage(value => value.from === watcherId && value.type === 'target-available-form' && matchesTab(value), 5000).catch(() => null);
        if (!form) { failures.targetUnavailable++; continue; }
        const target = form.target || form.targetForm || form;
        if (typeof target.consoleActor !== 'string') { failures.consoleUnavailable++; continue; }
        const expression = `(()=>{const domain=${JSON.stringify(profile.domain)};const host=location.hostname;const inScope=host===domain||host.endsWith("."+domain);const el=document.getElementById("zeninternet-styles");return inScope&&${expected ? `Boolean(el)&&el.textContent===${JSON.stringify(expected)}` : '!el'}})()`;
        try {
          if (await this.evaluate(expression, target.consoleActor) === true) verifiedTabs++;
          else failures.stylesheetMismatch++;
        } catch { failures.inspectionFailed++; }
      } finally {
        if (watcherId) {
          await this.sendOneWay(watcherId, 'unwatchTargets', { targetType: 'frame' }).catch(() => {});
          this._discardWatcherTargetEvents(watcherId);
        }
      }
    }
    return { matchedTabs: candidates.length, verifiedTabs, allTabsVerified: candidates.length > 0 && verifiedTabs === candidates.length, inspectionFailures: failures };
  }
  async _assertCssAddon() {
    const addon = await this.getAddon(ZEN_INTERNET_CSS_ADDON.id, undefined, ZEN_INTERNET_CSS_ADDON.version);
    if (!addon?.active || !addon.permanent) throw new Error('CSS catalog add-on must be active and permanently installed at version 3.2.0');
    return addon;
  }
  _profileForDomain(raw, domain) {
    if (!raw || typeof raw !== 'object' || raw.domain !== domain || raw.styleFile !== `${domain}.css` || !raw.features || typeof raw.features !== 'object') throw new Error('Explicit domain does not match the CSS profile');
    return raw;
  }
  async _assertGlobalSettingsReady() {
    const result = await this._cssStorage('globalSettings', {});
    const settings = result.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Zen Internet global settings are not initialized; import refused without changing settings');
    const missing = ZEN_INTERNET_DEFAULT_GLOBAL_SETTINGS.filter(key => !Object.hasOwn(settings, key));
    if (missing.length) throw new Error(`Zen Internet global settings are incomplete (${missing.join(', ')}); let the extension initialize normally, then retry`);
    for (const key of ZEN_INTERNET_DEFAULT_GLOBAL_SETTINGS) {
      if (key === 'fallbackBackgroundList') {
        if (!Array.isArray(settings[key])) throw new Error('Zen Internet global settings have an invalid fallbackBackgroundList; import refused');
      } else if (typeof settings[key] !== 'boolean') throw new Error(`Zen Internet global setting ${key} has an invalid value; import refused`);
    }
    return true;
  }
  async cssProfileStatus({ domain }) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain) || domain === 'localhost') throw new Error('Invalid CSS profile domain');
    const addon = await this._assertCssAddon();
    const result = await this._cssStorage('status', { domain, styleFile: `${domain}.css` });
    return { domain, featureNames: result.features, addon: { id: addon.id, version: addon.version, active: addon.active, permanent: addon.permanent }, storageReadOnly: true };
  }
  async verifyZenCssProfile({ profilePath, domain }) {
    if (!path.isAbsolute(profilePath)) throw new Error('Profile path must be absolute');
    const { profile: raw } = await readCssProfileFile(profilePath);
    const profile = this._profileForDomain(raw, domain);
    const addon = await this._assertCssAddon();
    const result = await this._cssStorage('snapshot', profile);
    const mismatches = Object.entries(profile.features).filter(([name, css]) => result.target.styles[name]?.exists !== true || result.target.styles[name]?.value !== css).map(([name]) => name);
    let pageApplication = { checked: false, matchedTabs: 0, verifiedTabs: 0, allTabsVerified: false, inspectionFailures: {} };
    if (mismatches.length === 0) {
      try { pageApplication = { checked: true, ...(await this._checkCssDomain(profile)) }; }
      catch { pageApplication = { checked: false, matchedTabs: 0, verifiedTabs: 0, allTabsVerified: false, inspectionFailures: { pageTargetDiscoveryFailed: 1 } }; }
    }
    return { domain, features: Object.keys(profile.features), matchesStoredProfile: mismatches.length === 0, mismatchedFeatures: mismatches, addon: { id: addon.id, version: addon.version, active: addon.active, permanent: addon.permanent }, storageReadOnly: true, pageApplication };
  }
  async applyZenCssProfile({ profilePath, domain }) {
    if (!path.isAbsolute(profilePath)) throw new Error('Profile path must be absolute');
    const { sourcePath, profile: raw } = await readCssProfileFile(profilePath);
    const profile = this._profileForDomain(raw, domain);
    await this._assertCssAddon();
    await this._assertGlobalSettingsReady();
    const target = { features: profile.features, domain: profile.domain, styleFile: profile.styleFile };
    const snapshot = await this._cssStorage('snapshot', target);
    const backup = {
      format: 'zen-mcp-css-backup-v1', addon: ZEN_INTERNET_CSS_ADDON,
      domain: profile.domain, styleFile: profile.styleFile, createdAt: new Date().toISOString(),
      appliedFeatures: profile.features, backup: snapshot.target,
      applied: { styles: profile.features },
    };
    const backupDir = cssBackupDirectory();
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupDirInfo = await lstat(backupDir);
    if (!backupDirInfo.isDirectory() || backupDirInfo.isSymbolicLink() || (typeof process.getuid === 'function' && backupDirInfo.uid !== process.getuid())) throw new Error('CSS backup directory is not a private directory owned by this user');
    if ((backupDirInfo.mode & 0o077) !== 0) await chmod(backupDir, 0o700);
    if ((await lstat(backupDir)).mode & 0o077) throw new Error('CSS backup directory permissions are not private');
    const backupPath = path.join(backupDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
    await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await this._cssStorage('apply', { ...target, expectedTarget: snapshot.target });
    } catch (error) {
      error.message = `CSS import operation failed; storage may have committed. Backup retained at ${backupPath}. ${error.message}`;
      throw error;
    }
    const readback = await this._cssStorage('snapshot', target);
    for (const [name, css] of Object.entries(profile.features)) {
      if (readback.target.styles[name]?.value !== css) throw new Error(`CSS storage readback mismatch after commit; mutation may be present. Backup: ${backupPath}`);
    }
    let pageApplication;
    try { pageApplication = await this._refreshCssDomain(profile); }
    catch (error) { throw new Error(`CSS storage was committed and read back; page refresh failed. Backup: ${backupPath}. ${error.message}`); }
    return { domain: profile.domain, features: Object.keys(profile.features), addon: ZEN_INTERNET_CSS_ADDON, backupPath, stored: true, readbackVerified: true, pageApplication };
  }
  async restoreZenCssProfile({ backupPath, domain }) {
    if (!path.isAbsolute(backupPath)) throw new Error('Backup path must be absolute');
    const backupDir = await realpath(cssBackupDirectory());
    const absoluteBackup = await realpath(backupPath);
    if (path.relative(backupDir, absoluteBackup).startsWith('..')) throw new Error('CSS backup must be inside the private XDG backup directory');
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error('CSS backup file is not private or is not owned by this user');
    const backupInfo = await stat(absoluteBackup);
    if (backupInfo.size > 2 * 1024 * 1024) throw new Error('CSS backup exceeds the size limit');
    const record = JSON.parse(await readFile(absoluteBackup, 'utf8'));
    const { profile, names } = validateZenCssBackup(record, domain);
    await this._assertCssAddon();
    try { await this._cssStorage('restore', { record, domain: profile.domain, styleFile: profile.styleFile }); }
    catch (error) { error.message = `CSS restore failed; target storage may have changed. Backup retained at ${absoluteBackup}. ${error.message}`; throw error; }
    const readback = await this._cssStorage('snapshot', { features: profile.features, domain: profile.domain, styleFile: profile.styleFile });
    for (const name of names) {
      const oldStyle = record.backup.styles[name];
      if (readback.target.styles[name]?.exists !== oldStyle.exists || (oldStyle.exists && readback.target.styles[name]?.value !== oldStyle.value)) throw new Error(`CSS restore readback failed; target storage may have changed. Backup: ${absoluteBackup}`);
    }
    let pageApplication;
    try { pageApplication = await this._refreshCssDomain(profile, { requireStored: false }); }
    catch (error) { throw new Error(`CSS restore storage is committed; page refresh failed. Backup: ${absoluteBackup}. ${error.message}`); }
    return { domain: profile.domain, restoredFeatures: names, backupPath: absoluteBackup, restored: true, readbackVerified: true, pageApplication };
  }
  async disconnect() { this.socket?.destroy(); this.socket = null; this.connected = false; this.consoleActor = null; this.events = []; }
}
