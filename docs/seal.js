'use strict';
/*
 * Password-sealing for the published read-only snapshot (docs/timeline.enc). No DOM, so it also runs in Node tests.
 *
 * GitHub Pages is static hosting: it cannot check a login. Instead the snapshot is ENCRYPTED with a key derived from
 * username + password, and the public viewer page decrypts it in the browser. Without the credentials the file is
 * unreadable. It is NOT rate-limited (anyone can download the file and guess offline), so protection is only as
 * strong as the password: short passwords can be cracked, long ones cannot.
 *
 * File layout (binary):  "MTL1" | iterations (uint32 BE) | salt (16) | iv (12) | AES-256-GCM ciphertext
 * The first 36 bytes are authenticated as additional data. Plaintext = gzip(JSON).
 * Key = PBKDF2-SHA256(lowercase(trim(username)) + "\n" + password, salt, iterations).
 */
(function (root) {
  const MAGIC = [0x4d, 0x54, 0x4c, 0x31]; // "MTL1"
  const HEADER = 36;
  const ITERATIONS = 600000;
  const MIN_ITER = 100000, MAX_ITER = 5000000; // refuse hostile files that would hang the browser
  const enc = new TextEncoder(), dec = new TextDecoder();
  const subtle = () => (root.crypto || globalThis.crypto).subtle;
  const random = (n) => (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(n));

  const BAD = 'Incorrect username or password.';
  const fail = (msg, code) => Object.assign(new Error(msg), { code });

  async function pipe(bytes, stream) {
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  const gzip = (b) => pipe(b, new CompressionStream('gzip'));
  const gunzip = (b) => pipe(b, new DecompressionStream('gzip'));

  async function deriveKey(username, password, salt, iterations) {
    const material = await subtle().importKey('raw', enc.encode(String(username).trim().toLowerCase() + '\n' + String(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // obj -> Uint8Array (the file to publish)
  async function seal(obj, username, password, iterations = ITERATIONS) {
    if (!String(username).trim() || !password) throw fail('Username and password are required.', 'EMPTY');
    const header = new Uint8Array(HEADER);
    header.set(MAGIC, 0);
    new DataView(header.buffer).setUint32(4, iterations);
    header.set(random(16), 8); // salt
    header.set(random(12), 24); // iv
    const key = await deriveKey(username, password, header.slice(8, 24), iterations);
    const plain = await gzip(enc.encode(JSON.stringify(obj)));
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: header.slice(24, 36), additionalData: header }, key, plain));
    const out = new Uint8Array(HEADER + ct.length);
    out.set(header, 0); out.set(ct, HEADER);
    return out;
  }

  // Uint8Array -> obj. Throws code 'BAD_CREDENTIALS' for a wrong username/password (or a tampered file), 'BAD_FILE' otherwise.
  async function open(bytes, username, password) {
    if (!(bytes instanceof Uint8Array) || bytes.length < HEADER + 16 || MAGIC.some((b, i) => bytes[i] !== b)) throw fail('This is not a published timeline file.', 'BAD_FILE');
    const header = bytes.slice(0, HEADER);
    const iterations = new DataView(header.buffer).getUint32(4);
    if (iterations < MIN_ITER || iterations > MAX_ITER) throw fail('This is not a published timeline file.', 'BAD_FILE');
    let plain;
    try {
      const key = await deriveKey(username, password, header.slice(8, 24), iterations);
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: header.slice(24, 36), additionalData: header }, key, bytes.slice(HEADER)));
    } catch { throw fail(BAD, 'BAD_CREDENTIALS'); }
    try { return JSON.parse(dec.decode(await gunzip(plain))); }
    catch { throw fail('This is not a published timeline file.', 'BAD_FILE'); }
  }

  // Rough guide shown to the user: length is what matters most.
  function weakness(password) {
    const p = String(password || '');
    if (p.length >= 12) return '';
    return `This password is short (${p.length} character${p.length === 1 ? '' : 's'}). Anyone can download the published file and try guesses offline with no limit, so a short password can be cracked — in hours on one computer, minutes with a rented graphics card. Use 12+ characters (for example 4 random words) for real protection.`;
  }

  const api = { seal, open, weakness, ITERATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Seal = api;
})(typeof window !== 'undefined' ? window : globalThis);
