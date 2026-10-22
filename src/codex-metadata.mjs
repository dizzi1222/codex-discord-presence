import { queryCodex } from './codex-hooks.mjs';

/** Return only an explicitly assigned session name; conversation previews are private. */
export async function readSessionTitle(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const requestedTimeout = options.timeoutMs;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, 5000) : 5000;
  try {
    const result = await queryCodex('thread/read', { threadId: sessionId, includeTurns: false }, { ...options, timeoutMs });
    const name = result?.thread?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch { return null; }
}
