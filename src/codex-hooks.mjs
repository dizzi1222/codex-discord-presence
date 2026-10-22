import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Read the runtime's actual hook inventory without starting a thread or a model. */
export async function inspectCodexHooks(cwd = process.cwd(), { executable = process.env.CODEX_CLI_PATH || 'codex', timeoutMs = 10000 } = {}) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0, bytes = 0;
  const fail = () => {
    for (const { reject } of pending.values()) reject(new Error('Codex hook inspection unavailable'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 1024 * 1024) { fail(); child.kill(); return; }
    try {
      const response = JSON.parse(line), request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error('Codex hook inspection unavailable'));
      else request.resolve(response.result);
    } catch { /* Ignore non-protocol output. */ }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, timeoutMs);
  try {
    await call('initialize', { clientInfo: { name: 'codex_discord_presence_doctor', title: 'Discord Presence doctor', version: '0.1.1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const result = await call('hooks/list', { cwds: [cwd] });
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
  finally { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); }
}
