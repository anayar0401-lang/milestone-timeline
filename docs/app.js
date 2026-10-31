'use strict';

const $ = (id) => document.getElementById(id);
// MAX_BYTES comes from store.js
const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

const state = { projectName: '', milestones: [], newestFirst: false, open: new Set(), pending: [] };

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (s, opts) => new Intl.DateTimeFormat(undefined, opts).format(parseDate(s));
const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

let store; // chosen at boot: server (npm start) or this browser's storage (static hosting)

function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = !msg; }

async function load() {
  try {
    const s = await store.getState();
    state.projectName = s.projectName;
    state.milestones = s.milestones;
    showBanner('');
  } catch (e) {
    showBanner('Could not load your milestones: ' + e.message);
  }
  $('projectName').textContent = state.projectName || 'Project Milestones';
  document.title = `${state.projectName || 'Milestone Timeline'} · Milestones`;
  $('count').textContent = state.milestones.length;
}

// ---------- routing ----------
function route() {
  const view = location.hash === '#/add' ? 'add' : 'timeline';
  for (const v of ['add', 'next', 'timeline']) $('view-' + v).hidden = true;
  $('view-' + (view === 'add' && state.showNext ? 'next' : view)).hidden = false;
  $('tab-timeline').classList.toggle('active', view === 'timeline');
  $('tab-add').classList.toggle('active', view === 'add');
  if (view === 'timeline') { state.showNext = false; renderTimeline(); }
  if (view === 'add' && !state.showNext) setTimeout(() => $('date').focus(), 0);
}
window.addEventListener('hashchange', route);

// ---------- project name ----------
function editProjectName() {
  const h1 = $('projectName');
  const input = el('input', { type: 'text', maxlength: 120, 'aria-label': 'Project name' });
  input.value = state.projectName;
  h1.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const v = input.value.trim();
    input.replaceWith(h1);
    if (commit && v && v !== state.projectName) {
      try { await store.setProjectName(v); await load(); }
      catch (e) { showBanner(e.message); }
    }
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
}
$('projectName').addEventListener('click', editProjectName);
$('projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') editProjectName(); });

// ---------- add form: media picker ----------
const dz = $('dropzone'), fileInput = $('files');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

function addFiles(list) {
  for (const f of list) {
    let problem = '';
    if (!ALLOWED.test(f.type)) problem = 'Unsupported type — images or PDF only';
    else if (f.size > MAX_BYTES) problem = 'Larger than 50 MB';
    state.pending.push({ file: f, problem, url: f.type.startsWith('image/') && !problem ? URL.createObjectURL(f) : null });
  }
  renderPending();
}

function renderPending() {
  const ul = $('pending');
  ul.replaceChildren(...state.pending.map((p, i) => {
    const thumb = p.url ? el('img', { class: 'thumb', src: p.url, alt: '' })
      : el('div', { class: 'thumb', text: p.problem ? '!' : 'PDF' });
    return el('li', { class: p.problem ? 'bad' : '' },
      thumb,
      el('div', { class: 'meta' },
        el('div', { class: 'fname', text: p.file.name }),
        el('div', { class: 'small muted', text: p.problem || fmtSize(p.file.size) })),
      el('button', { type: 'button', class: 'rm', 'aria-label': `Remove ${p.file.name}`, text: '×',
        onclick: () => { if (p.url) URL.revokeObjectURL(p.url); state.pending.splice(i, 1); renderPending(); } }));
  }));
}

// ---------- add form: submit ----------
function setError(field, msg) {
  const wrap = document.querySelector(`[data-field="${field}"]`);
  wrap.classList.toggle('invalid', !!msg);
  const p = $('err-' + field); p.textContent = msg || ''; p.hidden = !msg;
}

for (const f of ['date', 'name', 'team']) $(f).addEventListener('input', () => setError(f, ''));

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { date: $('date').value, name: $('name').value.trim(), team: $('team').value.trim(), notes: $('notes').value.trim() };
  setError('date', data.date ? '' : 'Please pick a date.');
  setError('name', data.name ? '' : 'Milestone name is required.');
  setError('team', data.team ? '' : 'Responsible team is required.');
  const firstBad = ['date', 'name', 'team'].find((k) => !data[k]);
  if (firstBad) { $(firstBad).focus(); return; }

  const files = state.pending.filter((p) => !p.problem);
  const skipped = state.pending.length - files.length;
  const btn = $('save'); btn.disabled = true;
  const failed = [];
  try {
    const m = await store.createMilestone(data);
    for (let i = 0; i < files.length; i++) {
      $('progress').textContent = `Saving file ${i + 1} of ${files.length}…`;
      try { await store.addMedia(m.id, files[i].file); }
      catch (err) { failed.push(`${files[i].file.name} (${err.message})`); }
    }
    $('progress').textContent = '';
    await load();
    showNext(m, data, failed, skipped);
  } catch (err) {
    $('progress').textContent = '';
    if (err.body && err.body.errors) for (const [k, v] of Object.entries(err.body.errors)) setError(k, v);
    else showBanner(err.message);
  } finally { btn.disabled = false; }
});

function resetForm() {
  $('form').reset();
  state.pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  state.pending = [];
  renderPending();
  for (const f of ['date', 'name', 'team']) setError(f, '');
}

function showNext(m, data, failed, skipped) {
  state.showNext = true;
  resetForm();
  const n = state.milestones.find((x) => x.id === m.id)?.media.length || 0;
  $('next-summary').textContent = `“${data.name}” on ${fmt(data.date, { dateStyle: 'long' })} · ${data.team}` + (n ? ` · ${n} file${n > 1 ? 's' : ''} attached` : '');
  const warn = $('next-warn');
  const msgs = [];
  if (failed.length) msgs.push(`These files could not be uploaded: ${failed.join('; ')}.`);
  if (skipped) msgs.push(`${skipped} unsupported file${skipped > 1 ? 's were' : ' was'} skipped.`);
  warn.textContent = msgs.join(' '); warn.hidden = !msgs.length;
  if (location.hash !== '#/add') location.hash = '#/add'; else route();
  $('btn-another').focus();
}

$('btn-another').addEventListener('click', () => { state.showNext = false; route(); });

// ---------- timeline ----------
function renderTimeline() {
  const list = [...state.milestones].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  if (state.newestFirst) list.reverse();
  $('empty').hidden = list.length > 0;
  $('timeline').hidden = list.length === 0;
  $('btn-sort').hidden = $('btn-toggle').hidden = list.length === 0;
  $('btn-sort').textContent = state.newestFirst ? 'Newest first' : 'Oldest first';
  const allOpen = list.length > 0 && list.every((m) => state.open.has(m.id));
  $('btn-toggle').textContent = allOpen ? 'Collapse all' : 'Expand all';
  const dates = list.map((m) => m.date).sort();
  const monthYear = { month: 'short', year: 'numeric' };
  $('summary').textContent = list.length
    ? `${list.length} milestone${list.length > 1 ? 's' : ''} · ${fmt(dates[0], monthYear)} → ${fmt(dates.at(-1), monthYear)}`
    : '';
  $('timeline').replaceChildren(...list.map(entryNode));
}

function entryNode(m) {
  const open = state.open.has(m.id);
  const panelId = 'p-' + m.id;
  const li = el('li', { class: 'entry' + (open ? ' open' : '') });

  const btn = el('button', { class: 'datebtn', type: 'button', 'aria-expanded': String(open), 'aria-controls': panelId,
    'aria-label': `${fmt(m.date, { dateStyle: 'full' })}. ${open ? 'Collapse' : 'Expand'} details` },
    el('span', { class: 'mon', text: fmt(m.date, { month: 'short' }) }),
    el('span', { class: 'day', text: fmt(m.date, { day: 'numeric' }) }),
    el('span', { class: 'yr', text: fmt(m.date, { year: 'numeric' }) }));
  const toggle = () => {
    state.open.has(m.id) ? state.open.delete(m.id) : state.open.add(m.id);
    renderTimeline();
    document.querySelector(`#timeline [aria-controls="${panelId}"]`)?.focus();
  };
  btn.addEventListener('click', toggle);

  const hint = el('div', { class: 'hint', onclick: toggle },
    el('span', { class: 'full', text: fmt(m.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) }),
    m.media.length ? el('span', { class: 'chip', text: `📎 ${m.media.length}` }) : null,
    open ? null : el('span', { text: 'Click the date to see details' }));

  const dl = el('dl', { class: 'details' },
    kv('Milestone name', m.name, 'big'),
    kv('Responsible team', m.team),
    kv('Notes', m.notes, m.notes ? '' : 'none', 'No notes added'));
  if (m.media.length) {
    dl.append(el('div', { class: 'kv' }, el('dt', { text: 'Media' }),
      el('div', { class: 'media' }, ...m.media.map((f) => mediaNode(f)))));
  }
  dl.append(el('div', { class: 'entry-actions' },
    el('button', { class: 'btn small danger', type: 'button', text: 'Delete milestone', onclick: async () => {
      if (!confirm(`Delete "${m.name}" (${fmt(m.date, { dateStyle: 'medium' })}) and its media? This cannot be undone.`)) return;
      try { await store.deleteMilestone(m.id); state.open.delete(m.id); await load(); renderTimeline(); }
      catch (e) { showBanner(e.message); }
    } })));

  li.append(btn, el('div', { class: 'dot' }), el('div', { class: 'panel', id: panelId }, hint, dl));
  return li;
}

function kv(label, value, cls = '', fallback = '') {
  return el('div', { class: 'kv' }, el('dt', { text: label }), el('dd', { class: cls, text: value || fallback }));
}

function mediaNode(f) {
  const url = f.url;
  const inner = f.kind === 'image'
    ? el('img', { src: url, alt: f.originalName, loading: 'lazy' })
    : el('div', { class: 'pdf' }, el('b', { text: 'PDF' }), el('span', { text: f.originalName }));
  return el('button', { type: 'button', title: `${f.originalName} (${fmtSize(f.size)})`, onclick: () => openLightbox(f, url) }, inner);
}

$('btn-sort').addEventListener('click', () => { state.newestFirst = !state.newestFirst; renderTimeline(); });
$('btn-toggle').addEventListener('click', () => {
  const allOpen = state.milestones.every((m) => state.open.has(m.id));
  state.open = allOpen ? new Set() : new Set(state.milestones.map((m) => m.id));
  renderTimeline();
});

// ---------- lightbox ----------
const lb = $('lightbox');
function openLightbox(f, url) {
  $('lb-body').replaceChildren(f.kind === 'image'
    ? el('img', { src: url, alt: f.originalName })
    : el('iframe', { src: url, title: f.originalName }));
  $('lb-name').textContent = f.originalName;
  $('lb-open').href = url;
  lb.showModal();
}
$('lb-close').addEventListener('click', () => lb.close());
lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
lb.addEventListener('close', () => $('lb-body').replaceChildren());

// ---------- backup / restore (browser storage only) ----------
$('btn-export').addEventListener('click', async () => {
  try {
    const blob = await store.exportBackup();
    const a = el('a', { href: URL.createObjectURL(blob), download: `milestones-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { showBanner('Backup failed: ' + e.message); }
});
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const added = await store.importBackup(await file.text());
    await load(); route();
    alert(added ? `Restored ${added} milestone${added > 1 ? 's' : ''} from the backup.` : 'Nothing new to restore — those milestones are already here.');
  } catch (err) { showBanner(err.message); }
});

// ---------- boot ----------
detectStore().then((s) => {
  store = s;
  $('foot').hidden = store.mode !== 'browser';
  return load();
}).then(() => {
  // First visit with no data goes straight to the add form.
  if (!location.hash) location.hash = state.milestones.length ? '#/timeline' : '#/add';
  else route();
});
