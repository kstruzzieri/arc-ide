import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const expectedLanguages = [
  'lang-javascript',
  'lang-python',
  'lang-go',
  'lang-css',
  'lang-html',
  'lang-json',
  'lang-markdown',
  'lang-rust',
  'lang-xml',
  'lang-yaml',
];
const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'));
const records = Object.entries(manifest);
const staticKeys = new Set();

function visit(key) {
  if (staticKeys.has(key)) return;
  const record = manifest[key];
  if (!record) throw new Error(`Vite manifest references missing entry: ${key}`);
  staticKeys.add(key);
  for (const dependency of record.imports ?? []) visit(dependency);
}

for (const [key, record] of records) {
  if (record.isEntry) visit(key);
}
if (staticKeys.size === 0) throw new Error('Vite manifest contains no application entry');

const issues = [];
const staticFiles = new Set([...staticKeys].map((key) => manifest[key].file));
const describes = (key, record, marker) =>
  [key, record.name, record.src, record.file].some((value) => value?.includes(marker));

for (const key of staticKeys) {
  const record = manifest[key];
  if (
    describes(key, record, '@codemirror/lang-') ||
    describes(key, record, 'codemirror-languages')
  ) {
    issues.push(`language implementation is statically reachable: ${key} -> ${record.file}`);
  }
}

if (records.some(([key, record]) => describes(key, record, 'codemirror-languages'))) {
  issues.push('legacy codemirror-languages aggregate chunk is still emitted');
}

for (const packageName of expectedLanguages) {
  const match = records.find(([key, record]) =>
    describes(key, record, `@codemirror/${packageName}`)
  );
  if (!match) {
    issues.push(`missing dynamic manifest entry for @codemirror/${packageName}`);
    continue;
  }
  const [key, record] = match;
  if (!record.isDynamicEntry || staticKeys.has(key) || staticFiles.has(record.file)) {
    issues.push(`@codemirror/${packageName} is not isolated behind a dynamic entry`);
  }
}

let rawTotal = 0;
let gzipTotal = 0;
console.log('Initial static JavaScript graph:');
for (const key of staticKeys) {
  const file = manifest[key].file;
  if (!file.endsWith('.js')) continue;
  const content = readFileSync(new URL(file, dist));
  const gzip = gzipSync(content).length;
  rawTotal += content.length;
  gzipTotal += gzip;
  console.log(`${file} ${content.length} raw ${gzip} gzip`);
}
console.log(`TOTAL ${rawTotal} raw ${gzipTotal} gzip`);

if (issues.length > 0) {
  throw new Error(`CodeMirror language bundle regression:\n- ${issues.join('\n- ')}`);
}
