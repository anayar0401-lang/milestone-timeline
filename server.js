'use strict';
/*
 * Milestone Timeline server — zero dependencies.
 *
 * Persistence (survives restarts, nothing is wiped between uses):
 *   data/milestones.json   all milestone records
 *   data/uploads/          uploaded images / PDFs
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'milestones.json');
const PUBLIC_DIR = path.join(__dirname, 'docs');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // per file

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- storage ----------
let db = { projectName: 'Project Milestones', processes: [], milestones: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Older files have no processes / processId; they load as "unassigned".
  db = { projectName: loaded.projectName || db.projectName, processes: loaded.processes || [], milestones: loaded.milestones || [] };
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`Could not read ${DB_FILE}: ${e.message}\nRefusing to start so existing data is not overwritten.`);
    process.exit(1);
  }
}

// Serialise writes; write to a temp file then rename so a crash never leaves a half-written DB.
let writeChain = Promise.resolve();
function save() {
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeChain;
}

// ---------- helpers ----------
const newId = () => crypto.randomBytes(8).toString('hex');

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Identify the real file type from its first bytes (don't trust extension / header).
function sniff(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === '%PDF') return { ext: '.pdf', kind: 'pdf' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', kind: 'image' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', kind: 'image' };
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return { ext: '.gif', kind: 'image' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', kind: 'image' };
  return null;
}

function cleanText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
const isValidDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Returns the cleaned fields, or { errors } / { error } describing what is wrong.
function validateMilestone(body) {
  const v = {
    date: cleanText(body.date, 10),
    name: cleanText(body.name, 200),
    team: cleanText(body.team, 200),
    notes: cleanText(body.notes, 10000),
    // an unknown / deleted process id is treated as "no process"
    processId: db.processes.some((p) => p.id === body.processId) ? body.processId : null,
  };
  const errors = {};
  if (!isValidDate(v.date)) errors.date = 'Please pick a date.';
  if (!v.name) errors.name = 'Milestone name is required.';
  if (!v.team) errors.team = 'Responsible team is required.';
  return Object.keys(errors).length ? { errors } : v;
}

function validateProcess(body, others) {
  const name = cleanText(body.name, 60);
  const color = typeof body.color === 'string' ? body.color.trim().toLowerCase() : '';
  if (!name) return { error: 'Process name is required.' };
  if (!COLOR_RE.test(color)) return { error: 'Please pick a colour.' };
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) return { error: `A process called "${name}" already exists.` };
  return { name, color };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'state' && method === 'GET') return send(res, 200, db, { 'Cache-Control': 'no-store' });

  if (parts[1] === 'project' && method === 'PUT') {
    const body = await readJson(req);
    const name = cleanText(body.name, 120);
    if (!name) return send(res, 400, { error: 'Project name cannot be empty.' });
    db.projectName = name;
    await save();
    return send(res, 200, { projectName: name });
  }

  if (parts[1] === 'processes') {
    if (parts.length === 2 && method === 'POST') {
      const v = validateProcess(await readJson(req), db.processes);
      if (v.error) return send(res, 400, { error: v.error });
      const proc = { id: newId(), ...v };
      db.processes.push(proc);
      await save();
      return send(res, 201, proc);
    }
    const proc = db.processes.find((x) => x.id === parts[2]);
    if (!proc) return send(res, 404, { error: 'Process not found.' });
    if (parts.length === 3 && method === 'PUT') {
      const v = validateProcess(await readJson(req), db.processes.filter((x) => x !== proc));
      if (v.error) return send(res, 400, { error: v.error });
      Object.assign(proc, v);
      await save();
      return send(res, 200, proc);
    }
    if (parts.length === 3 && method === 'DELETE') {
      db.processes = db.processes.filter((x) => x !== proc);
      for (const m of db.milestones) if (m.processId === proc.id) m.processId = null; // unassign, keep the milestones
      await save();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'milestones') {
    if (parts.length === 2 && method === 'POST') {
      const v = validateMilestone(await readJson(req));
      if (v.errors) return send(res, 400, { error: 'Validation failed', errors: v.errors });
      const m = { id: newId(), ...v, media: [], createdAt: new Date().toISOString() };
      db.milestones.push(m);
      await save();
      return send(res, 201, m);
    }

    const m = db.milestones.find((x) => x.id === parts[2]);
    if (!m) return send(res, 404, { error: 'Milestone not found.' });

    if (parts.length === 3 && method === 'PUT') {
      const v = validateMilestone(await readJson(req));
      if (v.errors) return send(res, 400, { error: 'Validation failed', errors: v.errors });
      Object.assign(m, v);
      await save();
      return send(res, 200, m);
    }

    if (parts[3] === 'media' && parts.length === 5 && method === 'DELETE') {
      const item = m.media.find((f) => f.id === parts[4]);
      if (!item) return send(res, 404, { error: 'Media not found.' });
      m.media = m.media.filter((f) => f !== item);
      await save();
      await fsp.unlink(path.join(UPLOAD_DIR, item.file)).catch(() => {});
      return send(res, 200, { ok: true });
    }

    // Upload one file: raw body, original name in ?filename=
    if (parts[3] === 'media' && parts.length === 4 && method === 'POST') {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD_BYTES) return send(res, 413, { error: 'File is larger than 50 MB.' });
      const original = cleanText(url.searchParams.get('filename') || 'file', 200).replace(/[\\/\0]/g, '_') || 'file';
      const tmp = path.join(UPLOAD_DIR, `.tmp-${newId()}`);
      let bytes = 0;
      const limiter = async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > MAX_UPLOAD_BYTES) throw Object.assign(new Error('File is larger than 50 MB.'), { status: 413 });
          yield chunk;
        }
      };
      try {
        await pipeline(req, limiter, fs.createWriteStream(tmp));
        if (bytes === 0) throw Object.assign(new Error('Empty file.'), { status: 400 });
        const fh = await fsp.open(tmp, 'r');
        const head = Buffer.alloc(16);
        await fh.read(head, 0, 16, 0);
        await fh.close();
        const type = sniff(head);
        if (!type) throw Object.assign(new Error('Only images (PNG, JPG, GIF, WebP) and PDFs are allowed.'), { status: 415 });
        const stored = `${m.id}-${newId()}${type.ext}`;
        await fsp.rename(tmp, path.join(UPLOAD_DIR, stored));
        const item = { id: newId(), file: stored, originalName: original, kind: type.kind, size: bytes };
        m.media.push(item);
        await save();
        return send(res, 201, item);
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    }

    if (parts.length === 3 && method === 'DELETE') {
      db.milestones = db.milestones.filter((x) => x !== m);
      await save();
      await Promise.all(m.media.map((f) => fsp.unlink(path.join(UPLOAD_DIR, f.file)).catch(() => {})));
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
async function serveFile(res, root, relPath, extraHeaders = {}) {
  const full = path.resolve(root, '.' + path.sep + relPath);
  if (full !== root && !full.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    fs.createReadStream(full).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname.startsWith('/uploads/')) {
      const rel = decodeURIComponent(url.pathname.slice('/uploads/'.length));
      return await serveFile(res, UPLOAD_DIR, rel, { 'Cache-Control': 'private, max-age=3600' });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return await serveFile(res, PUBLIC_DIR, rel, { 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.destroy();
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Milestone Timeline running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data stored in ${DATA_DIR} (${db.milestones.length} milestone(s) loaded)`);
});

// Flush any pending write on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { writeChain.finally(() => process.exit(0)); });
}
