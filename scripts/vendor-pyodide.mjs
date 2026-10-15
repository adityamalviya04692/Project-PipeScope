// Copies the Pyodide runtime into public/pyodide/ and downloads a pinned,
// checksum-verified sqlglot wheel next to it. Everything is then served from
// our own origin: no CDN, and no user SQL ever leaves the browser.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'pyodide');
const SRC = join(ROOT, 'node_modules', 'pyodide');
const SQLGLOT_VERSION = '30.23.0';
const WHEEL = `sqlglot-${SQLGLOT_VERSION}-py3-none-any.whl`;

const RUNTIME_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync(OUT, { recursive: true });
for (const f of RUNTIME_FILES) copyFileSync(join(SRC, f), join(OUT, f));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const wheelPath = join(OUT, WHEEL);

async function expectedDigest() {
  const res = await fetch(`https://pypi.org/pypi/sqlglot/${SQLGLOT_VERSION}/json`);
  if (!res.ok) throw new Error(`PyPI metadata request failed: ${res.status}`);
  const meta = await res.json();
  const file = meta.urls.find((u) => u.filename === WHEEL);
  if (!file) throw new Error(`${WHEEL} not found on PyPI`);
  return { url: file.url, digest: file.digests.sha256 };
}

const manifest = join(OUT, 'sqlglot.json');
if (existsSync(wheelPath) && existsSync(manifest)) {
  const { sha256: want } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (sha256(readFileSync(wheelPath)) === want) {
    console.log(`pyodide runtime copied; ${WHEEL} already present`);
    process.exit(0);
  }
}

const { url, digest } = await expectedDigest();
const res = await fetch(url);
if (!res.ok) throw new Error(`wheel download failed: ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (sha256(buf) !== digest) throw new Error(`checksum mismatch for ${WHEEL}`);
writeFileSync(wheelPath, buf);
writeFileSync(manifest, JSON.stringify({ wheel: WHEEL, version: SQLGLOT_VERSION, sha256: digest }, null, 2));
console.log(`pyodide runtime copied; downloaded ${WHEEL} (${(buf.length / 1024).toFixed(0)} KB, sha256 verified)`);
