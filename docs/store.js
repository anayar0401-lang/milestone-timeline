'use strict';
/*
 * Storage backends. The UI (app.js) only talks to this interface:
 *   mode                        'server' | 'browser'
 *   getState()                  -> { projectName, milestones: [{ ..., media: [{ id, originalName, kind, size, url }] }] }
 *   setProjectName(name)
 *   createMilestone({date,name,team,notes}) -> milestone   (throws err.body.errors on validation failure)
 *   addMedia(milestoneId, File)
 *   deleteMilestone(id)
 *   exportBackup() / importBackup(json)   (browser mode only)
 *
 * 'server'  – the Node server (npm start): data in data/ on disk.
 * 'browser' – static hosting (GitHub Pages): data in this browser's IndexedDB.
 * Paths are relative so it works under a sub-path like /milestone-timeline/.
 */

const MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_PROJECT = 'Project Milestones';

const ascii = (u8, from, to) => String.fromCharCode(...u8.slice(from, to));
// Identify the real file type from its first bytes.
function sniff(u8) {
  if (u8.length >= 4 && ascii(u8, 0, 4) === '%PDF') return { ext: '.pdf', kind: 'pdf', mime: 'application/pdf' };
  if (u8.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => u8[i] === b)) return { ext: '.png', kind: 'image', mime: 'image/png' };
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return { ext: '.jpg', kind: 'image', mime: 'image/jpeg' };
  if (u8.length >= 4 && ascii(u8, 0, 4) === 'GIF8') return { ext: '.gif', kind: 'image', mime: 'image/gif' };
  if (u8.length >= 12 && ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 12) === 'WEBP') return { ext: '.webp', kind: 'image', mime: 'image/webp' };
  return null;
}
const NOT_ALLOWED = 'Only images (PNG, JPG, GIF, WebP) and PDFs are allowed.';

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

function validateMilestone(body) {
  const m = { date: clean(body.date, 10), name: clean(body.name, 200), team: clean(body.team, 200), notes: clean(body.notes, 10000) };
  const errors = {};
  if (!validDate(m.date)) errors.date = 'Please pick a date.';
  if (!m.name) errors.name = 'Milestone name is required.';
  if (!m.team) errors.team = 'Responsible team is required.';
  if (Object.keys(errors).length) throw Object.assign(new Error('Validation failed'), { body: { errors } });
  return m;
}

// ---------------------------------------------------------------- server
function serverStore() {
  async function call(path, opts = {}) {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error((body && body.error) || `Request failed (${res.status})`), { body });
    return body;
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    mode: 'server',
    async getState() {
      const s = await call('api/state');
      for (const m of s.milestones) for (const f of m.media) f.url = 'uploads/' + encodeURIComponent(f.file);
      return s;
    },
    setProjectName: (name) => call('api/project', json('PUT', { name })),
    createMilestone: (data) => call('api/milestones', json('POST', data)),
    addMedia: (id, file) => call(`api/milestones/${id}/media?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }),
    deleteMilestone: (id) => call('api/milestones/' + id, { method: 'DELETE' }),
  };
}

// --------------------------------------------------------------- browser
function browserStore() {
  const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('Storage write failed')); });
  let dbPromise;
  const open = () => dbPromise || (dbPromise = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('This browser does not allow local storage (private window?).'));
    const r = indexedDB.open('milestone-timeline', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('meta');
      d.createObjectStore('milestones', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (stores, mode) => (await open()).transaction(stores, mode);

  // Ask the browser not to evict our data under storage pressure.
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }

  let urls = [];
  const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

  const sniffBlob = async (blob) => sniff(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  const mediaItem = (id, type, name, size) => ({ id, file: '', originalName: clean(name, 200) || 'file', kind: type.kind, size });

  return {
    mode: 'browser',

    async getState() {
      const t = await tx(['meta', 'milestones', 'files'], 'readonly');
      const [name, milestones, files] = await Promise.all([
        p(t.objectStore('meta').get('projectName')), p(t.objectStore('milestones').getAll()), p(t.objectStore('files').getAll())]);
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
      const blobs = new Map(files.map((f) => [f.id, f.blob]));
      for (const m of milestones) {
        m.media = m.media.filter((f) => blobs.has(f.id)).map((f) => {
          const url = URL.createObjectURL(blobs.get(f.id));
          urls.push(url);
          return { ...f, url };
        });
      }
      return { projectName: name || DEFAULT_PROJECT, milestones };
    },

    async setProjectName(name) {
      const n = clean(name, 120);
      if (!n) throw new Error('Project name cannot be empty.');
      const t = await tx(['meta'], 'readwrite');
      t.objectStore('meta').put(n, 'projectName');
      await done(t);
    },

    async createMilestone(data) {
      const m = { id: newId(), ...validateMilestone(data), media: [], createdAt: new Date().toISOString() };
      const t = await tx(['milestones'], 'readwrite');
      t.objectStore('milestones').put(m);
      await done(t);
      return m;
    },

    async addMedia(id, file) {
      if (file.size === 0) throw new Error('Empty file.');
      if (file.size > MAX_BYTES) throw new Error('File is larger than 50 MB.');
      const type = await sniffBlob(file);
      if (!type) throw new Error(NOT_ALLOWED);
      const item = mediaItem(newId(), type, file.name, file.size);
      const t = await tx(['milestones', 'files'], 'readwrite');
      const m = await p(t.objectStore('milestones').get(id));
      if (!m) { t.abort(); throw new Error('Milestone not found.'); }
      m.media.push(item);
      t.objectStore('milestones').put(m);
      t.objectStore('files').put({ id: item.id, blob: new Blob([file], { type: type.mime }) });
      await done(t);
      return item;
    },

    async deleteMilestone(id) {
      const t = await tx(['milestones', 'files'], 'readwrite');
      const m = await p(t.objectStore('milestones').get(id));
      if (m) for (const f of m.media) t.objectStore('files').delete(f.id);
      t.objectStore('milestones').delete(id);
      await done(t);
    },

    async clearAll() {
      const t = await tx(['meta', 'milestones', 'files'], 'readwrite');
      for (const name of ['meta', 'milestones', 'files']) t.objectStore(name).clear();
      await done(t);
    },

    // Single JSON file containing everything (media embedded as data URLs).
    async exportBackup() {
      const t = await tx(['meta', 'milestones', 'files'], 'readonly');
      const [name, milestones, files] = await Promise.all([
        p(t.objectStore('meta').get('projectName')), p(t.objectStore('milestones').getAll()), p(t.objectStore('files').getAll())]);
      const blobs = new Map(files.map((f) => [f.id, f.blob]));
      for (const m of milestones) {
        for (const f of m.media) f.data = blobs.has(f.id) ? await blobToDataUrl(blobs.get(f.id)) : null;
        m.media = m.media.filter((f) => f.data);
      }
      const text = JSON.stringify({ app: 'milestone-timeline', version: 1, exportedAt: new Date().toISOString(), projectName: name || DEFAULT_PROJECT, milestones });
      return new Blob([text], { type: 'application/json' });
    },

    // Adds milestones that are not already present (matched by id); never deletes or overwrites.
    async importBackup(text) {
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('That file is not a valid backup.'); }
      if (!data || data.app !== 'milestone-timeline' || !Array.isArray(data.milestones)) throw new Error('That file is not a milestone-timeline backup.');

      const t0 = await tx(['meta', 'milestones'], 'readonly');
      const [existingIds, curName] = await Promise.all([p(t0.objectStore('milestones').getAllKeys()), p(t0.objectStore('meta').get('projectName'))]);
      const existing = new Set(existingIds);
      let added = 0;
      for (const src of data.milestones) {
        if (!src || typeof src.id !== 'string' || !/^[0-9a-f]{16}$/.test(src.id) || existing.has(src.id)) continue;
        let fields;
        try { fields = validateMilestone(src); } catch { continue; }
        const media = []; const blobs = [];
        for (const f of Array.isArray(src.media) ? src.media : []) {
          if (!f || typeof f.data !== 'string' || !f.data.startsWith('data:')) continue;
          const blob = await (await fetch(f.data)).blob();
          const type = await sniffBlob(blob);
          if (!type || blob.size > MAX_BYTES) continue;
          const id = /^[0-9a-f]{16}$/.test(f.id) ? f.id : newId();
          media.push(mediaItem(id, type, f.originalName, blob.size));
          blobs.push({ id, blob: new Blob([blob], { type: type.mime }) });
        }
        const t = await tx(['milestones', 'files'], 'readwrite');
        t.objectStore('milestones').put({ id: src.id, ...fields, media, createdAt: typeof src.createdAt === 'string' ? src.createdAt : new Date().toISOString() });
        for (const b of blobs) t.objectStore('files').put(b);
        await done(t);
        added++;
      }
      if (!curName && clean(data.projectName, 120)) {
        const t = await tx(['meta'], 'readwrite');
        t.objectStore('meta').put(clean(data.projectName, 120), 'projectName');
        await done(t);
      }
      return added;
    },
  };
}

async function detectStore() {
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) return serverStore();
  } catch { /* no server -> static hosting */ }
  return browserStore();
}
