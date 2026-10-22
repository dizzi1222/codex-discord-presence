import net from 'node:net';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dataDirectory, loadConfig, localEndpoint } from './config.mjs';
import { PresenceState, events } from './presence.mjs';
import { DiscordRPC } from './discord-rpc.mjs';
import { readSessionTitle } from './codex-metadata.mjs';

export async function runDaemon({ dir = dataDirectory(), rpcFactory = options => new DiscordRPC(options), titleResolver = readSessionTitle } = {}) {
  let config = loadConfig(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'daemon.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let alive = true;
    try {
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      process.kill(pid, 0);
    } catch (failure) { alive = failure.code !== 'ESRCH'; }
    if (alive) return null;
    rmSync(lockPath, { force: true });
    try { lock = openSync(lockPath, 'wx', 0o600); } catch { return null; }
  }
  writeFileSync(lock, String(process.pid)); closeSync(lock);
  const token = randomBytes(32).toString('hex');
  writeFileSync(join(dir, 'daemon-token'), token, { mode: 0o600 });
  const endpoint = localEndpoint(dir);
  if (process.platform !== 'win32' && existsSync(endpoint)) rmSync(endpoint);
  const state = new PresenceState();
  let rpc = null, clientId = '', lastError = null;
  let shuttingDown = false, running = false, lastSent = '', lastSentAt = 0, nextConnectAt = 0, backoff = 1000;
  let lastEventAt = null, lastEvent = null;
  const titleChecks = new Map();
  function refreshSessionTitle() {
    if (!config.enabled || !config.showSession || shuttingDown) return;
    const item = state.current(config);
    if (!item || Date.now() - (titleChecks.get(item.id) ?? -Infinity) < 30000) return;
    titleChecks.set(item.id, Date.now());
    if (titleChecks.size > 100) titleChecks.delete(titleChecks.keys().next().value);
    void Promise.resolve().then(() => titleResolver(item.id)).then(title => {
      if (!shuttingDown && config.showSession && typeof title === 'string') { state.setSessionTitle(item.id, title); void tick(); }
    }).catch(() => {});
  }
  const sockets = new Set();
  async function tick() {
    if (running || shuttingDown) return;
    running = true;
    try {
      config = loadConfig(dir);
      if (!config.showSession) { for (const item of state.sessions.values()) item.sessionTitle = ''; titleChecks.clear(); }
      refreshSessionTitle();
      let activity = state.activity(config);
      if (rpc && (clientId !== config.clientId || !config.enabled)) {
        try { if (rpc.connected) await rpc.clearActivity(); } catch {}
        rpc.close(); rpc = null; lastSent = ''; nextConnectAt = 0;
      }
      if (!config.enabled || !config.clientId) { lastError = config.clientId ? 'disabled' : 'client_id_required'; return; }
      // Do not open Discord or keep retrying when there is no visible activity.
      if (!rpc && !activity) return;
      if (!rpc) {
        if (Date.now() < nextConnectAt) return;
        clientId = config.clientId;
        rpc = rpcFactory({ clientId, connectTimeoutMs: 500, requestTimeoutMs: 2500 });
        rpc.on('warning', () => { lastError = 'discord_rpc_error'; });
        rpc.on('disconnected', () => { lastSent = ''; });
        try { await rpc.connect(); backoff = 1000; lastSent = ''; lastSentAt = 0; }
        catch {
          rpc.close(); rpc = null; lastError = 'discord_unavailable';
          nextConnectAt = Date.now() + backoff; backoff = Math.min(backoff * 2, 60000); return;
        }
      }
      if (!rpc.connected) { rpc.close(); rpc = null; nextConnectAt = Date.now() + backoff; return; }
      // Hooks may arrive while the Discord handshake is in flight. Publish the
      // latest state so a completed turn cannot reappear after connecting.
      activity = state.activity(config);
      const key = JSON.stringify(activity);
      if (lastSent === key) return;
      // Clearing is immediate so stale updates cannot reclaim an idle presence.
      if (activity !== null && Date.now() - lastSentAt < config.updateIntervalMs) return;
      await rpc.setActivity(activity);
      lastSent = key; lastSentAt = Date.now(); lastError = null;
    } catch { lastError = 'presence_update_failed'; rpc?.close(); rpc = null; lastSent = ''; nextConnectAt = Date.now() + backoff; }
    finally { running = false; }
  }
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setTimeout(1500, () => socket.destroy());
    let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8192) return socket.destroy();
      if (!buffer.includes('\n')) return;
      const line = buffer.split('\n')[0]; buffer = '';
      try {
        const message = JSON.parse(line);
        const received = Buffer.from(typeof message.token === 'string' ? message.token : '');
        const expected = Buffer.from(token);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) return socket.end('{"ok":false,"error":"Unauthorized"}\n');
        if (message.action === 'event') {
          const event = message.event;
          if (!event || !events.has(event.event) || typeof event.sessionId !== 'string' || event.sessionId.length > 200) throw new Error('Invalid event');
          state.accept({ event: event.event, sessionId: event.sessionId,
            project: config.showProject ? event.project : '', model: config.showModel ? event.model : '' });
          lastEventAt = Date.now(); lastEvent = event.event;
          socket.end('{"ok":true}\n'); void tick();
        } else if (message.action === 'status') {
          socket.end(JSON.stringify({ ok: true, pid: process.pid, connected: Boolean(rpc?.connected), configured: Boolean(config.clientId),
            published: Boolean(rpc?.connected && lastSent && lastSent !== 'null'), lastPublishedAt: lastSentAt || null,
            enabled: config.enabled, sessions: state.sessions.size, activity: state.activity(config), lastEventAt, lastEvent, lastError }) + '\n');
        } else if (message.action === 'stop') { socket.end('{"ok":true}\n'); setTimeout(() => void stop(), 30); }
        else socket.end('{"ok":false,"error":"Unknown action"}\n');
      } catch { socket.end('{"ok":false,"error":"Invalid request"}\n'); }
    });
  });
  const timer = setInterval(() => void tick(), 500);
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true; clearInterval(timer);
    try { if (rpc?.connected) await rpc.clearActivity(); } catch {}
    rpc?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(lockPath, { force: true }); rmSync(join(dir, 'daemon-token'), { force: true });
    if (process.platform !== 'win32') rmSync(endpoint, { force: true });
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
  } catch (error) { clearInterval(timer); rmSync(lockPath, { force: true }); throw error; }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { stop, state, tick };
}
