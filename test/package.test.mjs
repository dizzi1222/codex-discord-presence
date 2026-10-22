import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('local release preserves runtime hook loading and contains an installable marketplace and artwork', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-presence-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'release.zip');
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), output], { windowsHide: true });
  const archive = readFileSync(output), entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 8), 0, 'release entries use uncompressed ZIP storage');
    const size = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const bodyStart = offset + 30 + nameLength + extraLength;
    entries.set(name, archive.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + size;
  }
  const prefix = 'codex-discord-presence/';
  assert.ok([...entries.keys()].every(name => name.startsWith(prefix)));
  assert.equal(entries.has(prefix + 'plugin.json'), false, 'portable manifests cause Codex to skip lifecycle hooks');
  const manifest = JSON.parse(entries.get(prefix + '.codex-plugin/plugin.json'));
  assert.equal(manifest.hooks, './hooks/hooks.json');
  const hooks = JSON.parse(entries.get(prefix + 'hooks/hooks.json'));
  assert.equal(Object.keys(hooks.hooks).length, 7);
  const marketplace = JSON.parse(entries.get(prefix + '.agents/plugins/marketplace.json'));
  assert.equal(marketplace.plugins[0].source.path, './');
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.deepEqual(entries.get(prefix + 'assets/presence.png').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(JSON.parse(entries.get(prefix + 'package.json')).version, manifest.version);
});
