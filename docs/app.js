'use strict';

const $ = (id) => document.getElementById(id);
// MAX_BYTES comes from store.js
const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
const PALETTE = ['#4f46e5', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
const UNASSIGNED = '#9aa3b8';

let store; // chosen at boot: server (npm start) or this browser's storage (static hosting)

const state = {
  projectName: '', processes: [], milestones: [],
  newestFirst: false, open: new Set(), pending: [],
  groupBy: lsGet('mt.groupBy') === 'process', filter: 'all', // 'all' | 'none' | <processId>
  editing: null, // { id, removed:Set, media:[] } while editing an existing milestone
  lastProcess: '', showNext: false,
};

// ---------- helpers ----------
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const inkFor = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#111827' : '#ffffff'; };
const procById = (id) => state.processes.find((p) => p.id === id) || null;
// Colour of a milestone: its process colour; grey when processes exist but it has none; default accent when no processes are set up at all.
const colorOf = (m) => (procById(m.processId) || {}).color || (state.processes.length ? UNASSIGNED : null);
function colorVars(node, color) {
  if (!color) return;
  node.style.setProperty('--pc', color);
  node.style.setProperty('--pc-ink', inkFor(color));
}

function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = !msg; }

async function load() {
  try {
    const s = await store.getState();
    state.projectName = s.projectName;
    state.processes = s.processes;
    state.milestones = s.milestones;
    if (state.filter !== 'all' && state.filter !== 'none' && !procById(state.filter)) state.filter = 'all';
    showBanner('');
  } catch (e) {
    showBanner('Could not load your milestones: ' + e.message);
  }
  $('projectName').textContent = state.projectName || 'Project Milestones';
  document.title = `${state.projectName || 'Milestone Timeline'} · Milestones`;
  $('count').textContent = state.milestones.length;
  renderProcessSelect();
  if (state.editing) renderExisting(); // image URLs are re-issued on every load
}

// ---------- routing ----------
function route() {
  const edit = location.hash.match(/^#\/edit\/([0-9a-f]+)$/);
  const view = edit || location.hash === '#/add' ? 'add' : 'timeline';
  if (edit) startEdit(edit[1]);
  else if (state.editing) endEdit();
  const editing = !!state.editing;
  for (const v of ['add', 'next', 'timeline']) $('view-' + v).hidden = true;
  $('view-' + (view === 'add' && state.showNext && !editing ? 'next' : view)).hidden = false;
  $('tab-timeline').classList.toggle('active', view === 'timeline');
  $('tab-add').classList.toggle('active', view === 'add' && !editing);
  if (view === 'timeline') { state.showNext = false; renderTimeline(); }
  if (view === 'add' && !state.showNext) setTimeout(() => $(editing ? 'name' : 'date').focus(), 0);
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

// ---------- add / edit form: media picker ----------
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

// Files already attached to the milestone being edited; removal is applied on save.
function renderExisting() {
  const ul = $('existing');
  const e = state.editing;
  const media = e ? (state.milestones.find((x) => x.id === e.id)?.media || []) : [];
  ul.hidden = !media.length;
  ul.replaceChildren(...media.map((f) => {
    const gone = e.removed.has(f.id);
    const thumb = f.kind === 'image' ? el('img', { class: 'thumb', src: f.url, alt: '' }) : el('div', { class: 'thumb', text: 'PDF' });
    return el('li', { class: gone ? 'removed' : '' },
      thumb,
      el('div', { class: 'meta' },
        el('div', { class: 'fname', text: f.originalName }),
        el('div', { class: 'small muted', text: gone ? 'Will be removed when you save' : `Attached · ${fmtSize(f.size)}` })),
      gone
        ? el('button', { type: 'button', class: 'undo', text: 'Undo', onclick: () => { e.removed.delete(f.id); renderExisting(); } })
        : el('button', { type: 'button', class: 'rm', 'aria-label': `Remove ${f.originalName}`, text: '×', onclick: () => { e.removed.add(f.id); renderExisting(); } }));
  }));
}

// ---------- add / edit form: fields ----------
function setError(field, msg) {
  const wrap = document.querySelector(`[data-field="${field}"]`);
  wrap.classList.toggle('invalid', !!msg);
  const p = $('err-' + field); p.textContent = msg || ''; p.hidden = !msg;
}
for (const f of ['date', 'name', 'team']) $(f).addEventListener('input', () => setError(f, ''));

function renderProcessSelect() {
  const sel = $('process');
  const keep = sel.value;
  sel.replaceChildren(el('option', { value: '', text: state.processes.length ? 'No process' : 'No process (none set up yet)' }),
    ...state.processes.map((p) => el('option', { value: p.id, text: p.name })));
  sel.value = procById(keep) ? keep : '';
}

function setFormMode() {
  const e = !!state.editing;
  $('formTitle').textContent = e ? 'Edit milestone' : 'Add a milestone';
  $('formLead').textContent = e ? 'Change anything below — including the process and its colour — then save.' : 'Pick the date, attach any supporting media, then describe what happened.';
  $('save').textContent = e ? 'Save changes' : 'Save milestone';
  $('cancel-edit').hidden = !e;
}

function resetForm() {
  $('form').reset();
  state.pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  state.pending = [];
  renderPending();
  renderExisting();
  for (const f of ['date', 'name', 'team']) setError(f, '');
  $('progress').textContent = '';
}

function startEdit(id) {
  if (state.editing && state.editing.id === id) return;
  const m = state.milestones.find((x) => x.id === id);
  if (!m) { location.hash = '#/timeline'; return; }
  resetForm();
  state.showNext = false;
  state.editing = { id, removed: new Set() };
  $('date').value = m.date; $('name').value = m.name; $('team').value = m.team; $('notes').value = m.notes;
  renderProcessSelect(); $('process').value = m.processId || '';
  renderExisting(); setFormMode();
}
function endEdit() { state.editing = null; resetForm(); setFormMode(); }

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { date: $('date').value, name: $('name').value.trim(), team: $('team').value.trim(), notes: $('notes').value.trim(), processId: $('process').value || null };
  setError('date', data.date ? '' : 'Please pick a date.');
  setError('name', data.name ? '' : 'Milestone name is required.');
  setError('team', data.team ? '' : 'Responsible team is required.');
  const firstBad = ['date', 'name', 'team'].find((k) => !data[k]);
  if (firstBad) { $(firstBad).focus(); return; }

  const editing = state.editing;
  const files = state.pending.filter((p) => !p.problem);
  const skipped = state.pending.length - files.length;
  const btn = $('save'); btn.disabled = true;
  const failed = [];
  try {
    let m;
    if (editing) {
      m = await store.updateMilestone(editing.id, data);
      for (const mediaId of editing.removed) await store.deleteMedia(editing.id, mediaId);
    } else {
      m = await store.createMilestone(data);
    }
    for (let i = 0; i < files.length; i++) {
      $('progress').textContent = `Saving file ${i + 1} of ${files.length}…`;
      try { await store.addMedia(m.id, files[i].file); }
      catch (err) { failed.push(`${files[i].file.name} (${err.message})`); }
    }
    $('progress').textContent = '';
    await load();
    if (editing) {
      state.open.add(m.id);
      state.editing = null; resetForm(); setFormMode();
      location.hash = '#/timeline'; route();
      if (failed.length) showBanner(`Saved, but these files could not be added: ${failed.join('; ')}.`);
      document.querySelector(`#timeline [aria-controls="p-${m.id}"]`)?.scrollIntoView({ block: 'center' });
    } else {
      state.lastProcess = data.processId || '';
      showNext(m, data, failed, skipped);
    }
  } catch (err) {
    $('progress').textContent = '';
    if (err.body && err.body.errors) for (const [k, v] of Object.entries(err.body.errors)) setError(k, v);
    else showBanner(err.message);
  } finally { btn.disabled = false; }
});

function showNext(m, data, failed, skipped) {
  state.showNext = true;
  resetForm();
  const n = state.milestones.find((x) => x.id === m.id)?.media.length || 0;
  const proc = procById(data.processId);
  $('next-summary').textContent = `“${data.name}” on ${fmt(data.date, { dateStyle: 'long' })} · ${data.team}` + (proc ? ` · ${proc.name}` : '') + (n ? ` · ${plural(n, 'file')} attached` : '');
  const warn = $('next-warn');
  const msgs = [];
  if (failed.length) msgs.push(`These files could not be uploaded: ${failed.join('; ')}.`);
  if (skipped) msgs.push(`${skipped} unsupported file${skipped > 1 ? 's were' : ' was'} skipped.`);
  warn.textContent = msgs.join(' '); warn.hidden = !msgs.length;
  if (location.hash !== '#/add') location.hash = '#/add'; else route();
  $('btn-another').focus();
}

$('btn-another').addEventListener('click', () => {
  state.showNext = false; route();
  $('process').value = procById(state.lastProcess) ? state.lastProcess : ''; // same process is usually next
});

// ---------- timeline ----------
function visibleMilestones() {
  let list = state.milestones;
  if (state.filter === 'none') list = list.filter((m) => !procById(m.processId));
  else if (state.filter !== 'all') list = list.filter((m) => m.processId === state.filter);
  list = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  return state.newestFirst ? list.reverse() : list;
}

function renderFilters() {
  const hasProcs = state.processes.length > 0;
  $('filters').hidden = !hasProcs || !state.milestones.length;
  $('seg-chrono').setAttribute('aria-pressed', String(!state.groupBy));
  $('seg-process').setAttribute('aria-pressed', String(state.groupBy));
  const unassigned = state.milestones.filter((m) => !procById(m.processId)).length;
  const chip = (key, label, color, n) => {
    const b = el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(state.filter === key),
      onclick: () => { state.filter = key; renderTimeline(); } },
      color ? el('span', { class: 'swatch' }) : null, el('span', { text: label }), el('span', { class: 'n', text: String(n) }));
    colorVars(b, color);
    return b;
  };
  const chips = [
    chip('all', 'All', null, state.milestones.length),
    ...state.processes.map((p) => chip(p.id, p.name, p.color, state.milestones.filter((m) => m.processId === p.id).length)),
  ];
  if (unassigned) chips.push(chip('none', 'No process', UNASSIGNED, unassigned)); // (replaceChildren would print a literal "null")
  $('chips').replaceChildren(...chips);
}

function renderTimeline() {
  renderFilters();
  const list = visibleMilestones();
  const total = state.milestones.length;
  $('empty').hidden = total > 0;
  $('nomatch').hidden = !(total > 0 && list.length === 0);
  $('timeline').hidden = list.length === 0;
  $('btn-sort').hidden = $('btn-toggle').hidden = list.length === 0;
  $('btn-sort').textContent = state.newestFirst ? 'Newest first' : 'Oldest first';
  const allOpen = list.length > 0 && list.every((m) => state.open.has(m.id));
  $('btn-toggle').textContent = allOpen ? 'Collapse all' : 'Expand all';
  const dates = list.map((m) => m.date).sort();
  const monthYear = { month: 'short', year: 'numeric' };
  $('summary').textContent = list.length
    ? `${list.length === total ? plural(total, 'milestone') : `${list.length} of ${total} milestones`} · ${fmt(dates[0], monthYear)} → ${fmt(dates.at(-1), monthYear)}`
    : '';

  const grouped = state.groupBy && state.processes.length > 0;
  if (!grouped) {
    $('timeline').replaceChildren(el('ol', { class: 'timeline' }, ...list.map(entryNode)));
    return;
  }
  const groups = [...state.processes.map((p) => ({ key: p.id, name: p.name, color: p.color })), { key: null, name: 'No process', color: UNASSIGNED }]
    .map((g) => ({ ...g, items: list.filter((m) => (procById(m.processId) ? m.processId : null) === g.key) }))
    .filter((g) => g.items.length);
  $('timeline').replaceChildren(...groups.map((g) => {
    const head = el('h3', { class: 'group-head' }, el('span', { class: 'swatch' }), el('span', { text: g.name }), el('span', { class: 'n', text: plural(g.items.length, 'milestone') }));
    const sec = el('section', { class: 'group' }, head, el('ol', { class: 'timeline' }, ...g.items.map(entryNode)));
    colorVars(sec, g.color);
    return sec;
  }));
}

function entryNode(m) {
  const open = state.open.has(m.id);
  const panelId = 'p-' + m.id;
  const proc = procById(m.processId);
  const li = el('li', { class: 'entry' + (open ? ' open' : '') });
  colorVars(li, colorOf(m));

  const btn = el('button', { class: 'datebtn', type: 'button', 'aria-expanded': String(open), 'aria-controls': panelId,
    title: fmt(m.date, { dateStyle: 'full' }), // weekday on hover
    'aria-label': `${fmt(m.date, { dateStyle: 'full' })}, ${m.name}${proc ? `, ${proc.name}` : ''}. ${open ? 'Collapse' : 'Expand'} details` },
    el('span', { class: 'mon', text: fmt(m.date, { month: 'short' }) }),
    el('span', { class: 'day', text: fmt(m.date, { day: 'numeric' }) }),
    el('span', { class: 'yr', text: fmt(m.date, { year: 'numeric' }) }));
  const toggle = () => {
    state.open.has(m.id) ? state.open.delete(m.id) : state.open.add(m.id);
    renderTimeline();
    document.querySelector(`#timeline [aria-controls="${panelId}"]`)?.focus();
  };
  btn.addEventListener('click', toggle);

  // The date badge already shows the date, so the card header uses the space for the title and a notes preview.
  // Collapsed: full title + one-line notes preview (if any) + "Expand ↓". Expanded: tags + "Collapse ↑".
  const cue = el('span', { class: 'expand', text: open ? 'Collapse' : 'Expand' });
  cue.insertAdjacentHTML('beforeend', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${open ? '6 15 12 9 18 15' : '6 9 12 15 18 9'}"/></svg>`);
  const notesPreview = m.notes.replace(/\s+/g, ' ').slice(0, 200);
  const hint = el('div', { class: 'hint', onclick: toggle },
    el('div', { class: 'hint-main' },
      open ? null : el('div', { class: 'hint-title', text: m.name }),
      open || !notesPreview ? null : el('div', { class: 'hint-notes', text: notesPreview })),
    el('div', { class: 'hint-side' },
      proc ? el('span', { class: 'pill', title: proc.name }, el('span', { class: 'pill-text', text: proc.name })) : null,
      m.media.length ? el('span', { class: 'chip', text: `📎 ${m.media.length}` }) : null,
      cue));

  // quick process assignment, saved immediately
  const procSelect = el('select', { 'aria-label': 'Process', onchange: async (e) => {
    try {
      await store.updateMilestone(m.id, { date: m.date, name: m.name, team: m.team, notes: m.notes, processId: e.target.value || null });
      await load(); renderTimeline();
      document.querySelector(`#timeline [aria-controls="${panelId}"]`)?.focus();
    } catch (err) { showBanner(err.message); }
  } }, el('option', { value: '', text: 'No process' }), ...state.processes.map((p) => el('option', { value: p.id, text: p.name })));
  procSelect.value = proc ? proc.id : '';

  const dl = el('dl', { class: 'details' },
    kv('Milestone name', m.name, 'big'),
    kv('Responsible team', m.team),
    el('div', { class: 'kv' }, el('dt', { text: 'Process' }), el('dd', {}, state.processes.length ? procSelect : el('span', { class: 'none', text: 'None — set up processes with the “Processes & colours” button' }))),
    kv('Notes', m.notes, m.notes ? '' : 'none', 'No notes added'));
  if (m.media.length) {
    dl.append(el('div', { class: 'kv' }, el('dt', { text: 'Media' }),
      el('div', { class: 'media' }, ...m.media.map((f) => mediaNode(f)))));
  }
  dl.append(el('div', { class: 'entry-actions' },
    el('a', { class: 'btn small', href: '#/edit/' + m.id, text: 'Edit' }),
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
  const list = visibleMilestones();
  const allOpen = list.every((m) => state.open.has(m.id));
  for (const m of list) allOpen ? state.open.delete(m.id) : state.open.add(m.id);
  renderTimeline();
});
$('seg-chrono').addEventListener('click', () => { state.groupBy = false; lsSet('mt.groupBy', 'chrono'); renderTimeline(); });
$('seg-process').addEventListener('click', () => { state.groupBy = true; lsSet('mt.groupBy', 'process'); renderTimeline(); });

// ---------- processes & colours dialog ----------
const procDlg = $('procdlg');
function openProcesses() { renderProcDialog(); procDlg.showModal(); }
$('btn-processes').addEventListener('click', openProcesses);
$('btn-manage').addEventListener('click', openProcesses);
$('proc-close').addEventListener('click', () => procDlg.close());
procDlg.addEventListener('click', (e) => { if (e.target === procDlg) procDlg.close(); });
procDlg.addEventListener('close', () => { if (!$('view-timeline').hidden) renderTimeline(); });

function procError(msg) { const p = $('proc-error'); p.textContent = msg || ''; p.hidden = !msg; }

// After any change: reload, then refresh everything that shows processes.
async function procChanged() {
  await load();
  renderProcDialog();
  if (!$('view-timeline').hidden) renderTimeline();
}
async function procAction(fn) {
  procError('');
  try { await fn(); await procChanged(); return true; }
  catch (e) { procError(e.message); await procChanged(); return false; }
}

function renderProcDialog() {
  const list = $('proc-list');
  if (!state.processes.length) {
    list.replaceChildren(el('li', { class: 'proc-empty', text: 'No processes yet — add your first one below.' }));
  } else {
    list.replaceChildren(...state.processes.map((p) => {
      const n = state.milestones.filter((m) => m.processId === p.id).length;
      const color = el('input', { type: 'color', value: p.color, 'aria-label': `Colour for ${p.name}` });
      const name = el('input', { type: 'text', value: p.name, maxlength: 60, 'aria-label': 'Process name' });
      color.addEventListener('change', () => procAction(() => store.updateProcess(p.id, { name: p.name, color: color.value })));
      name.addEventListener('change', () => procAction(() => store.updateProcess(p.id, { name: name.value, color: p.color })));
      return el('li', {}, color, name, el('span', { class: 'meta', text: plural(n, 'milestone') }),
        el('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: () => {
          if (!confirm(`Delete the process "${p.name}"?\n\n${n ? `Its ${plural(n, 'milestone')} will be kept but become "No process".` : 'No milestones use it.'}`)) return;
          procAction(() => store.deleteProcess(p.id));
        } }));
    }));
  }
  // suggest the first palette colour not already used
  const used = new Set(state.processes.map((p) => p.color));
  if (!$('proc-form').dataset.touched) $('proc-color').value = PALETTE.find((c) => !used.has(c)) || PALETTE[0];
  renderSwatches();
}

function renderSwatches() {
  const cur = $('proc-color').value.toLowerCase();
  $('swatches').replaceChildren(...PALETTE.map((c) => el('button', { type: 'button', style: `--c:${c}`, title: c, 'aria-label': `Use colour ${c}`,
    'aria-pressed': String(c === cur), onclick: () => { $('proc-color').value = c; $('proc-form').dataset.touched = '1'; renderSwatches(); } })));
}
$('proc-color').addEventListener('input', () => { $('proc-form').dataset.touched = '1'; renderSwatches(); });

$('proc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await procAction(() => store.createProcess({ name: $('proc-name').value, color: $('proc-color').value }));
  if (ok) {
    $('proc-name').value = ''; delete $('proc-form').dataset.touched; renderProcDialog();
    // a process created from the form screen becomes the selection
    if (!$('view-add').hidden && !$('process').value) $('process').value = state.processes.at(-1).id;
    $('proc-name').focus();
  }
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

// ---------- backup / restore / clear (browser storage only) ----------
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
    alert(added ? `Restored ${plural(added, 'milestone')} from the backup.` : 'Nothing new to restore — those milestones are already here.');
  } catch (err) { showBanner(err.message); }
});

$('btn-clear').addEventListener('click', async () => {
  const n = state.milestones.length;
  const answer = prompt(`This permanently deletes all ${plural(n, 'milestone')}, all processes and their files from this browser.\n\nTip: use "Download backup" first if you might want them back.\n\nType CLEAR to confirm.`);
  if (answer === null) return;
  if (answer.trim() !== 'CLEAR') { alert('Nothing was deleted — you need to type CLEAR exactly.'); return; }
  try {
    await store.clearAll();
    state.open = new Set(); state.filter = 'all';
    await load();
    location.hash = '#/add'; route();
  } catch (e) { showBanner('Could not clear data: ' + e.message); }
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
