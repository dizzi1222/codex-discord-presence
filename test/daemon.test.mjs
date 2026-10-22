import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { runDaemon } from '../src/daemon.mjs';
import { saveConfig, localEndpoint } from '../src/config.mjs';
import { request } from '../src/local-ipc.mjs';

const CLIENT_ID = '123456789012345678';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const realNow = Date.now.bind(Date);
const turn = () => new Promise(resolve => setImmediate(resolve));

class FakeRPC extends EventEmitter {
  connected = false;
  activities = [];
  closeCount = 0;
  async connect() { this.connected = true; }
  async setActivity(activity) {
    if (!this.connected) throw new Error('Fake Discord is disconnected');
    this.activities.push(structuredClone(activity));
    return activity;
  }
  clearActivity() { return this.setActivity(null); }
  close() { this.closeCount += 1; this.connected = false; }
  disconnect() { this.connected = false; this.emit('disconnected'); }
}

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-daemon-test-'));
  const config = saveConfig({ clientId: CLIENT_ID, updateIntervalMs: 1000, ...overrides }, dir);
  const clients = [];
  const daemon = await runDaemon({ dir, rpcFactory: () => { const rpc = new FakeRPC(); clients.push(rpc); return rpc; } });
  t.after(async () => { await daemon?.stop(); rmSync(dir, { recursive: true, force: true }); });
  const send = async (event, sessionId = 'chat-one', extras = {}) => {
    await request({ action: 'event', event: { event, sessionId, ...extras } }, { dir });
    await turn();
    await daemon.tick();
    await turn();
  };
  return { dir, config, clients, daemon, send };
}

function virtualClock(t) {
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return ms => { now += ms; };
}

async function rawRequest(dir, message) {
  const socket = net.createConnection(localEndpoint(dir));
  let response = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Test IPC timeout')); }, 700);
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      try { resolve(response ? JSON.parse(response.trim()) : null); } catch (error) { reject(error); }
    });
  });
}

test('an idle event clears immediately and a coalesced tool update never reappears', async t => {
  const advance = virtualClock(t);
  const { send, clients, daemon } = await fixture(t);
  await send('UserPromptSubmit');
  assert.equal(clients[0].activities.at(-1).state, 'Pensando');
  await send('PreToolUse');
  assert.equal(clients[0].activities.length, 1, 'tool update is coalesced within the interval');
  await send('Stop');
  assert.equal(clients[0].activities.at(-1), null, 'idle clear bypasses the update interval');
  advance(2000);
  await daemon.tick();
  assert.deepEqual(clients[0].activities.map(activity => activity?.state ?? null), ['Pensando', null]);
});

test('reconnection publishes the latest state instead of replaying the last sent activity', async t => {
  const advance = virtualClock(t);
  const { send, clients, daemon } = await fixture(t);
  await send('UserPromptSubmit');
  clients[0].disconnect();
  await daemon.tick();
  await send('PreToolUse');
  assert.equal(clients.length, 1, 'backoff prevents an immediate reconnect');
  advance(1100);
  await daemon.tick();
  assert.equal(clients.length, 2);
  assert.equal(clients[1].activities.at(-1).state, 'Usando herramientas');
  assert.equal(clients[0].closeCount, 1);
});

test('an idle second chat cannot replace an active chat, and SessionEnd restores another active chat', async t => {
  const advance = virtualClock(t);
  const { send, clients, daemon } = await fixture(t, { showProject: true });
  await send('UserPromptSubmit', 'chat-one', { project: 'first-project' });
  await send('SessionStart', 'chat-two', { project: 'second-project' });
  advance(1100);
  await daemon.tick();
  assert.equal(clients[0].activities.at(-1).details, 'first-project');
  await send('UserPromptSubmit', 'chat-two', { project: 'second-project' });
  advance(1100);
  await daemon.tick();
  assert.equal(clients[0].activities.at(-1).details, 'second-project');
  await send('SessionEnd', 'chat-two');
  advance(1100);
  await daemon.tick();
  assert.equal(clients[0].activities.at(-1).details, 'first-project');
});

test('authenticated IPC rejects bad tokens and unknown events while retaining a usable daemon', async t => {
  const { dir, daemon } = await fixture(t);
  assert.deepEqual(await rawRequest(dir, { action: 'stop', token: 'invalid' }), { ok: false, error: 'Unauthorized' });
  await assert.rejects(request({ action: 'event', event: { event: 'FakeEvent', sessionId: 'test' } }, { dir }), /Invalid request/);
  await assert.rejects(request({ action: 'event', event: { event: 'UserPromptSubmit', sessionId: '' } }, { dir }), /Invalid request/);
  const status = await request({ action: 'status' }, { dir });
  assert.equal(status.ok, true);
  assert.equal(daemon.state.sessions.size, 0);
});

test('default privacy settings discard names supplied directly to the daemon', async t => {
  const { dir, send, daemon, clients } = await fixture(t);
  await send('UserPromptSubmit', 'safe-session', { project: 'private-project-name', model: 'private-model-name', prompt: 'private-prompt', cwd: '/private/absolute/path' });
  const status = await request({ action: 'status' }, { dir });
  assert.equal(clients[0].activities.at(-1).details, 'Codex');
  assert.equal(daemon.state.sessions.get('safe-session').project, '');
  assert.equal(daemon.state.sessions.get('safe-session').model, '');
  assert.doesNotMatch(JSON.stringify(status), /private-/);
});

test('stop clears presence, closes RPC and removes authentication and lock files', async t => {
  const { dir, send, clients, daemon } = await fixture(t);
  await send('UserPromptSubmit');
  await daemon.stop();
  assert.equal(clients[0].activities.at(-1), null);
  assert.equal(clients[0].connected, false);
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  assert.equal(existsSync(join(dir, 'daemon-token')), false);
  await assert.rejects(request({ action: 'status' }, { dir }));
});

test('malformed startup configuration leaves no lock or token blocking repair', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bad-config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), '{invalid json');
  await assert.rejects(runDaemon({ dir, rpcFactory: () => new FakeRPC() }), /config/i);
  assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  assert.equal(existsSync(join(dir, 'daemon-token')), false);
  saveConfig({ clientId: CLIENT_ID }, dir);
  const daemon = await runDaemon({ dir, rpcFactory: () => new FakeRPC() });
  assert.ok(daemon, 'a repaired configuration can start in the same process');
  await daemon.stop();
});

function invokeHook(dir, input, { keepStdinOpen = false } = {}) {
  const start = realNow();
  const child = spawn(process.execPath, [cli, 'hook'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_DISCORD_DATA_DIR: dir, CODEX_DISCORD_CLIENT_ID: CLIENT_ID } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => { stdout += part; });
  child.stderr.on('data', part => { stderr += part; });
  if (input !== undefined) child.stdin.write(input);
  if (!keepStdinOpen) child.stdin.end();
  child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook exceeded its fail-open deadline')); }, 3500);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, elapsed: realNow() - start }); });
  });
}

test('hook fails open with exactly {} for malformed config, unknown events, and stalled stdin', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hook-fail-open-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), '{broken');
  let result = await invokeHook(dir, '{"private":"must not leak"}');
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: '{}\n', stderr: '' });
  saveConfig({ clientId: CLIENT_ID }, dir);
  result = await invokeHook(dir, JSON.stringify({ hook_event_name: 'UnknownEvent', session_id: 'test', prompt: 'must not leak' }));
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: '{}\n', stderr: '' });
  result = await invokeHook(dir, undefined, { keepStdinOpen: true });
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: '{}\n', stderr: '' });
  assert.ok(result.elapsed < 2000, 'missing stdin fails before Codex hook timeout');
  assert.equal(existsSync(join(dir, 'daemon.lock')), false, 'invalid events never start a daemon');
});

test('hook completes within its deadline when a local daemon accepts connections but never answers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hook-timeout-'));
  saveConfig({ clientId: CLIENT_ID }, dir);
  writeFileSync(join(dir, 'daemon.lock'), String(process.pid));
  writeFileSync(join(dir, 'daemon-token'), 'test-only-token');
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.listen(localEndpoint(dir));
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await invokeHook(dir, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'deadline-test', prompt: 'never publish this' }));
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: '{}\n', stderr: '' });
  assert.ok(result.elapsed < 3000, `hook took ${result.elapsed}ms`);
});
