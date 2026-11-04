import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeZenCssRestore,
  mergeZenCssStorage,
  validateZenCssBackup,
  validateZenCssProfile,
  zenCssStorageMatches,
} from '../src/zen-css-profile.mjs';

const domain = 'korben.info';
const profile = {
  website: { 'korben.info.css': {
    transparency: 'body { background: transparent; }',
    'no promotions $ Hide sponsored sections, related articles, previous/next article links and header support buttons.': '.sponsored { display: none; }',
  } },
  mapping: {},
};

test('CSS import merges only named features and preserves styles maps and flags', () => {
  const styles = {
    global: 'preserve', mappings: { keep: ['x'] },
    website: {
      'other.example.css': { untouched: '.x {}' },
      'korben.info.css': { transparency: '.old {}', existing: '.keep {}' },
    },
  };
  const originalSwitches = { transparency: false, unrelated: true };
  const result = mergeZenCssStorage({ styles, settings: originalSwitches }, profile);
  assert.deepEqual(result.writes.styles.global, 'preserve');
  assert.deepEqual(result.writes.styles.mappings, { keep: ['x'] });
  assert.deepEqual(result.writes.styles.website['other.example.css'], { untouched: '.x {}' });
  assert.deepEqual(result.writes.styles.website['korben.info.css'], {
    transparency: profile.website['korben.info.css'].transparency,
    existing: '.keep {}',
    [Object.keys(profile.website['korben.info.css'])[1]]: Object.values(profile.website['korben.info.css'])[1],
  });
  assert.deepEqual(result.backup, {
    transparency: { exists: true, value: '.old {}' },
    [Object.keys(profile.website['korben.info.css'])[1]]: { exists: false, value: undefined },
  });
  assert.deepEqual(originalSwitches, { transparency: false, unrelated: true });
  assert.equal(zenCssStorageMatches({ styles: result.writes.styles }, result.expected), true);
  assert.deepEqual(styles.website['korben.info.css'], { transparency: '.old {}', existing: '.keep {}' });
});

test('CSS profile validation accepts one public-domain file and rejects scope drift', () => {
  assert.equal(validateZenCssProfile(profile).domain, domain);
  assert.throws(() => validateZenCssProfile({ website: { 'example.org.css': profile.website['korben.info.css'], 'other.test.css': {} } }), /exactly one/);
  assert.throws(() => validateZenCssProfile({ website: { 'localhost.css': profile.website['korben.info.css'] } }), /domain is invalid/);
  assert.throws(() => validateZenCssProfile({ website: { 'example.org.css': { transparency: '@import url(https://bad.test/x.css);' } } }), /imports are not allowed/);
  assert.throws(() => validateZenCssProfile({ website: { 'example.org.css': { transparency: ' ' } } }), /Invalid CSS/);
  assert.throws(() => validateZenCssProfile({ ...profile, extra: true }), /unsupported top-level/);
});

test('restore refuses targeted drift and preserves all unrelated concurrent changes', () => {
  const imported = mergeZenCssStorage({ styles: {} }, profile);
  const afterImport = {
    ...imported.writes.styles,
    unrelatedGlobal: 'newer',
    website: {
      ...imported.writes.styles.website,
      'other.example.css': { unrelated: 'changed concurrently' },
    },
  };
  const restored = mergeZenCssRestore(
    { styles: afterImport }, imported.backup,
    { styleFile: 'korben.info.css', styles: profile.website['korben.info.css'] },
  );
  assert.equal(Object.hasOwn(restored.styles.website, 'korben.info.css'), false);
  assert.equal(restored.styles.unrelatedGlobal, 'newer');
  assert.deepEqual(restored.styles.website['other.example.css'], { unrelated: 'changed concurrently' });
  const conflict = structuredClone(afterImport);
  conflict.website['korben.info.css'].transparency = '.user edit';
  assert.throws(() => mergeZenCssRestore(
    { styles: conflict }, imported.backup,
    { styleFile: 'korben.info.css', styles: profile.website['korben.info.css'] },
  ), /changed since import/);
});

test('CSS backups validate exact domain, feature set, catalog and bounded old CSS', () => {
  const merged = mergeZenCssStorage({ styles: { website: { 'korben.info.css': { transparency: '.old {}' } } } }, profile);
  const record = {
    format: 'zen-mcp-css-backup-v1',
    addon: { id: '{91aa3897-2634-4a8a-9092-279db23a7689}', version: '3.2.0' },
    domain: 'korben.info', styleFile: 'korben.info.css',
    appliedFeatures: profile.website['korben.info.css'],
    applied: { styles: profile.website['korben.info.css'] },
    backup: { styles: merged.backup },
  };
  assert.deepEqual(validateZenCssBackup(record, 'korben.info').names, Object.keys(profile.website['korben.info.css']));
  const forged = structuredClone(record);
  forged.backup.styles.transparency.value = 42;
  assert.throws(() => validateZenCssBackup(forged, 'korben.info'), /previous value is malformed/);
  assert.throws(() => validateZenCssBackup(record, 'other.example'), /domain mismatch/);
});
