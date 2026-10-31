'use strict';
// API smoke test: spins up the server on a throwaway data dir and checks validation, uploads and persistence.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'milestones-test-'));
const base = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

function start() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => p.stdout.on('data', (d) => d.toString().includes('running') && res(p)));
}
const json = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
const upload = (id, name, buf) => fetch(`${base}/api/milestones/${id}/media?filename=${encodeURIComponent(name)}`, { method: 'POST', body: buf });

(async () => {
  let srv = await start();
  try {
    // validation
    let r = await json('POST', '/api/milestones', { date: '2026-02-30', name: ' ', team: '' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(Object.keys((await r.json()).errors).sort(), ['date', 'name', 'team']);
    r = await json('POST', '/api/milestones', { date: '2026-03-01', name: 'Kickoff', team: '' });
    assert.strictEqual(r.status, 400);

    // create (notes optional) + uploads
    r = await json('POST', '/api/milestones', { date: '2026-03-01', name: 'Kickoff', team: 'PMO' });
    assert.strictEqual(r.status, 201);
    const m = await r.json();
    assert.strictEqual((await upload(m.id, 'plan.png', PNG)).status, 201);
    assert.strictEqual((await upload(m.id, 'spec.pdf', PDF)).status, 201);
    assert.strictEqual((await upload(m.id, 'evil.png', Buffer.from('<script>alert(1)</script>'))).status, 415);
    assert.strictEqual((await upload('nope', 'a.png', PNG)).status, 404);

    // served with the right type
    let state = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(state.milestones[0].media.length, 2);
    const png = await fetch(`${base}/uploads/${state.milestones[0].media[0].file}`);
    assert.strictEqual(png.headers.get('content-type'), 'image/png');

    // path traversal blocked
    assert.notStrictEqual((await fetch(`${base}/uploads/..%2Fmilestones.json`)).status, 200);
    assert.notStrictEqual((await fetch(`${base}/..%2Fserver.js`)).status, 200);

    // persistence across restart
    srv.kill('SIGTERM'); await new Promise((r2) => srv.on('exit', r2));
    srv = await start();
    state = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(state.milestones.length, 1);
    assert.strictEqual(state.milestones[0].name, 'Kickoff');
    assert.strictEqual(state.milestones[0].media.length, 2);

    // processes: validation, create, duplicate, assign, update
    r = await json('POST', '/api/processes', { name: '', color: '#ff0000' }); assert.strictEqual(r.status, 400);
    r = await json('POST', '/api/processes', { name: 'Design', color: 'red' }); assert.strictEqual(r.status, 400);
    r = await json('POST', '/api/processes', { name: 'Design', color: '#4F46E5' }); assert.strictEqual(r.status, 201);
    const proc = await r.json();
    assert.strictEqual(proc.color, '#4f46e5');
    r = await json('POST', '/api/processes', { name: ' design ', color: '#00ff00' }); assert.strictEqual(r.status, 400, 'duplicate name (case-insensitive)');
    r = await json('PUT', `/api/milestones/${m.id}`, { date: '2026-03-02', name: 'Kickoff v2', team: 'PMO', notes: 'edited', processId: proc.id });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ...m, date: '2026-03-02', name: 'Kickoff v2', notes: 'edited', processId: proc.id, media: (await (await fetch(base + '/api/state')).json()).milestones[0].media });
    r = await json('PUT', `/api/milestones/${m.id}`, { date: '2026-03-02', name: 'Kickoff v2', team: 'PMO', processId: 'bogus' });
    assert.strictEqual((await r.json()).processId, null, 'unknown process id is treated as none');
    assert.strictEqual((await json('PUT', `/api/milestones/${m.id}`, { date: '2026-03-02', name: '', team: 'PMO' })).status, 400);
    await json('PUT', `/api/milestones/${m.id}`, { date: '2026-03-02', name: 'Kickoff v2', team: 'PMO', processId: proc.id });
    r = await json('PUT', `/api/processes/${proc.id}`, { name: 'Design & Build', color: '#14b8a6' }); assert.strictEqual(r.status, 200);

    // remove one attachment
    state = await (await fetch(base + '/api/state')).json();
    const [pngItem, pdfItem] = state.milestones[0].media;
    assert.strictEqual((await fetch(`${base}/api/milestones/${m.id}/media/${pdfItem.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'uploads', pdfItem.file)), 'removed attachment file deleted from disk');
    assert.strictEqual((await fetch(`${base}/api/milestones/${m.id}/media/${pdfItem.id}`, { method: 'DELETE' })).status, 404);

    // persistence of processes across restart
    srv.kill('SIGTERM'); await new Promise((r2) => srv.on('exit', r2));
    srv = await start();
    state = await (await fetch(base + '/api/state')).json();
    assert.deepStrictEqual(state.processes, [{ id: proc.id, name: 'Design & Build', color: '#14b8a6' }]);
    assert.strictEqual(state.milestones[0].processId, proc.id);
    assert.strictEqual(state.milestones[0].media.length, 1);

    // deleting a process keeps its milestones, unassigned
    assert.strictEqual((await json('DELETE', `/api/processes/${proc.id}`)).status, 200);
    state = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(state.milestones.length, 1);
    assert.strictEqual(state.milestones[0].processId, null);
    assert.strictEqual(state.processes.length, 0);

    // delete removes files
    const files = state.milestones[0].media.map((f) => f.file);
    assert.strictEqual((await json('DELETE', `/api/milestones/${m.id}`)).status, 200);
    for (const f of files) assert.ok(!fs.existsSync(path.join(DATA_DIR, 'uploads', f)));

    // data saved by the first version (no processes / processId) still loads
    srv.kill('SIGTERM'); await new Promise((r2) => srv.on('exit', r2));
    fs.writeFileSync(path.join(DATA_DIR, 'milestones.json'), JSON.stringify({ projectName: 'Legacy', milestones: [
      { id: 'aaaaaaaaaaaaaaaa', date: '2026-01-05', name: 'Old one', team: 'T', notes: '', media: [], createdAt: '2026-01-05T00:00:00.000Z' }] }));
    srv = await start();
    state = await (await fetch(base + '/api/state')).json();
    assert.strictEqual(state.milestones.length, 1);
    assert.deepStrictEqual(state.processes, []);
    r = await json('PUT', '/api/milestones/aaaaaaaaaaaaaaaa', { date: '2026-01-05', name: 'Old one', team: 'T' });
    assert.strictEqual(r.status, 200);
    console.log('All smoke tests passed');
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
