export const ZEN_INTERNET_CSS_ADDON = Object.freeze({
  id: '{91aa3897-2634-4a8a-9092-279db23a7689}',
  version: '3.2.0',
});

export const ZEN_INTERNET_DEFAULT_GLOBAL_SETTINGS = Object.freeze([
  'enableStyling', 'autoUpdate', 'forceStyling', 'whitelistMode', 'whitelistStyleMode',
  'disableTransparency', 'disableHover', 'disableFooter', 'disableDarkReader', 'enableLogs', 'fallbackBackgroundList',
]);

export const ZEN_CSS_PROFILE = Object.freeze({
  stylesKey: 'styles',
  settingsPrefix: 'transparentZenSettings.',
});

const MAX_CSS_BYTES = 512 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateZenCssProfile(profile) {
  if (!isRecord(profile)) throw new Error('Profile must be a JSON object');
  if (Object.keys(profile).some(key => !['website', 'mapping'].includes(key))) throw new Error('Profile contains an unsupported top-level field');
  if (profile.mapping !== undefined && !isRecord(profile.mapping)) throw new Error('Profile mapping must be an object');
  if (!isRecord(profile.website) || Object.keys(profile.website).length !== 1) {
    throw new Error('Profile must contain exactly one website CSS entry');
  }
  const styleFile = Object.keys(profile.website)[0];
  const domain = styleFile.endsWith('.css') ? styleFile.slice(0, -4) : '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain) || domain === 'localhost') throw new Error('Profile domain is invalid');
  const features = profile.website[styleFile];
  if (!isRecord(features)) throw new Error('Profile CSS features must be an object');
  const names = Object.keys(features);
  if (!names.length || names.length > 20 || names.some(name => !name.trim() || name.length > 250)) throw new Error('Profile contains invalid CSS feature names');
  let totalBytes = 0;
  for (const name of names) {
    const css = features[name];
    if (typeof css !== 'string' || !css.trim() || Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) {
      throw new Error(`Invalid CSS for feature: ${name}`);
    }
    totalBytes += Buffer.byteLength(css, 'utf8');
    if (/@import\b/i.test(css)) throw new Error(`External CSS imports are not allowed: ${name}`);
  }
  if (totalBytes > 1024 * 1024) throw new Error('Profile CSS exceeds the total size limit');
  if (Object.hasOwn(profile, 'addonId') && profile.addonId !== ZEN_INTERNET_CSS_ADDON.id) throw new Error('Unexpected CSS catalog add-on ID');
  if (Object.hasOwn(profile, 'addonVersion') && profile.addonVersion !== ZEN_INTERNET_CSS_ADDON.version) throw new Error('Unexpected CSS catalog version');
  return { domain, styleFile, settingsKey: `${ZEN_CSS_PROFILE.settingsPrefix}${domain}`, features: { ...features } };
}

export function validateZenCssBackup(record, expectedDomain) {
  if (!isRecord(record) || record.format !== 'zen-mcp-css-backup-v1' || record.addon?.id !== ZEN_INTERNET_CSS_ADDON.id || record.addon?.version !== ZEN_INTERNET_CSS_ADDON.version) throw new Error('Unsupported CSS backup file');
  if (record.domain !== expectedDomain || record.styleFile !== `${expectedDomain}.css`) throw new Error('CSS backup domain mismatch');
  const profile = validateZenCssProfile({ website: { [record.styleFile]: record.appliedFeatures } });
  const names = Object.keys(profile.features);
  if (!isRecord(record.backup) || !isRecord(record.backup.styles) || !isRecord(record.applied) || !isRecord(record.applied.styles)) throw new Error('CSS backup storage snapshot is malformed');
  if (Object.keys(record.backup.styles).length !== names.length || Object.keys(record.applied.styles).length !== names.length) throw new Error('CSS backup feature set is malformed');
  for (const name of names) {
    if (record.applied.styles[name] !== profile.features[name]) throw new Error(`CSS backup applied value mismatch: ${name}`);
    const old = record.backup.styles[name];
    if (!isRecord(old) || typeof old.exists !== 'boolean' || (old.exists && (typeof old.value !== 'string' || !old.value.trim() || Buffer.byteLength(old.value, 'utf8') > MAX_CSS_BYTES || /@import\b/i.test(old.value))) || (!old.exists && Object.hasOwn(old, 'value') && old.value !== undefined)) {
      throw new Error(`CSS backup previous value is malformed: ${name}`);
    }
  }
  return { profile, names };
}

function getWebsiteStyles(styles) {
  if (styles === undefined) return {};
  if (!isRecord(styles)) throw new Error('Stored styles value is not an object');
  if (styles.website === undefined) return {};
  if (!isRecord(styles.website)) throw new Error('Stored website styles are not an object');
  return styles.website;
}

export function mergeZenCssStorage({ styles }, profile) {
  const valid = validateZenCssProfile(profile);
  const currentStyles = styles === undefined ? {} : structuredClone(styles);
  const website = getWebsiteStyles(currentStyles);
  const currentDomain = website[valid.styleFile];
  if (currentDomain !== undefined && !isRecord(currentDomain)) throw new Error('Stored domain CSS entry is not an object');
  const mergedDomain = { ...(currentDomain || {}), ...valid.features };
  const mergedStyles = {
    ...currentStyles,
    website: { ...website, [valid.styleFile]: mergedDomain },
  };

  const backup = Object.fromEntries(Object.keys(valid.features).map(name => [name, {
    exists: Object.hasOwn(currentDomain || {}, name), value: currentDomain?.[name],
  }]));
  return {
    writes: { styles: mergedStyles },
    backup,
    expected: { styleFile: valid.styleFile, stylesEntry: mergedDomain },
  };
}

export function zenCssStorageMatches(snapshot, expected) {
  const domain = getWebsiteStyles(snapshot.styles)[expected.styleFile];
  return JSON.stringify(domain ?? null) === JSON.stringify(expected.stylesEntry);
}

export function cssStorageSnapshot(styles, styleFile = 'korben.info.css') {
  const website = getWebsiteStyles(styles);
  const entry = website[styleFile];
  return {
    styles: styles === undefined ? null : structuredClone(styles),
    entry: entry === undefined ? null : structuredClone(entry),
  };
}

export function mergeZenCssRestore(current, backup, applied) {
  const website = getWebsiteStyles(current.styles === null ? undefined : current.styles);
  const domain = { ...(website[applied.styleFile] || {}) };
  for (const name of Object.keys(applied.styles)) {
    if (JSON.stringify(domain[name] ?? null) !== JSON.stringify(applied.styles[name] ?? null)) throw new Error('CSS feature changed since import; restore refused');
  }
  const validNames = Object.keys(applied.styles);
  for (const name of validNames) {
    if (backup[name]?.exists) domain[name] = backup[name].value;
    else delete domain[name];
  }
  const styles = { ...(current.styles || {}), website: { ...website } };
  if (Object.keys(domain).length) styles.website[applied.styleFile] = domain;
  else delete styles.website[applied.styleFile];
  return { styles };
}
