import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const OPCODES = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

/** Discord framing uses UTF-8 byte length and two little-endian uint32s. */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error('Discord RPC frame exceeds 1 MiB');
  const result = Buffer.allocUnsafe(8 + body.length);
  result.writeUInt32LE(opcode, 0);
  result.writeUInt32LE(body.length, 4);
  body.copy(result, 8);
  return result;
}

/** Handles fragmented headers/bodies and multiple frames in a socket read. */
export class FrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.#buffer.length >= 8) {
      const opcode = this.#buffer.readUInt32LE(0);
      const length = this.#buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new Error('Discord RPC frame exceeds 1 MiB');
      }
      if (this.#buffer.length < length + 8) break;
      frames.push({ opcode, payload: this.#buffer.subarray(8, length + 8) });
      this.#buffer = this.#buffer.subarray(length + 8);
    }
    return frames;
  }
}

export function discordEndpoints(platform = process.platform, env = process.env) {
  if (platform === 'win32') return Array.from({ length: 10 }, (_, n) => `\\\\?\\pipe\\discord-ipc-${n}`);
  const prefixes = [...new Set([env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean))];
  return prefixes.flatMap(prefix => Array.from({ length: 10 }, (_, n) => path.posix.join(prefix, `discord-ipc-${n}`)));
}

/** Minimal local IPC client. Retry policy belongs to the calling daemon. */
export class DiscordRPC extends EventEmitter {
  #clientId;
  #endpoint;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #socket;
  #ready = false;
  #connectPromise;
  #generation = 0;
  #intentional = false;
  #pending = new Map();

  constructor({ clientId, endpoint, connectTimeoutMs = 1000, requestTimeoutMs = 3000 } = {}) {
    super();
    if (typeof clientId !== 'string' || !/^\d{1,20}$/.test(clientId)) throw new Error('Discord clientId must be a numeric application ID string');
    for (const [name, value] of Object.entries({ connectTimeoutMs, requestTimeoutMs })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    if (endpoint !== undefined && (typeof endpoint !== 'string' || !endpoint)) throw new Error('endpoint must be a nonempty local IPC path');
    this.#clientId = clientId;
    this.#endpoint = endpoint;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get connected() { return this.#ready; }

  connect() {
    if (this.#ready) return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    this.#intentional = false;
    const generation = this.#generation;
    this.#connectPromise = this.#connect(generation).finally(() => { this.#connectPromise = undefined; });
    return this.#connectPromise;
  }

  async #connect(generation) {
    let lastError;
    for (const endpoint of this.#endpoint ? [this.#endpoint] : discordEndpoints()) {
      if (generation !== this.#generation) throw new Error('Discord RPC connection cancelled');
      try {
        await this.#attempt(endpoint, generation);
        return;
      } catch (error) {
        if (generation !== this.#generation) throw new Error('Discord RPC connection cancelled');
        lastError = error;
      }
    }
    const error = new Error(`Cannot connect to Discord desktop: ${lastError?.message ?? 'no IPC endpoints found'}`);
    if (!this.#intentional) this.emit('warning', error);
    throw error;
  }

  #attempt(endpoint, generation) {
    return new Promise((resolve, reject) => {
      const parser = new FrameParser();
      const socket = net.createConnection(endpoint);
      this.#socket = socket;
      let established = false;
      let settled = false;
      let failure;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const fail = error => {
        failure = error;
        finish(error);
        socket.destroy();
      };
      const timer = setTimeout(() => fail(new Error('Discord RPC handshake timed out')), this.#connectTimeoutMs);
      socket.on('connect', () => {
        if (generation !== this.#generation) return fail(new Error('Discord RPC connection cancelled'));
        socket.write(encodeFrame(OPCODES.HANDSHAKE, { v: 1, client_id: this.#clientId }));
      });
      socket.on('data', chunk => {
        try {
          for (const { opcode, payload } of parser.push(chunk)) {
            if (opcode === OPCODES.PING) {
              socket.write(encodeFrame(OPCODES.PONG, payload));
              continue;
            }
            if (opcode === OPCODES.PONG) continue;
            if (opcode === OPCODES.CLOSE) {
              let message = 'Discord closed its RPC connection';
              try { message = JSON.parse(payload.toString('utf8')).message || message; } catch { /* optional explanation */ }
              return fail(new Error(message));
            }
            if (opcode !== OPCODES.FRAME) throw new Error(`Unexpected Discord RPC opcode ${opcode}`);
            const message = JSON.parse(payload.toString('utf8'));
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Discord RPC payload');
            if (message.evt === 'ERROR') {
              const error = new Error(`Discord RPC error ${message.data?.code ?? ''}: ${message.data?.message ?? 'unknown error'}`);
              const pending = this.#pending.get(message.nonce);
              if (pending) {
                this.#pending.delete(message.nonce);
                clearTimeout(pending.timer);
                pending.reject(error);
              } else if (!established) return fail(error);
              this.emit('warning', error);
              continue;
            }
            if (!established) {
              if (message.cmd !== 'DISPATCH' || message.evt !== 'READY') continue;
              if (generation !== this.#generation) return fail(new Error('Discord RPC connection cancelled'));
              established = true;
              this.#ready = true;
              finish();
            } else if (message.nonce && this.#pending.has(message.nonce)) {
              const pending = this.#pending.get(message.nonce);
              this.#pending.delete(message.nonce);
              clearTimeout(pending.timer);
              pending.resolve(message.data);
            }
          }
        } catch (error) {
          this.emit('warning', error);
          fail(error);
        }
      });
      socket.on('error', error => {
        failure = error;
        finish(error);
        if (established && generation === this.#generation && !this.#intentional) this.emit('warning', error);
        socket.destroy();
      });
      socket.on('close', () => {
        finish(failure || new Error('Discord RPC socket closed before READY'));
        if (this.#socket === socket) {
          this.#socket = undefined;
          this.#ready = false;
          this.#rejectPending(failure || new Error('Discord RPC disconnected'));
        }
        if (established && generation === this.#generation && !this.#intentional) this.emit('disconnected', failure);
      });
    });
  }

  async setActivity(activity) {
    const socket = this.#socket;
    if (!this.#ready || !socket || socket.destroyed) throw new Error('Discord RPC is not connected');
    const nonce = randomUUID();
    const frame = encodeFrame(OPCODES.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(nonce);
        const error = new Error('Discord RPC SET_ACTIVITY acknowledgment timed out');
        this.emit('warning', error);
        reject(error);
      }, this.#requestTimeoutMs);
      this.#pending.set(nonce, { resolve, reject, timer });
      socket.write(frame, error => {
        if (!error || !this.#pending.has(nonce)) return;
        this.#pending.delete(nonce);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  clearActivity() { return this.setActivity(null); }

  #rejectPending(error) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  close() {
    this.#intentional = true;
    this.#generation += 1;
    this.#ready = false;
    this.#rejectPending(new Error('Discord RPC connection closed'));
    this.#socket?.destroy();
    this.#socket = undefined;
  }
}
