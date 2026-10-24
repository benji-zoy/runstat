// Zone publique (public-api.mjs, webauthn.mjs, auth-store.mjs, backup-store.mjs) : CORS et origines, invitations, passkeys
// (clés ES256 et RS256 générées par node:crypto, attestation « none »), sessions et ré-authentification, sauvegarde opaque
// cloisonnée et versionnée, relais Google, limites de débit. Vrai serveur HTTP sur un port libre, dossiers temporaires.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountsLoader } from './accounts.mjs';
import { AuthStore } from './auth-store.mjs';
import { BackupStore } from './backup-store.mjs';
import { createPublicApi } from './public-api.mjs';
import { decodeCbor, verifyRegistration, WebAuthnError } from './webauthn.mjs';

const APP = 'https://app.example';
const RP = 'app.example';
const USERS = [
  { id: 'alice', name: 'Alice', role: 'owner', mode: 'hosted', logins: ['alice@exemple.fr'] },
  { id: 'carol', name: 'Carol', role: 'member', mode: 'local', logins: [] },
  { id: 'dave', name: 'Dave', role: 'member', mode: 'local', logins: [] },
  { id: 'erin', name: 'Erin', role: 'member', mode: 'local', logins: [] },
];
const b64 = (b) => Buffer.from(b).toString('base64url');
const sha = (d) => createHash('sha256').update(d).digest();

// ---------- CBOR et authentificateur factices ----------

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('type');
}

/** Authentificateur : une clé (ES256 ou RS256), un identifiant, un compteur */
function authenticator(alg = -7, { counter = 0 } = {}) {
  const { publicKey, privateKey } = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose =
    alg === -7
      ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
      : new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  const id = randomBytes(32);
  const a = { id: b64(id), counter, cose, privateKey };
  const authData = ({ rpId = RP, flags = 0x05, attested = false, coseKey = cose } = {}) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(a.counter);
    const parts = [sha(rpId), Buffer.from([attested ? flags | 0x40 : flags]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(id.length);
      parts.push(Buffer.alloc(16), len, id, cbor(coseKey));
    }
    return Buffer.concat(parts);
  };
  const clientData = (type, challenge, { origin = APP, crossOrigin = false } = {}) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }));
  a.create = (challenge, opts = {}) => ({
    id: a.id,
    response: {
      clientDataJSON: b64(clientData('webauthn.create', challenge, opts)),
      attestationObject: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData({ ...opts, attested: true })]]))),
    },
  });
  a.get = (challenge, opts = {}) => {
    const ad = authData(opts);
    const cd = clientData('webauthn.get', challenge, opts);
    return {
      id: a.id,
      response: { clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey)), userHandle: '' },
    };
  };
  return a;
}

// ---------- serveur ----------

let dir;
let server;
let base;
let now = Date.UTC(2026, 9, 24, 12);
let logs = [];
let googleCalls = [];
const fakeFetch = async (url, init) => {
  googleCalls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
  return new Response(JSON.stringify({ access_token: 'G-ACCESS', expires_in: 3599, refresh_token: 'G-REFRESH', scope: 's', token_type: 'Bearer', id_token: 'à filtrer' }), { status: 200 });
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'runstat-public-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify(USERS));
  mkdirSync(join(dir, 'alice', 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'alice', 'secrets', 'google-client.json'), JSON.stringify({ web: { client_id: 'gid', client_secret: 'GSECRET' } }));
  const api = createPublicApi({
    accounts: accountsLoader(dir, null),
    usersDir: dir,
    appOrigins: [APP],
    googleRedirects: [`${APP}/runstat/connexion/google`],
    quotaBytes: 200_000,
    log: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => now,
    fetch: fakeFetch,
  });
  server = createServer(api);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

let ipCounter = 0;
/** Requête depuis l'appli (Origin), IP différente à chaque fois sauf `ip` */
async function call(method, path, { body, token, headers = {}, origin = APP, ip, raw } = {}) {
  const h = { 'X-Real-IP': ip ?? `198.51.100.${++ipCounter % 250}`, ...headers };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
const auth = () => new AuthStore(dir, () => now);

/** Invitation complète : passkey enregistrée, jeton de session */
async function join_(userId, a = authenticator()) {
  const { code } = auth().createCode(userId, 'invite');
  const opts = await call('POST', '/auth/invitation/options', { body: { code } });
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const reg = await call('POST', '/auth/invitation/register', { body: { code, credential: a.create(opts.body.challenge), label: 'Test' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return { token: reg.body.token, a, opts: opts.body };
}

// ---------- CORS et périmètre ----------

test('CORS : origine de l’appli seulement, pré-vérification, rien d’autre que /auth, /backup, /relay', async () => {
  const pre = await call('OPTIONS', '/backup/manifest', { headers: { 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(pre.headers.get('vary'), /Origin/);
  assert.equal((await call('OPTIONS', '/backup/manifest', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('OPTIONS', '/backup/manifest', { origin: null })).status, 400);
  const evil = await call('POST', '/auth/login/options', { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  // Aucune route du tableau de bord sur ce port
  for (const p of ['/api/sync', '/api/data/coros.json', '/data/coros.json', '/api/admin/users', '/']) assert.equal((await call('GET', p)).status, 404, p);
  // Client hors navigateur (pas d'Origin) : accepté, mais sans en-têtes CORS
  const cli = await call('POST', '/auth/login/options', { origin: null });
  assert.equal(cli.status, 200);
  assert.equal(cli.headers.get('access-control-allow-origin'), null);
});

// ---------- invitations et passkeys ----------

test('invitation : passkey créée, code à usage unique, identifiant WebAuthn aléatoire', async () => {
  const { code } = auth().createCode('carol', 'invite');
  const opts = await call('POST', '/auth/invitation/options', { body: { code } });
  assert.equal(opts.body.rp.id, RP);
  assert.notEqual(opts.body.user.id, 'carol');
  assert.deepEqual(opts.body.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
  assert.equal(opts.body.authenticatorSelection.userVerification, 'required');
  assert.equal(opts.body.authenticatorSelection.residentKey, 'required');
  const a = authenticator();
  const reg = await call('POST', '/auth/invitation/register', { body: { code, credential: a.create(opts.body.challenge) } });
  assert.equal(reg.status, 201);
  assert.deepEqual(reg.body.user, { id: 'carol', name: 'Carol' });
  assert.match(reg.body.token, /^[\w-]{43}$/);
  // Code consommé
  assert.equal((await call('POST', '/auth/invitation/options', { body: { code } })).status, 400);
  // Rien en clair sur le disque
  const stored = readdirSync(join(dir, 'auth')).map((f) => readFileSyncSafe(join(dir, 'auth', f))).join('');
  assert.ok(!stored.includes(code) && !stored.includes(reg.body.token));
  assert.ok(!logs.join('\n').includes(reg.body.token) && !logs.join('\n').includes(code));
});

const readFileSyncSafe = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

test('invitation : expirée, compte hébergé, ou passkey non conforme → refusée', async () => {
  // Expirée (7 jours)
  const old = auth().createCode('dave', 'invite');
  now += 8 * 86_400_000;
  assert.equal((await call('POST', '/auth/invitation/options', { body: { code: old.code } })).status, 400);
  // Compte hébergé : pas d'accès public, même avec un code
  const hosted = auth().createCode('alice', 'invite');
  assert.equal((await call('POST', '/auth/invitation/options', { body: { code: hosted.code } })).status, 400);

  const tries = [
    ['origine', (a, c) => a.create(c, { origin: 'https://evil.example' }), /origine/],
    ['rpId', (a, c) => a.create(c, { rpId: 'evil.example' }), /rpId/],
    ['page tierce', (a, c) => a.create(c, { crossOrigin: true }), /tierce/],
    ['sans vérification', (a, c) => a.create(c, { flags: 0x01 }), /vérification/],
  ];
  for (const [name, make, re] of tries) {
    const { code } = auth().createCode('dave', 'invite');
    const opts = await call('POST', '/auth/invitation/options', { body: { code } });
    const reg = await call('POST', '/auth/invitation/register', { body: { code, credential: make(authenticator(), opts.body.challenge) } });
    assert.equal(reg.status, 400, name);
    assert.match(reg.body.error, re, name);
    // Le code reste valable après un échec
    assert.equal((await call('POST', '/auth/invitation/options', { body: { code } })).status, 200, name);
  }
  // Algorithme non annoncé (Ed25519, -8)
  const a = authenticator();
  const ed = new Map([[1, 1], [3, -8], [-1, 6], [-2, randomBytes(32)]]);
  const { code } = auth().createCode('dave', 'invite');
  const opts = await call('POST', '/auth/invitation/options', { body: { code } });
  const cred = a.create(opts.body.challenge, { coseKey: ed });
  assert.throws(() => verifyRegistration(cred.response, { challenge: opts.body.challenge, origins: [APP] }), WebAuthnError);
  // Challenge rejoué : la demande est consommée au premier essai
  const ok = await call('POST', '/auth/invitation/register', { body: { code, credential: a.create(opts.body.challenge) } });
  assert.equal(ok.status, 201);
  const replay = await call('POST', '/auth/invitation/register', { body: { code, credential: a.create(opts.body.challenge) } });
  assert.equal(replay.status, 400);
});

test('connexion : ES256 et RS256, challenge à usage unique, compteur en recul refusé, compteur nul accepté', async () => {
  const es = authenticator(-7, { counter: 5 });
  await join_('carol', es);
  const rs = authenticator(-257);
  await join_('dave', rs);
  const login = async (a, opts) => {
    const o = await call('POST', '/auth/login/options');
    return { o, r: await call('POST', '/auth/login', { body: { credential: a.get(o.body.challenge, opts) } }) };
  };
  es.counter = 6;
  let { o, r } = await login(es);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user, { id: 'carol', name: 'Carol' });
  // Même challenge une seconde fois
  es.counter = 7;
  assert.equal((await call('POST', '/auth/login', { body: { credential: es.get(o.body.challenge) } })).status, 400);
  // Compteur en recul (clé clonée)
  es.counter = 3;
  ({ r } = await login(es));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /compteur/);
  // RS256, compteur toujours nul (iCloud, Google)
  ({ r } = await login(rs));
  assert.equal(r.status, 200);
  ({ r } = await login(rs));
  assert.equal(r.status, 200);
  // Signature d'une autre clé
  const other = authenticator();
  const o2 = await call('POST', '/auth/login/options');
  const forged = { ...other.get(o2.body.challenge), id: rs.id };
  assert.equal((await call('POST', '/auth/login', { body: { credential: forged } })).status, 400);
});

test('session : déconnexion révoquée côté serveur ; lien de connexion sans ré-authentification n’ouvre rien de sensible', async () => {
  const { token, a } = await join_('carol');
  const me = await call('GET', '/auth/session', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, 'carol');
  assert.equal(me.body.stepUp, true);
  assert.equal((await call('GET', '/auth/session', { token: 'x'.repeat(43) })).status, 401);

  // Lien de connexion pour un second appareil (session neuve par passkey : ré-authentification valable)
  const link = await call('POST', '/auth/links', { token });
  assert.equal(link.status, 201);
  const second = await call('POST', '/auth/link', { body: { code: link.body.code } });
  assert.equal(second.status, 200);
  assert.equal((await call('POST', '/auth/link', { body: { code: link.body.code } })).status, 400);
  // Session ouverte par un lien (ou volée) : ni nouveau lien, ni suppression de la sauvegarde sans passkey
  const t2 = second.body.token;
  const denied = await call('POST', '/auth/links', { token: t2 });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.stepUp, true);
  assert.equal((await call('DELETE', '/backup', { token: t2 })).status, 403);
  assert.equal((await call('POST', '/auth/credentials/options', { token: t2 })).status, 403);
  // Ré-authentification par la passkey du compte
  const so = await call('POST', '/auth/stepup/options', { token: t2 });
  assert.ok(so.body.allowCredentials.map((c) => c.id).includes(a.id));
  assert.equal((await call('POST', '/auth/stepup', { token: t2, body: { credential: a.get(so.body.challenge) } })).status, 204);
  assert.equal((await call('POST', '/auth/links', { token: t2 })).status, 201);
  // La ré-authentification expire au bout de 5 minutes
  now += 6 * 60_000;
  assert.equal((await call('POST', '/auth/links', { token: t2 })).status, 403);

  assert.equal((await call('DELETE', '/auth/session', { token })).status, 204);
  assert.equal((await call('GET', '/auth/session', { token })).status, 401);
  // Session d'un autre compte : jamais visible
  const dave = await join_('dave');
  const list = await call('GET', '/auth/session', { token: dave.token });
  assert.ok(list.body.sessions.every((s) => !me.body.sessions.some((x) => x.id === s.id)));
  // Réinitialisation par le propriétaire : tout est révoqué
  auth().revokeAll('dave');
  assert.equal((await call('GET', '/auth/session', { token: dave.token })).status, 401);
});

// ---------- sauvegarde ----------

const objectId = (data) => createHash('sha256').update(data).digest('hex');

test('sauvegarde : objets opaques, versions contrôlées, cloisonnée par compte', async () => {
  const carol = await join_('carol');
  const dave = await join_('dave');
  const data = randomBytes(1000);
  const id = objectId(data);
  const manifest = (version, objects = [id]) => ({ version, header: { kdf: { name: 'PBKDF2-SHA256', iterations: 600000 } }, blob: b64(randomBytes(64)), objects });

  assert.equal((await call('GET', '/backup/manifest', { token: carol.token })).status, 404);
  assert.equal((await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(1) })).status, 428);
  const missing = await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(1), headers: { 'If-None-Match': '*' } });
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.body.missing, [id]);
  assert.deepEqual((await call('POST', '/backup/objects/missing', { token: carol.token, body: { ids: [id] } })).body.missing, [id]);

  const put = await call('PUT', `/backup/objects/${id}`, { token: carol.token, raw: data, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(put.status, 201);
  assert.equal((await call('PUT', `/backup/objects/${id}`, { token: carol.token, raw: data, headers: { 'Content-Type': 'application/octet-stream' } })).status, 200);
  const v1 = await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(1), headers: { 'If-None-Match': '*' } });
  assert.equal(v1.status, 201);
  assert.equal(v1.headers.get('etag'), '"v1"');

  // Écriture concurrente : version périmée → 412 avec la version actuelle
  const stale = await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(1), headers: { 'If-None-Match': '*' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current, 1);
  assert.equal((await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(3), headers: { 'If-Match': '"v1"' } })).status, 400);
  assert.equal((await call('PUT', '/backup/manifest', { token: carol.token, body: manifest(2), headers: { 'If-Match': '"v1"' } })).status, 201);
  const latest = await call('GET', '/backup/manifest', { token: carol.token });
  assert.equal(latest.body.version, 2);
  assert.deepEqual((await call('GET', '/backup/manifests', { token: carol.token })).body.map((m) => m.version), [1, 2]);
  const back = await fetch(`${base}/backup/objects/${id}`, { headers: { Authorization: `Bearer ${carol.token}`, Origin: APP } });
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), data);

  // Dave ne voit rien de Carol
  assert.equal((await call('GET', '/backup/manifest', { token: dave.token })).status, 404);
  assert.equal((await call('GET', `/backup/objects/${id}`, { token: dave.token })).status, 404);
  assert.equal((await call('GET', '/backup/manifests/1', { token: dave.token })).status, 404);
  assert.equal((await call('GET', '/backup/manifest')).status, 401);

  // Objet tronqué, identifiant invalide, quota
  const short = await fetch(`${base}/backup/objects/${objectId('x')}`, { method: 'PUT', headers: { Authorization: `Bearer ${carol.token}`, 'Content-Length': '10' }, body: 'x' }).catch(() => null);
  assert.ok(!short || short.status >= 400);
  assert.equal((await call('PUT', '/backup/objects/abc', { token: carol.token, raw: 'x' })).status, 404);
  const big = randomBytes(250_000);
  assert.equal((await call('PUT', `/backup/objects/${objectId(big)}`, { token: carol.token, raw: big })).status, 507);
});

test('sauvegarde : dix envois vides ne suffisent pas à tout effacer (30 jours), puis ménage', () => {
  const base_ = join(dir, 'erin');
  const store = new BackupStore(base_, () => now);
  const data = Buffer.from('chiffré');
  const id = objectId(data);
  const tmp = store.tmpFile(id);
  writeFileSync(tmp, data);
  store.commitObject(id, tmp);
  store.putManifest({ version: 1, header: {}, blob: 'abc', objects: [id] }, null);
  for (let v = 2; v <= 11; v++) store.putManifest({ version: v, header: {}, blob: 'abc', objects: [] }, v - 1);
  store.gc();
  assert.ok(store.hasObject(id), 'objet du manifeste 1 gardé');
  assert.equal(store.list().length, 11);
  now += 31 * 86_400_000;
  store.gc();
  assert.equal(store.hasObject(id), false);
  assert.deepEqual(store.list().map((m) => m.version), [11]);
  // Suppression douce : récupérable 30 jours
  assert.equal(store.softDelete(), true);
  assert.equal(store.latest(), null);
  assert.ok(readdirSync(base_).some((f) => f.startsWith('backup-supprimee-')));
  now += 31 * 86_400_000;
  new BackupStore(base_, () => now).gc();
  assert.ok(!readdirSync(base_).some((f) => f.startsWith('backup-supprimee-')));
});

test('sauvegarde : suppression avec ré-authentification', async () => {
  const { token } = await join_('dave');
  const data = randomBytes(10);
  assert.equal((await call('PUT', `/backup/objects/${objectId(data)}`, { token, raw: data })).status, 201);
  const put = await call('PUT', '/backup/manifest', { token, body: { version: 1, header: {}, blob: 'abc', objects: [objectId(data)] }, headers: { 'If-None-Match': '*' } });
  assert.equal(put.status, 201);
  assert.equal((await call('DELETE', '/backup', { token })).status, 204);
  assert.equal((await call('GET', '/backup/manifest', { token })).status, 404);
});

test('client du moteur contre ce serveur : sauvegarde chiffrée, deux appareils, rien de lisible côté NAS', async () => {
  const { publicClient } = await import('#engine/backup/api.ts');
  const { syncBackup } = await import('#engine/backup/sync.ts');
  const { newDataKey, wrapKey, workKeys, unwrapKey } = await import('#engine/backup/crypto.ts');
  const { MemoryStore } = await import('#engine/storage/memory.ts');
  const { token } = await join_('dave');
  // Navigateur simulé : origine de l'appli, une IP
  const browserFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: APP, 'X-Real-IP': '198.51.100.200' } });
  const client = publicClient(base, () => token, browserFetch);
  const dataKey = newDataKey();
  const header = { v: 1, wraps: [await wrapKey(dataKey, 'phrase de Dave', 'passphrase')] };
  const keys = await workKeys(dataKey);
  const phone = new MemoryStore({ 'athlete.json': '{"hrMax":188,"note":"secret de Dave"}', 'fit/9.fit': randomBytes(120_000) });
  const r1 = await syncBackup({ raw: phone, api: client.backup, keys, account: 'dave', device: { id: 'tel', name: 'Téléphone' }, header });
  assert.equal(r1.version, 1);
  // Côté NAS : des tailles et des identifiants, rien de lisible
  const stored = join(dir, 'dave', 'backup');
  const all = readdirSync(join(stored, 'objects')).map((f) => readFileSync(join(stored, 'objects', f)).toString('latin1')).join('');
  const manifest = readdirSync(join(stored, 'manifests')).map((f) => readFileSync(join(stored, 'manifests', f), 'utf8')).join('');
  for (const secret of ['secret de Dave', 'hrMax', 'athlete.json', 'fit/9.fit']) assert.ok(!all.includes(secret) && !manifest.includes(secret), secret);

  // Second appareil : passkey existante → session, phrase de passe → clé, restauration
  const remote = await client.backup.getManifest();
  const keys2 = await workKeys(await unwrapKey(remote.header.wraps, 'phrase de Dave'));
  const laptop = new MemoryStore();
  const r2 = await syncBackup({ raw: laptop, api: client.backup, keys: keys2, account: 'dave', device: { id: 'pc', name: 'Portable' } });
  assert.equal(r2.downloaded, 2);
  assert.equal(new TextDecoder().decode(await laptop.read('athlete.json')), '{"hrMax":188,"note":"secret de Dave"}');
  await assert.rejects(() => unwrapKey(remote.header.wraps, 'mauvaise phrase'), /incorrecte/);
});

// ---------- relais ----------

test('relais Google : secret ajouté côté serveur, échanges prévus seulement, réponse filtrée', async () => {
  const { token } = await join_('carol');
  googleCalls = [];
  const redirect = `${APP}/runstat/connexion/google`;
  const verifier = 'v'.repeat(43);
  const bad = [
    [{ grant_type: 'client_credentials' }, /grant_type/],
    [{ grant_type: 'authorization_code', code: 'c', code_verifier: verifier, redirect_uri: 'https://evil.example/cb' }, /retour/],
    [{ grant_type: 'authorization_code', code: 'c', redirect_uri: redirect }, /PKCE/],
  ];
  for (const [body, re] of bad) {
    const r = await call('POST', '/relay/google/token', { token, body });
    assert.equal(r.status, 400);
    assert.match(r.body.error, re);
  }
  assert.equal(googleCalls.length, 0);
  assert.equal((await call('POST', '/relay/google/token', { body: { grant_type: 'refresh_token', refresh_token: 'r' } })).status, 401);
  // Identifiant du client (public) pour l'adresse de consentement : session exigée, jamais le secret
  assert.equal((await call('GET', '/relay/google/client')).status, 401);
  const client = await call('GET', '/relay/google/client', { token });
  assert.equal(client.status, 200);
  assert.ok(client.body.client_id && !JSON.stringify(client.body).includes('GSECRET'));
  assert.deepEqual(client.body.redirects, [redirect]);

  const ok = await call('POST', '/relay/google/token', { token, body: { grant_type: 'authorization_code', code: '4/0Ab', code_verifier: verifier, redirect_uri: redirect } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
  assert.equal(googleCalls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(googleCalls[0].body.client_secret, 'GSECRET');
  assert.equal(googleCalls[0].body.code_verifier, verifier);
  assert.ok(!logs.join('\n').includes('G-REFRESH') && !logs.join('\n').includes('4/0Ab'));
  // Limite par compte : 30 par heure
  let last;
  for (let i = 0; i < 30; i++) last = await call('POST', '/relay/google/token', { token, body: { grant_type: 'refresh_token', refresh_token: 'r' } });
  assert.equal(last.status, 429);
});

test('limites : /auth par adresse (la plus à droite de X-Forwarded-For, posée par nginx)', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/auth/login/options', { ip: '203.0.113.9' });
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/auth/login/options', { ip: '203.0.113.10' })).status, 200);
});

test('CBOR : refuse les entrées tronquées, trop imbriquées ou avec des octets en trop', () => {
  assert.throws(() => decodeCbor(Buffer.from([0x5a, 0, 0, 0, 10])), WebAuthnError);
  assert.throws(() => decodeCbor(Buffer.from([0x01, 0x02])), WebAuthnError);
  assert.throws(() => decodeCbor(Buffer.alloc(20, 0x81)), WebAuthnError);
  assert.deepEqual(decodeCbor(cbor(new Map([['a', [1, -2, Buffer.from('x')]]]))).value, new Map([['a', [1, -2, Buffer.from('x')]]]));
});

test('suppression du compte local-first : ré-authentification, puis sauvegarde, passkeys et sessions effacées', async () => {
  const { token, a } = await join_('erin');
  const data = randomBytes(10);
  assert.equal((await call('PUT', `/backup/objects/${objectId(data)}`, { token, raw: data })).status, 201);
  // La session de l'invitation vaut ré-authentification 5 min : au-delà, la passkey est redemandée
  now += 6 * 60_000;
  assert.equal((await call('DELETE', '/auth/account', { token })).status, 403);
  const so = await call('POST', '/auth/stepup/options', { token });
  assert.equal((await call('POST', '/auth/stepup', { token, body: { credential: a.get(so.body.challenge) } })).status, 204);
  assert.equal((await call('DELETE', '/auth/account', { token })).status, 204);
  assert.equal((await call('GET', '/auth/session', { token })).status, 401);
  assert.deepEqual(auth().credentials('erin'), []);
  assert.ok(readdirSync(join(dir, 'erin')).some((f) => f.startsWith('backup-supprimee-')));
});
