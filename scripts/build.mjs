// Build: copy web/ to dist/ and inject the Supabase URL + public key.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'web');
const out = join(root, 'dist');

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
const fail = msg => { console.error('build: ' + msg); process.exit(1); };

if (!url || !key) fail('set SUPABASE_URL and SUPABASE_ANON_KEY (see .env.example).');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url))
  console.warn(`build: warning, "${url}" does not look like https://<project-ref>.supabase.co`);

// Safety: refuse secret keys. They must never ship to a browser.
if (key.startsWith('sb_secret_')) fail('that is a SECRET key. Use the publishable (or legacy anon) key.');
if (key.split('.').length === 3) {
  try {
    const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role;
    if (role && role !== 'anon') fail(`that key has role "${role}". Use the anon / publishable key only.`);
  } catch { /* not a decodable JWT; let it through */ }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
(function copy(from, to) {
  for (const name of readdirSync(from)) {
    const a = join(from, name), b = join(to, name);
    if (statSync(a).isDirectory()) { mkdirSync(b, { recursive: true }); copy(a, b); } else copyFileSync(a, b);
  }
})(src, out);

const indexPath = join(out, 'index.html');
let html = readFileSync(indexPath, 'utf8');
if (!html.includes('__SUPABASE_URL__') || !html.includes('__SUPABASE_ANON_KEY__')) fail('placeholders missing from web/index.html');
html = html.split('__SUPABASE_URL__').join(url).split('__SUPABASE_ANON_KEY__').join(key);
writeFileSync(indexPath, html);

// Netlify honours _headers; GitHub Pages ignores it harmlessly.
writeFileSync(join(out, '_headers'),
  '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n');
writeFileSync(join(out, '.nojekyll'), '');

console.log(`build: dist/index.html written (${(html.length / 1024).toFixed(1)} KB) for ${url}`);
