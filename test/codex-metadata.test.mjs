import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspectCodexHooks, queryCodex } from '../src/codex-hooks.mjs';
import { readSessionTitle } from '../src/codex-metadata.mjs';

function fakeCodex(respond) {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  let input = '', spawnOptions;
  child.stdin.on('data', chunk => {
    input += chunk;
    while (input.includes('\n')) {
      const boundary = input.indexOf('\n'), line = input.slice(0, boundary);
      input = input.slice(boundary + 1);
      const request = JSON.parse(line);
      requests.push(request);
      if (!request.id) continue;
      const response = request.method === 'initialize' ? { result: {} } : respond(request, child);
      if (response) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\n'));
    }
  });
  return {
    child, requests,
    spawnProcess: (_executable, args, options) => {
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      spawnOptions = options;
      return child;
    },
    get spawnOptions() { return spawnOptions; },
  };
}

test('session metadata reads only the assigned name without loading turns', async () => {
  const fake = fakeCodex(() => ({ result: { thread: { name: '  My session  ', preview: 'private prompt' } } }));
  const title = await readSessionTitle('session-id', { spawnProcess: fake.spawnProcess });
  assert.equal(title, 'My session');
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(fake.requests[2].params, { threadId: 'session-id', includeTurns: false });
  assert.equal(fake.spawnOptions.windowsHide, true);
  assert.equal(fake.child.killed, true);
  assert.equal(fake.child.stdin.writableEnded, true);
});

test('unnamed sessions never fall back to a conversation preview', async () => {
  for (const name of [undefined, null, '', '  ', 123]) {
    const fake = fakeCodex(() => ({ result: { thread: { name, preview: 'private prompt' } } }));
    assert.equal(await readSessionTitle('session-id', { spawnProcess: fake.spawnProcess }), null);
    assert.equal(fake.child.killed, true);
  }
});

test('metadata failure and stalled requests return null and close the child', async () => {
  const error = fakeCodex(() => ({ error: { message: 'private diagnostic' } }));
  assert.equal(await readSessionTitle('session-id', { spawnProcess: error.spawnProcess }), null);
  assert.equal(error.child.killed, true);

  const stalled = fakeCodex(() => undefined);
  assert.equal(await readSessionTitle('session-id', { spawnProcess: stalled.spawnProcess, timeoutMs: 20 }), null);
  assert.equal(stalled.child.killed, true);
});

test('metadata timeouts cannot exceed five seconds', async t => {
  const fake = fakeCodex(() => undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = readSessionTitle('session-id', { spawnProcess: fake.spawnProcess, timeoutMs: 60000 });
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal(await result, null);
  assert.equal(fake.child.killed, true);
});

test('hook inspection keeps its existing result shape through the shared transport', async () => {
  const fake = fakeCodex(() => ({ result: { data: [{ cwd: 'test-cwd', hooks: [
    { pluginId: 'codex-discord-presence@codex-presence', eventName: 'Stop', trustStatus: 'trusted', enabled: true },
    { pluginId: 'other@example', eventName: 'Stop', trustStatus: 'trusted', enabled: true },
  ], warnings: [], errors: [] }] } }));
  assert.deepEqual(await inspectCodexHooks('test-cwd', { spawnProcess: fake.spawnProcess }), {
    status: 'loaded', count: 1, trusted: 1, needsReview: 0, enabled: 1,
    events: [{ event: 'Stop', trust: 'trusted', enabled: true }], warningCount: 0, errorCount: 0,
  });
});

test('transport rejects oversized responses even without a newline', async () => {
  const fake = fakeCodex((_request, child) => {
    queueMicrotask(() => child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97)));
  });
  await assert.rejects(queryCodex('thread/read', {}, { spawnProcess: fake.spawnProcess }), /unavailable/);
  assert.equal(fake.child.killed, true);
});
