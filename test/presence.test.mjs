import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../src/config.mjs';
import { PresenceState, sanitizeHook } from '../src/presence.mjs';

test('privacy allowlist discards prompts, paths, tools and transcript, explicit names only', () => {
  const raw = { hook_event_name: 'UserPromptSubmit', session_id: 'abc', cwd: 'C:\\private\\project', model: 'GPT-6', prompt: 'secret', tool_input: { token: 'secret' }, transcript_path: '/secret' };
  assert.deepEqual(sanitizeHook(raw, defaults), { event: 'UserPromptSubmit', sessionId: 'abc' });
  assert.deepEqual(sanitizeHook(raw, { ...defaults, showProject: true, showModel: true }), { event: 'UserPromptSubmit', sessionId: 'abc', project: 'project', model: 'GPT-6' });
  assert.throws(() => sanitizeHook({ ...raw, hook_event_name: 'Fake' }, defaults));
});
test('session lifecycle yields on stop and end; timestamps survive state changes', () => {
  const config = { ...defaults, showProject: true, showModel: true }, state = new PresenceState();
  state.accept({ event: 'SessionStart', sessionId: 'one', project: 'repo', model: 'GPT-6' }, 10000);
  assert.equal(state.activity(config, 10000), null);
  state.accept({ event: 'UserPromptSubmit', sessionId: 'one' }, 12000);
  assert.deepEqual(state.activity(config, 12000), { type: 0, details: 'repo', state: 'GPT-6 · Pensando', timestamps: { start: 10 } });
  state.accept({ event: 'PreToolUse', sessionId: 'one' }, 13000);
  assert.equal(state.activity(config, 13000).timestamps.start, 10);
  state.accept({ event: 'Stop', sessionId: 'one' }, 14000);
  assert.equal(state.activity(config, 14000), null);
  state.accept({ event: 'SessionEnd', sessionId: 'one' }, 15000);
  assert.equal(state.sessions.size, 0);
});
test('idle sessions do not overwrite another active chat; stale activity expires', () => {
  const state = new PresenceState(), config = { ...defaults, showProject: true };
  state.accept({ event: 'UserPromptSubmit', sessionId: 'one', project: 'active' }, 0);
  state.accept({ event: 'SessionStart', sessionId: 'two', project: 'idle' }, 100);
  assert.equal(state.activity(config, 100).details, 'active');
  assert.equal(state.activity(config, defaults.staleAfterMs + 101), null);
});
test('configuration rejects invalid identities and settings', () => {
  assert.throws(() => validateConfig({ clientId: '123' }));
  assert.throws(() => validateConfig({ showProject: 'true' }));
  assert.throws(() => validateConfig({ updateIntervalMs: 1 }));
  assert.equal(validateConfig({ clientId: '123456789012345678' }).enabled, true);
});
