import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, localEndpoint } from './config.mjs';

export function request(message, { dir = dataDirectory(), timeoutMs = 600 } = {}) {
  return new Promise((resolve, reject) => {
    let token;
    try { token = readFileSync(join(dir, 'daemon-token'), 'utf8').trim(); }
    catch (error) { reject(error); return; }
    const socket = net.createConnection(localEndpoint(dir));
    let data = '';
    const timer = setTimeout(() => finish(new Error('Local daemon timeout.')), timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ ...message, token }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 16384) return finish(new Error('Oversized daemon response.'));
      if (data.includes('\n')) {
        try {
          const result = JSON.parse(data.split('\n')[0]);
          if (!result.ok) return finish(new Error(result.error || 'Daemon rejected request.'));
          finish(null, result);
        } catch (error) { finish(error); }
      }
    });
    socket.on('end', () => { if (!data.includes('\n')) finish(new Error('Daemon closed without response.')); });
  });
}
