import { basename, win32 } from 'node:path';

export const events = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']);
export function safeText(value, max = 80) {
  return typeof value === 'string' ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
}

// Only these fields cross the local IPC boundary. Prompts, tool input/output,
// transcript paths, and absolute working-directory paths are discarded here.
export function sanitizeHook(input, config) {
  if (!input || !events.has(input.hook_event_name)) throw new Error('Unsupported hook event.');
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 200) throw new Error('Missing session_id.');
  const event = { event: input.hook_event_name, sessionId: input.session_id };
  if (config.showProject && typeof input.cwd === 'string') {
    const pathApi = input.cwd.includes('\\') ? win32 : { basename };
    const name = safeText(pathApi.basename(input.cwd.replace(/[\\/]+$/, '')));
    if (!/^(users?|administrator|root|home|documents|desktop|~|[a-z]:)$/i.test(name)) event.project = name;
  }
  if (config.showModel) event.model = safeText(input.model);
  return event;
}

export class PresenceState {
  constructor() { this.sessions = new Map(); this.sequence = 0; }
  accept(event, now = Date.now()) {
    if (!events.has(event.event) || typeof event.sessionId !== 'string' || !event.sessionId) throw new Error('Invalid event.');
    if (event.event === 'SessionEnd') { this.sessions.delete(event.sessionId); return; }
    const previous = this.sessions.get(event.sessionId);
    const state = event.event === 'UserPromptSubmit' || event.event === 'PostToolUse' ? 'thinking'
      : event.event === 'PreToolUse' ? 'working'
        : event.event === 'Interrupt' ? 'paused' : 'waiting';
    const item = {
      id: event.sessionId, startedAt: previous?.startedAt ?? now,
      updatedAt: now, sequence: ++this.sequence, state,
      project: safeText(event.project) || previous?.project || '',
      model: safeText(event.model) || previous?.model || '',
    };
    this.sessions.set(event.sessionId, item);
    // Keep memory bounded even if the host never delivers SessionEnd.
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
  }
  current(config, now = Date.now()) {
    for (const [key, item] of this.sessions) if (now - item.updatedAt >= config.staleAfterMs) this.sessions.delete(key);
    const all = [...this.sessions.values()];
    const active = all.filter(item => item.state === 'thinking' || item.state === 'working');
    return (active.length ? active : all).sort((a, b) => b.sequence - a.sequence)[0] || null;
  }
  activity(config, now = Date.now()) {
    const item = this.current(config, now);
    if (!item || (config.idleMode === 'clear' && ['waiting', 'paused'].includes(item.state))) return null;
    const labels = config.language === 'en'
      ? { thinking: 'Thinking', working: 'Using tools', waiting: 'Waiting for input', paused: 'Paused' }
      : { thinking: 'Pensando', working: 'Usando herramientas', waiting: 'Esperando instrucciones', paused: 'En pausa' };
    const activity = {
      type: 0,
      details: config.showProject && item.project ? item.project : 'Codex',
      state: safeText([config.showModel ? item.model : '', labels[item.state]].filter(Boolean).join(' · '), 128),
      timestamps: { start: Math.floor(item.startedAt / 1000) },
    };
    if (config.largeImage) activity.assets = { large_image: config.largeImage, large_text: 'Codex Discord Presence' };
    return activity;
  }
}
