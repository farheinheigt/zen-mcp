// Serialized into the verified browser chrome context. No caller-supplied code.
export async function nativeDispatch(operation, args) {
  const w = Services.wm.getMostRecentWindow('navigator:browser');
  if (!w?.gZenWorkspaces || !w.gZenFolders || !w.gZenViewSplitter) throw new Error('Unsupported Zen native API');
  const ws = w.gZenWorkspaces, gb = w.gBrowser, fm = w.gZenFolders, sv = w.gZenViewSplitter;
  await ws.promiseInitialized;
  const browserWindows = Array.from(Services.wm.getEnumerator('navigator:browser'));
  const singleWindow = () => { if (browserWindows.length !== 1) throw new Error('Space merge/delete requires exactly one browser window in the authorized profile'); }; 
  const attr = (el, key) => el.getAttribute(key);
  const spaceOf = el => attr(el, 'zen-workspace-id');
  const allTabs = () => Array.from(w.document.querySelectorAll('.tabbrowser-tab')).filter(t => t.linkedBrowser && !t.closing);
  const ordinary = t => !t.hasAttribute('zen-empty-tab') && !t.hasAttribute('zen-essential') && !t.hasAttribute('zen-live-folder-item-id');
  const tabs = () => allTabs().filter(t => !t.hasAttribute('zen-empty-tab'));
  const folders = () => Array.from(w.document.querySelectorAll('zen-folder'));
  const parentOf = el => el.parentElement?.closest('zen-folder') || null;
  const splitOf = t => sv._data.find(s => s.tabs.includes(t));
  const requireSpace = id => { const s = ws.getWorkspaceFromId(id); if (!s) throw new Error('Unknown space ID'); return s; };
  const requireTab = id => { const t = tabs().find(t => t.id === id); if (!t || !ordinary(t)) throw new Error('Unknown or protected tab ID'); return t; };
  const requireFolder = id => { const f = folders().find(f => f.id === id); if (!f || f.isLiveFolder) throw new Error('Unknown or protected folder ID'); return f; };
  const requireSplit = id => { const s = sv._data.find(s => s.groupId === id); if (!s) throw new Error('Unknown Split ID'); return s; };
  const nonempty = name => { if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Name must contain 1–200 characters'); return name.trim(); };
  const normalize = s => s.normalize('NFKC').trim().toLocaleLowerCase();
  const uniqueName = (name, except) => { name = nonempty(name); if (ws.getWorkspaces().some(s => s.uuid !== except && normalize(s.name) === normalize(name))) throw new Error('Space name already exists'); return name; };
  const tabInfo = t => ({ id: t.id, title: t.label, url: t.linkedBrowser?.currentURI?.spec || '', spaceId: spaceOf(t), pinned: t.pinned, essential: t.hasAttribute('zen-essential'), folderId: parentOf(t)?.id || null, splitId: splitOf(t)?.groupId || null });
  const folderInfo = f => ({ id: f.id, name: f.name || f.label, spaceId: spaceOf(f), parentId: parentOf(f)?.id || null, collapsed: f.collapsed, tabIds: Array.from(f.tabs).filter(t => !t.hasAttribute('zen-empty-tab')).map(t => t.id) });
  const splitInfo = s => ({ id: s.groupId, tabIds: s.tabs.map(t => t.id), layout: s.gridType, spaceId: spaceOf(s.tabs[0]), pinned: s.tabs[0].pinned, folderId: parentOf(s.tabs[0].group)?.id || null });
  const spaceInfo = s => ({ id: s.uuid, name: s.name, icon: s.icon || null, active: ws.activeWorkspace === s.uuid, tabCount: tabs().filter(t => spaceOf(t) === s.uuid && !t.hasAttribute('zen-essential')).length });
  const snapshot = () => ({ windowCount: browserWindows.length, spaces: ws.getWorkspaces().map(spaceInfo), tabs: tabs().map(tabInfo), folders: folders().map(folderInfo), splits: sv._data.map(splitInfo) });
  const event = (el, name) => el.dispatchEvent(new w.CustomEvent(name, { bubbles: true }));
  const settle = () => new Promise(resolve => w.setTimeout(resolve, 75));
  const until = async predicate => { for (let i = 0; i < 30; i++) { if (predicate()) return; await settle(); } throw new Error('Zen did not finish the operation; inspect current state before retrying'); };
  const moveFolderSpace = async (folder, target) => {
    requireSpace(target);
    if (spaceOf(folder) === target) return;
    const container = ws.workspaceElement(target)?.pinnedTabsContainer;
    if (!container) throw new Error('Space is not ready');
    fm.changeFolderToSpace(folder, target, { hasDndSwitch: true });
    gb.zenHandleTabMove(folder, () => container.insertBefore(folder, container.querySelector('.pinned-tabs-container-separator')));
    await settle();
  };
  const checkParent = (folder, parent) => {
    if (parent && (folder === parent || folder?.contains(parent))) throw new Error('Folder cycle refused');
    if (parent) {
      const max = Services.prefs.getIntPref('zen.folders.max-subfolders', 5);
      let depth = 1; for (let f = parent; f; f = parentOf(f)) depth++;
      let subtree = 0;
      if (folder) for (const f of folder.querySelectorAll('zen-folder')) { let n = 1; for (let p = parentOf(f); p && p !== folder; p = parentOf(p)) n++; subtree = Math.max(subtree, n); }
      if (depth + subtree > max) throw new Error('Maximum folder depth exceeded');
    }
  };
  const layout = value => { if (!['vsep', 'hsep', 'grid'].includes(value)) throw new Error('Invalid Split layout'); return value; };
  switch (operation) {
    case 'zen_native_snapshot': return snapshot();
    case 'zen_spaces_list': return ws.getWorkspaces().map(spaceInfo);
    case 'zen_space_create': {
      const name = uniqueName(args.name);
      const s = { uuid: Services.uuid.generateUUID().toString(), name, icon: args.icon || null, containerTabId: 0, theme: { type: 'gradient', gradientColors: [], opacity: 0.5, texture: 0 } };
      ws.saveWorkspace(s); await settle(); return spaceInfo(requireSpace(s.uuid));
    }
    case 'zen_space_update': {
      const old = requireSpace(args.spaceId); const s = { ...old };
      if (args.name !== undefined) s.name = uniqueName(args.name, s.uuid);
      if (args.icon !== undefined) s.icon = args.icon || null;
      ws.saveWorkspace(s); await settle(); return spaceInfo(requireSpace(s.uuid));
    }
    case 'zen_space_select': requireSpace(args.spaceId); await ws.changeWorkspaceWithID(args.spaceId); return spaceInfo(requireSpace(args.spaceId));
    case 'zen_spaces_reorder': {
      const current = ws.getWorkspaces().map(s => s.uuid);
      if (!Array.isArray(args.spaceIds) || args.spaceIds.length !== current.length || new Set(args.spaceIds).size !== current.length || args.spaceIds.some(id => !current.includes(id))) throw new Error('Order must contain every space exactly once');
      for (let i = 0; i < args.spaceIds.length; i++) await ws.reorderWorkspace(args.spaceIds[i], i);
      await settle(); return ws.getWorkspaces().map(spaceInfo);
    }
    case 'zen_space_delete': {
      singleWindow(); requireSpace(args.spaceId);
      if (ws.getWorkspaces().length < 2) throw new Error('Cannot delete the last space');
      if (allTabs().some(t => spaceOf(t) === args.spaceId && !t.hasAttribute('zen-empty-tab') && !t.hasAttribute('zen-essential')) || folders().some(f => spaceOf(f) === args.spaceId)) throw new Error('Space is not empty; merge it first');
      await ws.removeWorkspace(args.spaceId); await settle(); return { deleted: args.spaceId };
    }
    case 'zen_space_merge': {
      singleWindow(); requireSpace(args.sourceId); requireSpace(args.targetId);
      if (args.sourceId === args.targetId) throw new Error('Source and target must differ');
      const before = snapshot();
      const sourceTabs = tabs().filter(t => spaceOf(t) === args.sourceId && !t.hasAttribute('zen-essential'));
      if (sourceTabs.some(t => !ordinary(t)) || folders().some(f => spaceOf(f) === args.sourceId && f.isLiveFolder)) throw new Error('Live folders cannot be merged');
      for (const f of folders().filter(f => spaceOf(f) === args.sourceId && !parentOf(f))) await moveFolderSpace(f, args.targetId);
      const remaining = sourceTabs.filter(t => spaceOf(t) === args.sourceId);
      ws.moveTabsToWorkspace(remaining, args.targetId); await settle();
      if (sourceTabs.some(t => spaceOf(t) !== args.targetId) || folders().some(f => spaceOf(f) === args.sourceId)) throw new Error('Move incomplete; source retained');
      const afterMove = snapshot();
      if (JSON.stringify(before.tabs.map(t => t.id).sort()) !== JSON.stringify(afterMove.tabs.map(t => t.id).sort())) throw new Error('Tab set changed; source retained');
      const movedIds = new Set(sourceTabs.map(t => t.id));
      const afterTabs = new Map(afterMove.tabs.map(t => [t.id, t]));
      for (const t of before.tabs) {
        const actual = afterTabs.get(t.id);
        if (!actual || actual.pinned !== t.pinned || actual.essential !== t.essential || actual.folderId !== t.folderId || actual.splitId !== t.splitId || actual.spaceId !== (movedIds.has(t.id) ? args.targetId : t.spaceId)) throw new Error('Tab structure changed; source retained');
      }
      const afterFolders = new Map(afterMove.folders.map(f => [f.id, f]));
      if (before.folders.length !== afterMove.folders.length) throw new Error('Folder set changed; source retained');
      for (const f of before.folders) {
        const actual = afterFolders.get(f.id);
        if (!actual || actual.name !== f.name || actual.parentId !== f.parentId || actual.spaceId !== (f.spaceId === args.sourceId ? args.targetId : f.spaceId)) throw new Error('Folder structure changed; source retained');
      }
      const afterSplits = new Map(afterMove.splits.map(s => [s.id, s]));
      if (before.splits.length !== afterMove.splits.length) throw new Error('Split set changed; source retained');
      for (const s of before.splits) {
        const actual = afterSplits.get(s.id);
        if (!actual || JSON.stringify(actual.tabIds) !== JSON.stringify(s.tabIds) || actual.layout !== s.layout || actual.folderId !== s.folderId || actual.pinned !== s.pinned) throw new Error('Split structure changed; source retained');
      }
      await ws.removeWorkspace(args.sourceId); await settle(); return { merged: args.sourceId, into: args.targetId, movedTabs: sourceTabs.length };
    }
    case 'zen_tabs_list': if (args.spaceId) requireSpace(args.spaceId); return tabs().filter(t => !args.spaceId || spaceOf(t) === args.spaceId).map(tabInfo);
    case 'zen_tab_create': {
      requireSpace(args.spaceId);
      const url = new URL(args.url);
      if (!['https:', 'http:', 'about:'].includes(url.protocol) || (url.protocol === 'about:' && url.href !== 'about:blank')) throw new Error('Only http(s) and about:blank tab URLs are allowed');
      await ws.changeWorkspaceWithID(args.spaceId);
      const t = gb.addTab(url.href, { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}), inBackground: true, skipAnimation: true });
      if (args.pinned) gb.pinTab(t); ws.moveTabToWorkspace(t, args.spaceId); await settle(); return tabInfo(t);
    }
    case 'zen_tab_pin': {
      const t = requireTab(args.tabId); const unit = splitOf(t)?.tabs || [t];
      if (args.pinned === false && parentOf(t)) throw new Error('Move out of the pinned folder before unpinning');
      args.pinned ? gb.pinTab(t) : gb.unpinTab(t); await settle(); return unit.map(tabInfo);
    }
    case 'zen_tab_move': {
      const t = requireTab(args.tabId); const split = splitOf(t); const unit = split?.tabs || [t];
      const parent = args.folderId ? requireFolder(args.folderId) : null;
      const target = args.spaceId || (parent ? spaceOf(parent) : spaceOf(t)); requireSpace(target);
      if (parent && spaceOf(parent) !== target) throw new Error('Folder and target space differ');
      if (parent && !t.pinned) throw new Error('Only pinned tabs can enter a folder');
      ws.moveTabsToWorkspace([...unit], target);
      if (parent) parent.addTabs([split ? t.group : t]);
      else if (parentOf(split ? t.group : t)) {
        const item = split ? t.group : t; const container = t.pinned ? ws.workspaceElement(target).pinnedTabsContainer : ws.workspaceElement(target).tabsContainer;
        gb.zenHandleTabMove(item, () => container.insertBefore(item, container.querySelector('.pinned-tabs-container-separator')));
      }
      await settle(); return unit.map(tabInfo);
    }
    case 'zen_folders_list': if (args.spaceId) requireSpace(args.spaceId); return folders().filter(f => !args.spaceId || spaceOf(f) === args.spaceId).map(folderInfo);
    case 'zen_folder_create': {
      requireSpace(args.spaceId); const name = nonempty(args.name); const parent = args.parentId ? requireFolder(args.parentId) : null;
      if (parent && spaceOf(parent) !== args.spaceId) throw new Error('Parent belongs to another space'); checkParent(null, parent);
      const f = fm.createFolder([], { id: `mcp-${Services.uuid.generateUUID()}`, label: name, workspaceId: args.spaceId, collapsed: false, saveOnWindowClose: true, ...(parent ? { insertAfter: parent.groupContainer.lastElementChild } : {}) });
      await settle(); return folderInfo(f);
    }
    case 'zen_folder_rename': { const f = requireFolder(args.folderId); f.name = nonempty(args.name); event(f, 'ZenFolderRenamed'); return folderInfo(f); }
    case 'zen_folder_move': {
      const f = requireFolder(args.folderId); const parent = args.parentId ? requireFolder(args.parentId) : null; checkParent(f, parent);
      const target = args.spaceId || (parent ? spaceOf(parent) : spaceOf(f)); requireSpace(target);
      if (parent && spaceOf(parent) !== target) throw new Error('Parent belongs to another space');
      await moveFolderSpace(f, target);
      if (parent) parent.addTabs([f]);
      else { const c = ws.workspaceElement(target).pinnedTabsContainer; gb.zenHandleTabMove(f, () => c.insertBefore(f, c.querySelector('.pinned-tabs-container-separator'))); }
      await settle(); return folderInfo(f);
    }
    case 'zen_folder_remove': {
      const f = requireFolder(args.folderId); const content = Array.from(f.tabs).filter(t => !t.hasAttribute('zen-empty-tab'));
      if (!args.keepTabs && (content.length || f.querySelector('zen-folder'))) throw new Error('Folder is not empty; use keepTabs to ungroup');
      await f.unpackTabs(); await until(() => !f.isConnected); return { removed: args.folderId, keptTabIds: content.map(t => t.id) };
    }
    case 'zen_splits_list': return sv._data.map(splitInfo);
    case 'zen_split_create': {
      if (!Array.isArray(args.tabIds) || args.tabIds.length < 2 || args.tabIds.length > 4 || new Set(args.tabIds).size !== args.tabIds.length) throw new Error('A Split needs 2–4 distinct tabs');
      const members = args.tabIds.map(requireTab); const first = members[0]; const parent = parentOf(first);
      if (members.some(t => spaceOf(t) !== spaceOf(first) || t.pinned !== first.pinned || parentOf(t) !== parent || splitOf(t))) throw new Error('Split tabs must share a space, pinned state and folder and not already be split');
      const type = layout(args.layout || 'vsep'); await ws.changeWorkspaceWithID(spaceOf(first));
      const data = sv.splitTabs(members, type, -1, { activate: false }); if (!data) throw new Error('Zen refused Split creation'); await settle(); return splitInfo(data);
    }
    case 'zen_split_layout': {
      const s = requireSplit(args.splitId); const type = layout(args.layout);
      s.gridType = type; s.layoutTree = sv.calculateLayoutTree(s.tabs, type);
      event(s.tabs[0].group, 'ZenSplitViewTabsSplit');
      if (sv._data[sv.currentView] === s) sv.activateSplitView(s, true);
      await settle(); return splitInfo(s);
    }
    case 'zen_split_separate': { const s = requireSplit(args.splitId); const ids = s.tabs.map(t => t.id); sv.removeGroup(sv._data.indexOf(s)); await settle(); return { separated: args.splitId, keptTabIds: ids }; }
    default: throw new Error('Unknown native command');
  }
}
