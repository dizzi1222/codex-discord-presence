import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Query local Codex metadata without starting a thread or a model. */
export async function queryCodex(method, params, { executable = process.env.CODEX_CLI_PATH || 'codex', timeoutMs = 5000, spawnProcess = spawn } = {}) {
  timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0, bytes = 0, failure;
  const fail = () => {
    failure ||= new Error('Codex metadata unavailable');
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(); child.stdout.destroy(); child.kill(); }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('close', fail);
  lines.on('error', fail);
  lines.on('line', line => {
    try {
      const response = JSON.parse(line), request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error('Codex metadata unavailable'));
      else request.resolve(response.result);
    } catch { /* Ignore non-protocol output. */ }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
    catch { fail(); }
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, timeoutMs);
  try {
    await call('initialize', { clientInfo: { name: 'codex_discord_presence', title: 'Discord Presence', version: '0.1.2' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return await call(method, params);
  } finally { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); }
}

/** Read the runtime's actual hook inventory without starting a thread or a model. */
export async function inspectCodexHooks(cwd = process.cwd(), options = {}) {
  try {
    const result = await queryCodex('hooks/list', { cwds: [cwd] }, { timeoutMs: 10000, ...options });
    const entry = result.data?.find(item => item.cwd === cwd) || result.data?.[0];
    const hooks = entry?.hooks?.filter(hook => hook.pluginId?.split('@')[0] === 'codex-discord-presence') || [];
    return {
      status: hooks.length ? 'loaded' : 'not_loaded',
      count: hooks.length,
      trusted: hooks.filter(hook => ['trusted', 'managed'].includes(hook.trustStatus)).length,
      needsReview: hooks.filter(hook => ['untrusted', 'modified'].includes(hook.trustStatus)).length,
      enabled: hooks.filter(hook => hook.enabled).length,
      events: hooks.map(hook => ({ event: hook.eventName, trust: hook.trustStatus, enabled: hook.enabled })),
      warningCount: entry?.warnings?.length || 0,
      errorCount: entry?.errors?.length || 0,
    };
  } catch { return { status: 'unavailable' }; }
}
