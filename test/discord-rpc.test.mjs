import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { DiscordRPC, encodeFrame, FrameParser, OPCODES, MAX_FRAME_BYTES, discordEndpoints } from '../src/discord-rpc.mjs';

const CLIENT_ID = '123456789012345678';

async function fakeDiscord(t, { ready = true, acknowledge = true, fragmentedReady = false, onRequest } = {}) {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-presence-test-${process.pid}-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-rpc-${randomUUID()}.sock`);
  const events = new EventEmitter();
  const sockets = new Set();
  const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const parser = new FrameParser();
    socket.on('data', chunk => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === OPCODES.HANDSHAKE) {
          const handshake = JSON.parse(frame.payload.toString('utf8'));
          requests.push(handshake);
          events.emit('handshake', handshake);
          if (ready) {
            const response = encodeFrame(OPCODES.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
            if (fragmentedReady) {
              socket.write(response.subarray(0, 5));
              setImmediate(() => socket.write(response.subarray(5)));
            } else socket.write(response);
          }
        } else if (frame.opcode === OPCODES.FRAME) {
          const request = JSON.parse(frame.payload.toString('utf8'));
          requests.push(request);
          events.emit('request', request);
          if (onRequest) onRequest(request, socket);
          else if (acknowledge) socket.write(encodeFrame(OPCODES.FRAME, { cmd: request.cmd, nonce: request.nonce, evt: null, data: request.args.activity }));
        } else events.emit('frame', frame);
      }
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { endpoint, sockets, requests, events };
}

function clientFor(t, fixture, options = {}) {
  const rpc = new DiscordRPC({ clientId: CLIENT_ID, endpoint: fixture.endpoint, connectTimeoutMs: 400, requestTimeoutMs: 400, ...options });
  t.after(() => rpc.close());
  return rpc;
}

test('framing counts UTF-8 bytes and parses split and combined frames', () => {
  const value = { state: 'Diseñando 🦊' };
  const frame = encodeFrame(OPCODES.FRAME, value);
  assert.equal(frame.readUInt32LE(4), Buffer.byteLength(JSON.stringify(value)));
  const parser = new FrameParser();
  assert.deepEqual(parser.push(frame.subarray(0, 3)), []);
  assert.deepEqual(parser.push(frame.subarray(3, 9)), []);
  const frames = parser.push(Buffer.concat([frame.subarray(9), frame]));
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[0].payload.toString('utf8')), value);
});

test('frames larger than 1 MiB are rejected before waiting for their body', () => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(OPCODES.FRAME, 0);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
  assert.throws(() => new FrameParser().push(header), /exceeds 1 MiB/);
  assert.throws(() => encodeFrame(OPCODES.FRAME, Buffer.alloc(MAX_FRAME_BYTES + 1)), /exceeds 1 MiB/);
});

test('endpoint discovery follows platform order and avoids duplicate prefixes', () => {
  assert.equal(discordEndpoints('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(discordEndpoints('win32', {}).length, 10);
  assert.deepEqual(discordEndpoints('linux', { XDG_RUNTIME_DIR: '/runtime', TMPDIR: '/runtime', TEMP: '/temp' }).filter(p => p.endsWith('discord-ipc-0')), ['/runtime/discord-ipc-0', '/temp/discord-ipc-0', '/tmp/discord-ipc-0']);
});

test('connect waits for fragmented READY, sends acknowledged activity and clears it', async t => {
  const fixture = await fakeDiscord(t, { fragmentedReady: true });
  const rpc = clientFor(t, fixture);
  assert.equal(rpc.connected, false);
  const connecting = rpc.connect();
  assert.equal(rpc.connect(), connecting);
  await connecting;
  assert.equal(rpc.connected, true);
  assert.deepEqual(fixture.requests[0], { v: 1, client_id: CLIENT_ID });
  const activity = { type: 0, details: 'Working with Codex', state: 'Diseñando 🦊', timestamps: { start: 1700000000 } };
  assert.deepEqual(await rpc.setActivity(activity), activity);
  assert.equal(fixture.requests[1].args.pid, process.pid);
  assert.match(fixture.requests[1].nonce, /^[0-9a-f-]{36}$/);
  await rpc.clearActivity();
  assert.equal(fixture.requests[2].args.activity, null);
});

test('responds to ping with the identical opaque payload', async t => {
  const fixture = await fakeDiscord(t);
  const rpc = clientFor(t, fixture);
  await rpc.connect();
  const pong = once(fixture.events, 'frame');
  const payload = Buffer.from([0, 1, 255, 10]);
  [...fixture.sockets][0].write(encodeFrame(OPCODES.PING, payload));
  const [frame] = await pong;
  assert.equal(frame.opcode, OPCODES.PONG);
  assert.deepEqual(frame.payload, payload);
});

test('request error rejects only its matching nonce and emits a warning', async t => {
  const fixture = await fakeDiscord(t, { onRequest: (request, socket) => socket.write(encodeFrame(OPCODES.FRAME, { cmd: request.cmd, nonce: request.nonce, evt: 'ERROR', data: { code: 4000, message: 'Rejected activity' } })) });
  const rpc = clientFor(t, fixture);
  const warnings = [];
  rpc.on('warning', error => warnings.push(error.message));
  await rpc.connect();
  await assert.rejects(rpc.setActivity({ details: 'Test' }), /Rejected activity/);
  assert.equal(rpc.connected, true);
  assert.match(warnings[0], /4000/);
});

test('request timeout rejects cleanly without requiring an error listener', async t => {
  const fixture = await fakeDiscord(t, { acknowledge: false });
  const rpc = clientFor(t, fixture, { requestTimeoutMs: 35 });
  await rpc.connect();
  await assert.rejects(rpc.setActivity({ details: 'Test' }), /acknowledgment timed out/);
  assert.equal(rpc.connected, true);
});

test('handshake timeout tears down the incomplete socket', async t => {
  const fixture = await fakeDiscord(t, { ready: false });
  const rpc = clientFor(t, fixture, { connectTimeoutMs: 35 });
  await assert.rejects(rpc.connect(), /handshake timed out/);
  assert.equal(rpc.connected, false);
});

test('socket loss rejects pending requests and permits an explicit reconnect', async t => {
  const fixture = await fakeDiscord(t, { acknowledge: false });
  const rpc = clientFor(t, fixture);
  await rpc.connect();
  const disconnected = once(rpc, 'disconnected');
  const requestReceived = once(fixture.events, 'request');
  const pending = assert.rejects(rpc.setActivity({ details: 'Test' }), /disconnected/);
  await requestReceived;
  [...fixture.sockets][0].destroy();
  await disconnected;
  await pending;
  assert.equal(rpc.connected, false);
  await rpc.connect();
  assert.equal(rpc.connected, true);
});

test('intentional close rejects outstanding requests and emits no disconnected event', async t => {
  const fixture = await fakeDiscord(t, { acknowledge: false });
  const rpc = clientFor(t, fixture);
  await rpc.connect();
  let disconnected = false;
  rpc.on('disconnected', () => { disconnected = true; });
  const pending = assert.rejects(rpc.setActivity({ details: 'Test' }), /connection closed/);
  rpc.close();
  await pending;
  assert.equal(rpc.connected, false);
  await assert.rejects(rpc.clearActivity(), /not connected/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnected, false);
});

test('malformed JSON from Discord warns and disconnects without crashing', async t => {
  const fixture = await fakeDiscord(t);
  const rpc = clientFor(t, fixture);
  await rpc.connect();
  const disconnected = once(rpc, 'disconnected');
  [...fixture.sockets][0].write(encodeFrame(OPCODES.FRAME, Buffer.from('{bad')));
  await disconnected;
  assert.equal(rpc.connected, false);
});

test('unavailable endpoint fails and an in-progress connection can be cancelled', async t => {
  const missing = process.platform === 'win32'
    ? `\\\\.\\pipe\\missing-${randomUUID()}`
    : path.join(os.tmpdir(), `missing-${randomUUID()}.sock`);
  const rpc = clientFor(t, { endpoint: missing });
  await assert.rejects(rpc.connect(), /Cannot connect to Discord desktop/);
  const fixture = await fakeDiscord(t, { ready: false });
  const cancellable = clientFor(t, fixture);
  const handshake = once(fixture.events, 'handshake');
  const pending = assert.rejects(cancellable.connect(), /cancelled/);
  await handshake;
  cancellable.close();
  await pending;
});
