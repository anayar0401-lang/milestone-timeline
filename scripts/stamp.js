'use strict';
/*
 * Cache-busting for static hosting. GitHub Pages lets browsers cache files for ~10 minutes, so a visitor could
 * otherwise get a NEW index.html with an OLD app.js (or the reverse) right after a deploy and see a broken page.
 * This writes ?v=<content hash> on the CSS/JS links in docs/index.html, so changed files get a new URL.
 *
 *   npm run stamp         update docs/index.html (run after editing docs/*.js or docs/styles.css)
 *   npm test              runs `stamp --check`, which fails if the stamps are out of date
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCS = path.join(__dirname, '..', 'docs');
const FILES = ['styles.css', 'seal.js', 'store.js', 'app.js'];
const indexPath = path.join(DOCS, 'index.html');

const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(DOCS, f))).digest('hex').slice(0, 8);
const html = fs.readFileSync(indexPath, 'utf8');
let out = html;
for (const f of FILES) {
  const re = new RegExp(`(["'])${f.replace('.', '\\.')}(\\?v=[0-9a-f]+)?\\1`, 'g');
  if (!re.test(html)) { console.error(`docs/index.html does not reference ${f}`); process.exit(1); }
  out = out.replace(re, `$1${f}?v=${hash(f)}$1`);
}

if (process.argv.includes('--check')) {
  if (out !== html) { console.error('docs/index.html cache-busting stamps are out of date. Run: npm run stamp'); process.exit(1); }
  console.log('Cache-busting stamps are up to date');
} else if (out !== html) {
  fs.writeFileSync(indexPath, out);
  console.log('Updated stamps in docs/index.html');
} else {
  console.log('Stamps already up to date');
}
