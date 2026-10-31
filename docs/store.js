'use strict';
/*
 * Storage backends. The UI (app.js) only talks to this interface:
 *   mode                          'server' | 'browser'
 *   getState()                    -> { projectName, processes: [{id,name,color}],
 *                                      milestones: [{ ..., processId|null, media: [{ id, originalName, kind, size, url }] }] }
 *   setProjectName(name)
 *   createMilestone(data)         data = {date,name,team,notes,processId}; throws err.body.errors on validation failure
 *   updateMilestone(id, data)
 *   addMedia(milestoneId, File) / deleteMedia(milestoneId, mediaId)
 *   deleteMilestone(id)
 *   createProcess({name,color}) / updateProcess(id,{name,color}) / deleteProcess(id)   (deleting unassigns its milestones)
 *   exportBackup() / importBackup(text) / clearAll()     (browser mode only)
 *
 * 'server'  – the Node server (npm start): data in data/ on disk.
 * 'browser' – static hosting (GitHub Pages): data in this browser's IndexedDB.
 * Paths are relative so it works under a sub-path like /milestone-timeline/.
 */

const MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_PROJECT = 'Project Milestones';
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[0-9a-f]{16}$/;

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
const fail = (message, body) => Object.assign(new Error(message), { body: body || { error: message } });

function validateMilestone(body) {
  const m = {
    date: clean(body.date, 10), name: clean(body.name, 200), team: clean(body.team, 200), notes: clean(body.notes, 10000),
    processId: typeof body.processId === 'string' && body.processId ? body.processId : null,
  };
  const errors = {};
  if (!validDate(m.date)) errors.date = 'Please pick a date.';
  if (!m.name) errors.name = 'Milestone name is required.';
  if (!m.team) errors.team = 'Responsible team is required.';
  if (Object.keys(errors).length) throw fail('Validation failed', { errors });
  return m;
}

// Returns cleaned {name,color}; `others` are the other processes (for the unique-name check).
function validateProcess(body, others) {
  const name = clean(body.name, 60);
  const color = typeof body.color === 'string' ? body.color.trim().toLowerCase() : '';
  if (!name) throw fail('Process name is required.');
  if (!COLOR_RE.test(color)) throw fail('Please pick a colour.');
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw fail(`A process called "${name}" already exists.`);
  return { name, color };
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
      s.processes = s.processes || [];
      for (const m of s.milestones) {
        m.processId = m.processId || null;
        for (const f of m.media) f.url = 'uploads/' + encodeURIComponent(f.file);
      }
      return s;
    },
    setProjectName: (name) => call('api/project', json('PUT', { name })),
    createMilestone: (data) => call('api/milestones', json('POST', data)),
    updateMilestone: (id, data) => call('api/milestones/' + id, json('PUT', data)),
    addMedia: (id, file) => call(`api/milestones/${id}/media?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }),
    deleteMedia: (id, mediaId) => call(`api/milestones/${id}/media/${mediaId}`, { method: 'DELETE' }),
    deleteMilestone: (id) => call('api/milestones/' + id, { method: 'DELETE' }),
    createProcess: (data) => call('api/processes', json('POST', data)),
    updateProcess: (id, data) => call('api/processes/' + id, json('PUT', data)),
    deleteProcess: (id) => call('api/processes/' + id, { method: 'DELETE' }),
  };
}

// --------------------------------------------------------------- browser
function browserStore() {
  const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('Storage write failed')); });
  let dbPromise;
  const open = () => dbPromise || (dbPromise = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('This browser does not allow local storage (private window?).'));
    // Schema is unchanged since v1 on purpose: processes live in the 'meta' store, so existing data needs no migration.
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
  const getProcesses = async (metaStore) => (await p(metaStore.get('processes'))) || [];

  return {
    mode: 'browser',

    async getState() {
      const t = await tx(['meta', 'milestones', 'files'], 'readonly');
      const [name, processes, milestones, files] = await Promise.all([
        p(t.objectStore('meta').get('projectName')), getProcesses(t.objectStore('meta')),
        p(t.objectStore('milestones').getAll()), p(t.objectStore('files').getAll())]);
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
      const blobs = new Map(files.map((f) => [f.id, f.blob]));
      const known = new Set(processes.map((x) => x.id));
      for (const m of milestones) {
        m.processId = known.has(m.processId) ? m.processId : null;
        m.media = m.media.filter((f) => blobs.has(f.id)).map((f) => {
          const url = URL.createObjectURL(blobs.get(f.id));
          urls.push(url);
          return { ...f, url };
        });
      }
      return { projectName: name || DEFAULT_PROJECT, processes, milestones };
    },

    async setProjectName(name) {
      const n = clean(name, 120);
      if (!n) throw new Error('Project name cannot be empty.');
      const t = await tx(['meta'], 'readwrite');
      t.objectStore('meta').put(n, 'projectName');
      await done(t);
    },

    // ----- milestones
    async createMilestone(data) {
      const fields = validateMilestone(data);
      const t = await tx(['meta', 'milestones'], 'readwrite');
      const processes = await getProcesses(t.objectStore('meta'));
      if (fields.processId && !processes.some((x) => x.id === fields.processId)) fields.processId = null;
      const m = { id: newId(), ...fields, media: [], createdAt: new Date().toISOString() };
      t.objectStore('milestones').put(m);
      await done(t);
      return m;
    },

    async updateMilestone(id, data) {
      const fields = validateMilestone(data);
      const t = await tx(['meta', 'milestones'], 'readwrite');
      const processes = await getProcesses(t.objectStore('meta'));
      if (fields.processId && !processes.some((x) => x.id === fields.processId)) fields.processId = null;
      const m = await p(t.objectStore('milestones').get(id));
      if (!m) { t.abort(); throw new Error('Milestone not found.'); }
      Object.assign(m, fields);
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

    async deleteMedia(id, mediaId) {
      const t = await tx(['milestones', 'files'], 'readwrite');
      const m = await p(t.objectStore('milestones').get(id));
      if (!m) { t.abort(); throw new Error('Milestone not found.'); }
      m.media = m.media.filter((f) => f.id !== mediaId);
      t.objectStore('milestones').put(m);
      t.objectStore('files').delete(mediaId);
      await done(t);
    },

    async deleteMilestone(id) {
      const t = await tx(['milestones', 'files'], 'readwrite');
      const m = await p(t.objectStore('milestones').get(id));
      if (m) for (const f of m.media) t.objectStore('files').delete(f.id);
      t.objectStore('milestones').delete(id);
      await done(t);
    },

    // ----- processes
    async createProcess(data) {
      const t = await tx(['meta'], 'readwrite');
      const meta = t.objectStore('meta');
      const processes = await getProcesses(meta);
      const proc = { id: newId(), ...validateProcess(data, processes) };
      meta.put([...processes, proc], 'processes');
      await done(t);
      return proc;
    },

    async updateProcess(id, data) {
      const t = await tx(['meta'], 'readwrite');
      const meta = t.objectStore('meta');
      const processes = await getProcesses(meta);
      const cur = processes.find((x) => x.id === id);
      if (!cur) { t.abort(); throw new Error('Process not found.'); }
      Object.assign(cur, validateProcess(data, processes.filter((x) => x.id !== id)));
      meta.put(processes, 'processes');
      await done(t);
      return cur;
    },

    async deleteProcess(id) {
      const t = await tx(['meta', 'milestones'], 'readwrite');
      const meta = t.objectStore('meta'), ms = t.objectStore('milestones');
      const processes = await getProcesses(meta);
      meta.put(processes.filter((x) => x.id !== id), 'processes');
      for (const m of await p(ms.getAll())) if (m.processId === id) { m.processId = null; ms.put(m); }
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
      const [name, processes, milestones, files] = await Promise.all([
        p(t.objectStore('meta').get('projectName')), getProcesses(t.objectStore('meta')),
        p(t.objectStore('milestones').getAll()), p(t.objectStore('files').getAll())]);
      const blobs = new Map(files.map((f) => [f.id, f.blob]));
      for (const m of milestones) {
        for (const f of m.media) f.data = blobs.has(f.id) ? await blobToDataUrl(blobs.get(f.id)) : null;
        m.media = m.media.filter((f) => f.data);
      }
      const text = JSON.stringify({ app: 'milestone-timeline', version: 2, exportedAt: new Date().toISOString(), projectName: name || DEFAULT_PROJECT, processes, milestones });
      return new Blob([text], { type: 'application/json' });
    },

    // Adds processes and milestones that are not already present (matched by id); never deletes or overwrites.
    // Accepts backups from older versions (no processes).
    async importBackup(text) {
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('That file is not a valid backup.'); }
      if (!data || data.app !== 'milestone-timeline' || !Array.isArray(data.milestones)) throw new Error('That file is not a milestone-timeline backup.');

      const t0 = await tx(['meta', 'milestones'], 'readonly');
      const [existingIds, curName, curProcs] = await Promise.all([
        p(t0.objectStore('milestones').getAllKeys()), p(t0.objectStore('meta').get('projectName')), getProcesses(t0.objectStore('meta'))]);
      const existing = new Set(existingIds);

      // processes: reuse a current one with the same id or name, otherwise add
      const procs = [...curProcs]; const idMap = new Map(); let procsChanged = false;
      for (const src of Array.isArray(data.processes) ? data.processes : []) {
        if (!src || !ID_RE.test(src.id) || !COLOR_RE.test(src.color || '') || !clean(src.name, 60)) continue;
        const match = procs.find((x) => x.id === src.id) || procs.find((x) => x.name.toLowerCase() === clean(src.name, 60).toLowerCase());
        if (match) { idMap.set(src.id, match.id); continue; }
        procs.push({ id: src.id, name: clean(src.name, 60), color: src.color.toLowerCase() });
        idMap.set(src.id, src.id); procsChanged = true;
      }
      if (procsChanged) {
        const t = await tx(['meta'], 'readwrite');
        t.objectStore('meta').put(procs, 'processes');
        await done(t);
      }

      let added = 0;
      for (const src of data.milestones) {
        if (!src || typeof src.id !== 'string' || !ID_RE.test(src.id) || existing.has(src.id)) continue;
        let fields;
        try { fields = validateMilestone({ ...src, processId: idMap.get(src.processId) || null }); } catch { continue; }
        const media = []; const blobs = [];
        for (const f of Array.isArray(src.media) ? src.media : []) {
          if (!f || typeof f.data !== 'string' || !f.data.startsWith('data:')) continue;
          const blob = await (await fetch(f.data)).blob();
          const type = await sniffBlob(blob);
          if (!type || blob.size > MAX_BYTES) continue;
          const id = ID_RE.test(f.id) ? f.id : newId();
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
