import { MarionetteClient } from './marionette.mjs';
import { nativeDispatch } from './native-dispatch.mjs';
const id = { type: 'string', minLength: 1, maxLength: 250 };
const label = { type: 'string', minLength: 1, maxLength: 200 };
const bool = { type: 'boolean' };
const ids = { type: 'array', items: id, minItems: 1, maxItems: 500, uniqueItems: true };
const layout = { type: 'string', enum: ['vsep', 'hsep', 'grid'] };
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const NATIVE_TOOLS = [
  tool('zen_native_snapshot', 'Read native spaces, tabs, folders and Splits with stable IDs; requires an explicitly authorized native profile.'),
  tool('zen_spaces_list', 'List spaces in sidebar order.'),
  tool('zen_space_create', 'Create a uniquely named space.', { name: label, icon: { type: 'string', maxLength: 32 } }, ['name']),
  tool('zen_space_update', 'Rename a space and/or set its icon (empty string clears it).', { spaceId: id, name: label, icon: { type: 'string', maxLength: 32 } }, ['spaceId']),
  tool('zen_space_select', 'Activate a space.', { spaceId: id }, ['spaceId']),
  tool('zen_spaces_reorder', 'Set complete sidebar order; every space must appear exactly once.', { spaceIds: ids }, ['spaceIds']),
  tool('zen_space_merge', 'Move every regular tab, folder and Split from source to target, preserving pinned state; remove source only after successful movement. Refuses live folders.', { sourceId: id, targetId: id }, ['sourceId', 'targetId']),
  tool('zen_space_delete', 'Delete an empty space only. Refuses the last space or a space containing folders or pages.', { spaceId: id }, ['spaceId']),
  tool('zen_tabs_list', 'List native tabs including space, pinned/essential status, folder and Split IDs.', { spaceId: id }),
  tool('zen_tab_create', 'Create a background http(s) or about:blank tab in a space.', { spaceId: id, url: { type: 'string', minLength: 1, maxLength: 8192 }, pinned: bool }, ['spaceId', 'url']),
  tool('zen_tab_pin', 'Pin or unpin a regular tab; affects its entire Split. Refuses essentials and unpinning inside pinned folders.', { tabId: id, pinned: bool }, ['tabId', 'pinned']),
  tool('zen_tab_move', 'Move a regular tab or its whole Split to a space and optional pinned folder. Omit folderId to move to the space root.', { tabId: id, spaceId: id, folderId: id }, ['tabId']),
  tool('zen_folders_list', 'List native pinned folders and their parent IDs.', { spaceId: id }),
  tool('zen_folder_create', 'Create an empty pinned folder in a space, optionally nested.', { name: label, spaceId: id, parentId: id }, ['name', 'spaceId']),
  tool('zen_folder_rename', 'Rename a native folder.', { folderId: id, name: label }, ['folderId', 'name']),
  tool('zen_folder_move', 'Move a folder and all descendants to a space and optional parent; refuses cycles and excess depth.', { folderId: id, spaceId: id, parentId: id }, ['folderId']),
  tool('zen_folder_remove', 'Remove an empty folder, or ungroup while preserving all pages/Splits with keepTabs=true.', { folderId: id, keepTabs: bool }, ['folderId']),
  tool('zen_splits_list', 'List native Split IDs, ordered tab membership, layout and parent folder.'),
  tool('zen_split_create', 'Create a native Split from 2–4 regular tabs sharing one space, pinned state and folder. No implicit cloning.', { tabIds: { ...ids, minItems: 2, maxItems: 4 }, layout }, ['tabIds']),
  tool('zen_split_layout', 'Set Split layout: vsep side by side, hsep stacked, grid columns. Keeps all members.', { splitId: id, layout }, ['splitId', 'layout']),
  tool('zen_split_separate', 'Separate an entire Split into its original tabs without closing pages.', { splitId: id }, ['splitId']),
];
export function validateNativeArgs(name, args) {
  const schema = NATIVE_TOOLS.find(t => t.name === name)?.inputSchema;
  if (!schema) throw new Error('Unknown native command');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key]; if (!spec) throw new Error(`Unknown argument: ${key}`);
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems || new Set(value).size !== value.length || value.some(v => typeof v !== 'string' || !v.length || v.length > 250)) throw new Error(`Invalid argument: ${key}`);
    } else if (typeof value !== spec.type || (spec.type === 'string' && (value.length < (spec.minLength || 0) || value.length > spec.maxLength))) throw new Error(`Invalid argument: ${key}`);
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`Invalid argument: ${key}`);
  }
}
export class NativeTools {
  constructor(env = process.env) {
    this.env = env;
    if (env.ZEN_NATIVE_PORT || env.ZEN_NATIVE_PROFILE) {
      if (!env.ZEN_NATIVE_PORT || !env.ZEN_NATIVE_PROFILE) throw new Error('Set both ZEN_NATIVE_PORT and ZEN_NATIVE_PROFILE');
      if (!/^\d+$/.test(env.ZEN_NATIVE_PORT)) throw new Error('Invalid native port');
      this.client = new MarionetteClient({ port: Number(env.ZEN_NATIVE_PORT), profile: env.ZEN_NATIVE_PROFILE });
    }
  }
  async call(name, args) {
    validateNativeArgs(name, args);
    if (!this.client) throw new Error('Native commands disabled: configure ZEN_NATIVE_PORT and ZEN_NATIVE_PROFILE for an isolated, explicitly authorized Zen profile');
    return this.client.run(async client => {
      const result = await client.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1]; (${nativeDispatch.toString()})(arguments[0], arguments[1]).then(value => done({ok:true,value}), error => done({ok:false,error:error.message}));`,
        args: [name, args], newSandbox: false, scriptTimeout: 12000,
      });
      if (!result.value?.ok) throw new Error(result.value?.error || 'Invalid native response');
      return result.value.value;
    });
  }
  async disconnect() { await this.client?.disconnect(); }
}
