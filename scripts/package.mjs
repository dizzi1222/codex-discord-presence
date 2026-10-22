import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Codex 0.163 skips lifecycle hooks in the portable Agent Plugins format.
// Keep the local install and release in the supported Codex compatibility format.
if (existsSync(join(root, 'plugin.json'))) throw new Error('A portable plugin.json disables lifecycle hooks in this Codex runtime. Use .codex-plugin/plugin.json.');
const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const output = resolve(process.argv[2] || join(root, '..', `${manifest.name}-${manifest.version}.zip`));
const outputRelative = relative(root, output);
if (!isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith('..' + sep)) throw new Error('Write the archive outside the plugin directory.');
const excluded = new Set(['.git', '.github', 'node_modules', 'coverage']);
const table = Array.from({ length: 256 }, (_, n) => {
  let crc = n; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff; for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0;
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not packaged: ' + entry.name);
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    if (/\.(zip|tmp|log)$/.test(entry.name) || entry.name === 'config.json' || entry.name === 'daemon-token') return [];
    return [path];
  });
}
const parts = [], central = []; let offset = 0;
const inventory = files(root);
for (const path of inventory) {
  const name = Buffer.from(manifest.name + '/' + relative(root, path).replaceAll('\\', '/'));
  const data = readFileSync(path), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  parts.push(local, name, data);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8); header.writeUInt16LE(33, 14); header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42); central.push(header, name); offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(inventory.length, 8); end.writeUInt16LE(inventory.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(output, Buffer.concat([...parts, directory, end]));
console.log(JSON.stringify({ archive: output, files: inventory.length, plugin: manifest.name, version: manifest.version }, null, 2));
