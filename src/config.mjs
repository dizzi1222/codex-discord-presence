import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Discord fetches this public PNG through its image proxy. Bundled SVGs are
// plugin-listing artwork; they cannot be used as local Rich Presence images.
export const defaultLargeImage = 'https://raw.githubusercontent.com/dizzi1222/codex-discord-presence/main/assets/presence.png';

export const defaults = Object.freeze({
  clientId: '', enabled: true, showProject: false, showModel: false,
  idleMode: 'clear', language: 'es', updateIntervalMs: 15000,
  staleAfterMs: 15 * 60 * 1000, largeImage: defaultLargeImage,
});

export function dataDirectory(env = process.env, platform = process.platform) {
  if (env.CODEX_DISCORD_DATA_DIR) return resolve(env.CODEX_DISCORD_DATA_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'codex-discord-presence');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'codex-discord-presence');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex-discord-presence');
}

export function validateConfig(config) {
  const value = { ...defaults };
  for (const key of Object.keys(defaults)) if (config[key] !== undefined) value[key] = config[key];
  if (typeof value.clientId !== 'string' || (value.clientId && !/^\d{17,20}$/.test(value.clientId))) throw new Error('clientId must be a Discord Application ID (17–20 digits).');
  for (const key of ['enabled', 'showProject', 'showModel']) if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  if (!['clear', 'show'].includes(value.idleMode)) throw new Error('idleMode must be clear or show.');
  if (!['es', 'en'].includes(value.language)) throw new Error('language must be es or en.');
  if (!Number.isInteger(value.updateIntervalMs) || value.updateIntervalMs < 1000 || value.updateIntervalMs > 60000) throw new Error('updateIntervalMs must be 1000–60000.');
  if (!Number.isInteger(value.staleAfterMs) || value.staleAfterMs < 60000 || value.staleAfterMs > 86400000) throw new Error('staleAfterMs must be 60000–86400000.');
  if (typeof value.largeImage !== 'string' || value.largeImage.length > 300 || /[\u0000-\u001f\u007f]/.test(value.largeImage)) throw new Error('largeImage must be a Discord asset key or public image URL (up to 300 characters), or empty to hide the image.');
  return value;
}

export function loadConfig(dir = dataDirectory(), env = process.env) {
  let stored = {};
  try { stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read local config.json: ' + error.message); }
  if (env.CODEX_DISCORD_CLIENT_ID) stored.clientId = env.CODEX_DISCORD_CLIENT_ID;
  return validateConfig(stored);
}

export function saveConfig(config, dir = dataDirectory()) {
  const value = validateConfig(config);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `config-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, join(dir, 'config.json'));
  return value;
}

export function localEndpoint(dir = dataDirectory()) {
  const key = createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\codex-discord-${key}` : join(dir, 'daemon.sock');
}
