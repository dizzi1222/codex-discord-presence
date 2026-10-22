#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, loadConfig, saveConfig } from './config.mjs';
import { request } from './local-ipc.mjs';
import { sanitizeHook, PresenceState } from './presence.mjs';
import { DiscordRPC } from './discord-rpc.mjs';

const entry = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function ensureStarted(dir = dataDirectory()) {
  try { return await request({ action: 'status' }, { dir, timeoutMs: 200 }); } catch {}
  const child = spawn(process.execPath, [entry, 'daemon'], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, CODEX_DISCORD_DATA_DIR: dir },
  });
  let spawnError;
  child.on('error', error => { spawnError = error; }); child.unref();
  const deadline = Date.now() + 1400;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await pause(70);
    try { return await request({ action: 'status' }, { dir, timeoutMs: 100 }); } catch {}
  }
  throw new Error('Local daemon did not start. Check Node.js 20+ and write access to the config directory.');
}

async function readHook() {
  return new Promise((resolve, reject) => {
    let data = '', done = false;
    const finish = (error) => {
      if (done) return; done = true; clearTimeout(timer);
      process.stdin.removeAllListeners('data'); process.stdin.removeAllListeners('end'); process.stdin.pause();
      if (error) reject(error); else { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }
    };
    const timer = setTimeout(() => finish(new Error('Hook stdin timeout')), 400);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', part => { data += part; if (data.length > 1024 * 1024) finish(new Error('Hook too large')); });
    process.stdin.on('end', () => finish()); process.stdin.on('error', finish); process.stdin.resume();
  });
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Options require --name value.');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

async function main(command, args) {
  const dir = dataDirectory();
  if (command === 'daemon') { const { runDaemon } = await import('./daemon.mjs'); await runDaemon({ dir }); return; }
  if (command === 'configure') {
    const flags = options(args), next = loadConfig(dir);
    const fields = { 'client-id': 'clientId', 'show-project': 'showProject', 'show-model': 'showModel', 'idle-mode': 'idleMode', language: 'language', enabled: 'enabled', 'large-image': 'largeImage', 'update-interval': 'updateIntervalMs', 'stale-after': 'staleAfterMs' };
    for (const [key, value] of Object.entries(flags)) {
      if (!fields[key]) throw new Error('Unknown option: --' + key);
      if (['show-project', 'show-model', 'enabled'].includes(key)) {
        if (!['true', 'false'].includes(value)) throw new Error('--' + key + ' expects true or false.');
        next[fields[key]] = value === 'true';
      } else if (['update-interval', 'stale-after'].includes(key)) next[fields[key]] = Number(value);
      else next[fields[key]] = value;
    }
    const saved = saveConfig(next, dir);
    console.log(JSON.stringify({ configFile: join(dir, 'config.json'), ...saved }, null, 2)); return;
  }
  if (command === 'start') {
    const config = loadConfig(dir);
    if (!config.clientId) throw new Error('Configure your Discord Application ID first: node src/cli.mjs configure --client-id YOUR_ID');
    console.log(JSON.stringify(await ensureStarted(dir), null, 2)); return;
  }
  if (command === 'status') {
    try { console.log(JSON.stringify(await request({ action: 'status' }, { dir }), null, 2)); }
    catch { console.log(JSON.stringify({ running: false, configured: Boolean(loadConfig(dir).clientId), configFile: join(dir, 'config.json') }, null, 2)); }
    return;
  }
  if (command === 'stop') {
    try { console.log(JSON.stringify(await request({ action: 'stop' }, { dir }))); }
    catch { console.log('Daemon is already stopped.'); } return;
  }
  if (command === 'preview') {
    const state = new PresenceState(), config = loadConfig(dir);
    state.accept({ event: 'UserPromptSubmit', sessionId: 'preview', project: 'my-project', model: 'my-model' });
    console.log(JSON.stringify(state.activity(config), null, 2)); return;
  }
  if (command === 'doctor') {
    const config = loadConfig(dir);
    const result = { node: process.version, platform: process.platform, configFile: join(dir, 'config.json'), configured: Boolean(config.clientId),
      showProject: config.showProject, showModel: config.showModel, enabled: config.enabled,
      discord: 'not_checked', note: 'Hooks must be installed, enabled and trusted in Codex. Discord Activity Privacy must allow activity.' };
    if (config.clientId) {
      const rpc = new DiscordRPC({ clientId: config.clientId, connectTimeoutMs: 500 });
      try { await rpc.connect(); result.discord = 'ready'; } catch { result.discord = 'unavailable'; }
      finally { rpc.close(); }
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  console.log('Codex Discord Presence\n\nnode src/cli.mjs configure --client-id ID --show-project true --show-model true\nnode src/cli.mjs start|stop|status|doctor|preview\n\nConfiguration: ' + join(dir, 'config.json'));
}

const command = process.argv[2];
if (command === 'hook') {
  // Every failure is non-blocking. Hook output must never contain prompts or logs.
  const deadline = setTimeout(() => { process.stdout.write('{}\n'); process.exit(0); }, 2300);
  try {
    const config = loadConfig();
    if (config.enabled && config.clientId) {
      const event = sanitizeHook(await readHook(), config);
      await ensureStarted();
      await request({ action: 'event', event }, { timeoutMs: 300 });
    }
  } catch {} finally { clearTimeout(deadline); process.stdout.write('{}\n'); process.exit(0); }
} else {
  try { await main(command, process.argv.slice(3)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
