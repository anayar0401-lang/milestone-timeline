'use strict';
// Tests for docs/seal.js (password-sealing of the published read-only snapshot).
const assert = require('assert');
const Seal = require('../docs/seal.js');

(async () => {
  const data = { app: 'milestone-timeline', projectName: 'Secret Project ✓', milestones: [{ id: 'a'.repeat(16), name: 'Confidential kickoff', notes: 'budget is 4.2M' }] };
  const FAST = 100000; // minimum allowed iterations, keeps the test quick

  // round trip, with the credentials format used in practice
  const file = await Seal.seal(data, 'alice', 'blue-train-42', FAST);
  assert.deepStrictEqual(await Seal.open(file, 'alice', 'blue-train-42'), data);

  // username is case-insensitive and trimmed; password is case-sensitive
  assert.deepStrictEqual(await Seal.open(file, '  ALICE ', 'blue-train-42'), data);
  await assert.rejects(() => Seal.open(file, 'alice', 'BLUE-TRAIN-42'), { code: 'BAD_CREDENTIALS' });
  await assert.rejects(() => Seal.open(file, 'other', 'blue-train-42'), { code: 'BAD_CREDENTIALS' });
  await assert.rejects(() => Seal.open(file, 'alice', ''), { code: 'BAD_CREDENTIALS' });
  await assert.rejects(() => Seal.seal(data, '', 'x'), { code: 'EMPTY' });
  await assert.rejects(() => Seal.seal(data, 'u', ''), { code: 'EMPTY' });

  // the published file reveals nothing readable
  const text = Buffer.from(file).toString('latin1');
  for (const secret of ['Secret Project', 'Confidential', 'budget', 'milestone-timeline', 'alice']) assert.ok(!text.includes(secret), `file leaks "${secret}"`);

  // fresh salt/iv every time
  const file2 = await Seal.seal(data, 'alice', 'blue-train-42', FAST);
  assert.notDeepStrictEqual(file, file2);
  assert.deepStrictEqual(await Seal.open(file2, 'alice', 'blue-train-42'), data);

  // tampering with any part is detected (ciphertext, salt, iterations header)
  for (const idx of [40, file.length - 1, 10, 7]) {
    const bad = Uint8Array.from(file); bad[idx] ^= 1;
    await assert.rejects(() => Seal.open(bad, 'alice', 'blue-train-42'), (e) => ['BAD_CREDENTIALS', 'BAD_FILE'].includes(e.code), `tamper at ${idx}`);
  }
  await assert.rejects(() => Seal.open(file.slice(0, 50), 'alice', 'blue-train-42'), (e) => ['BAD_CREDENTIALS', 'BAD_FILE'].includes(e.code));
  await assert.rejects(() => Seal.open(new Uint8Array(100), 'alice', 'blue-train-42'), { code: 'BAD_FILE' });
  await assert.rejects(() => Seal.open(Uint8Array.from(Buffer.from('<html>404 not found</html>'.repeat(5))), 'alice', 'blue-train-42'), { code: 'BAD_FILE' });

  // hostile iteration counts are refused without doing the work
  const hostile = Uint8Array.from(file); new DataView(hostile.buffer).setUint32(4, 4294967295);
  await assert.rejects(() => Seal.open(hostile, 'alice', 'blue-train-42'), { code: 'BAD_FILE' });

  // large payloads (images) survive, and compress
  const big = { blob: 'QUJD'.repeat(1_000_000) };
  const bigFile = await Seal.seal(big, 'u', 'p', FAST);
  assert.ok(bigFile.length < 4_000_000 * 0.2, 'gzip should shrink repetitive base64');
  assert.deepStrictEqual(await Seal.open(bigFile, 'u', 'p'), big);

  // the default work factor is the strong one
  assert.strictEqual(Seal.ITERATIONS, 600000);
  const real = await Seal.seal(data, 'alice', 'blue-train-42');
  assert.strictEqual(new DataView(real.buffer).getUint32(4), 600000);
  assert.deepStrictEqual(await Seal.open(real, 'alice', 'blue-train-42'), data);

  // password-strength guidance
  assert.ok(Seal.weakness('abcd').includes('short'));
  assert.strictEqual(Seal.weakness('correct horse battery'), '');

  console.log('Seal tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
