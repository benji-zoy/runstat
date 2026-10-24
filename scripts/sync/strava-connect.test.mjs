// Tests de la connexion Strava depuis le site (strava-connect.mjs) : state, liste blanche des origines, échange du code
// avec fetch bouchonné, jetons écrits dans secrets/ et jamais renvoyés au navigateur. Dossiers temporaires.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secrets = mkdtempSync(join(tmpdir(), 'runstat-secrets-'));
const raw = mkdtempSync(join(tmpdir(), 'runstat-raw-'));
process.env.RUNSTAT_SECRETS = secrets;
// secretsDir est lu au chargement : import après la variable d'environnement
const { InvalidEntry } = await import('./entries.mjs');
const { StateStore, STATE_TTL_MS, allowedOrigins, preferredOrigin, publicOrigin, stravaConnectRoutes, stravaStatus, validateStravaClient } =
  await import('./strava-connect.mjs');

const CLIENT = { client_id: '12345', client_secret: 'a'.repeat(40) };
const TOKENS = { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_at: 2_000_000_000 };
const ORIGIN = 'https://nas.tail1234.ts.net';
const silent = { log() {}, warn() {}, error() {} };

/** Réponse HTTP factice : statut, en-têtes et corps */
function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headers = {}) => Object.assign(res, { status, headers });
  res.end = (b = '') => (res.body += b);
  return res;
}
const req = (headers) => ({ headers });
const secretFile = (name) => join(secrets, name);
const readSecretFile = (name) => JSON.parse(readFileSync(secretFile(name), 'utf8'));

/** fetch bouchonné : enregistre les appels, répond par `reply` */
let calls = [];
let reply = () => new Response(JSON.stringify({ ...TOKENS, athlete: { id: 777, firstname: 'Jo', lastname: 'X' } }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return reply();
};
after(() => {
  globalThis.fetch = realFetch;
  rmSync(secrets, { recursive: true, force: true });
  rmSync(raw, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  rmSync(secretFile('strava-tokens.json'), { force: true });
  writeFileSync(secretFile('strava-client.json'), JSON.stringify(CLIENT));
  rmSync(join(raw, 'sync-state.json'), { force: true });
});

/** Parcours complet jusqu'à la redirection vers Strava : renvoie le state de l'URL d'autorisation */
function connect(routes, headers = { 'x-forwarded-host': 'nas.tail1234.ts.net', 'x-forwarded-proto': 'https', host: 'runstat-sync:8787' }) {
  const res = fakeRes();
  routes.connect(req(headers), res);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.Location);
  return { res, to, state: to.searchParams.get('state') };
}

async function callback(routes, params) {
  const res = fakeRes();
  await routes.callback(req({}), res, new URL(`http://runstat/api/strava/callback?${new URLSearchParams(params)}`));
  assert.equal(res.status, 302);
  return { res, back: new URL(res.headers.Location, ORIGIN) };
}

// ---------- origine du site ----------

test('origine : X-Forwarded-Host prioritaire, liste blanche stricte', () => {
  const allowed = allowedOrigins(`${ORIGIN}, http://192.0.2.24:8080/ ,pas une url`);
  assert.deepEqual(allowed, [ORIGIN, 'http://192.0.2.24:8080']);
  assert.equal(publicOrigin({ 'x-forwarded-host': 'nas.tail1234.ts.net', 'x-forwarded-proto': 'https', host: 'runstat-sync:8787' }, allowed), ORIGIN);
  assert.equal(publicOrigin({ host: '192.0.2.24:8080' }, allowed), 'http://192.0.2.24:8080');
  // Plusieurs mandataires : le premier hôte
  assert.equal(publicOrigin({ 'x-forwarded-host': 'nas.tail1234.ts.net, autre', 'x-forwarded-proto': 'https,http' }, allowed), ORIGIN);
  // Hors liste, schéma différent, port différent, hôte piégé
  assert.equal(publicOrigin({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, allowed), null);
  assert.equal(publicOrigin({ 'x-forwarded-host': 'nas.tail1234.ts.net', 'x-forwarded-proto': 'http' }, allowed), null);
  assert.equal(publicOrigin({ host: '192.0.2.24:8081' }, allowed), null);
  assert.equal(publicOrigin({ 'x-forwarded-host': 'nas.tail1234.ts.net@evil.example', 'x-forwarded-proto': 'https' }, allowed), null);
  assert.equal(publicOrigin({ 'x-forwarded-host': 'nas.tail1234.ts.net/x', 'x-forwarded-proto': 'https' }, allowed), null);
  assert.equal(publicOrigin({ 'x-forwarded-proto': 'https' }, allowed), null);
  assert.equal(publicOrigin({ host: 'localhost:4310' }, allowed), null);
  // Sans liste : poste local seulement
  assert.equal(allowedOrigins(''), null);
  assert.equal(publicOrigin({ host: 'localhost:4310' }, null), 'http://localhost:4310');
  assert.equal(publicOrigin({ host: '192.0.2.24:8080' }, null), null);
  // Adresse proposée pour la connexion : HTTPS d'abord
  assert.equal(preferredOrigin(allowedOrigins(`http://192.0.2.24:8080,${ORIGIN}`)), ORIGIN);
  assert.equal(preferredOrigin(allowedOrigins('http://192.0.2.24:8080')), 'http://192.0.2.24:8080');
  assert.equal(preferredOrigin(null), null);
});

test('connect : hôte hors liste refusé, sans redirection vers Strava', () => {
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  const res = fakeRes();
  routes.connect(req({ host: 'evil.example' }), res);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, '/aujourdhui?strava=refus&raison=origine');
});

test('connect : sans appli Strava enregistrée, retour avec la raison', () => {
  rmSync(secretFile('strava-client.json'));
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  const res = fakeRes();
  routes.connect(req({ 'x-forwarded-host': 'nas.tail1234.ts.net', 'x-forwarded-proto': 'https' }), res);
  assert.equal(res.headers.Location, '/aujourdhui?strava=refus&raison=appli');
});

test('connect : redirection vers l’autorisation Strava avec l’appli de l’athlète', () => {
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  const { to, state } = connect(routes);
  assert.equal(`${to.origin}${to.pathname}`, 'https://www.strava.com/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), '12345');
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.equal(to.searchParams.get('approval_prompt'), 'auto');
  assert.equal(to.searchParams.get('scope'), 'read,activity:read_all');
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/api/strava/callback`);
  assert.match(state, /^[\w-]{32}$/);
  assert.equal(to.searchParams.get('client_secret'), null);
  assert.ok(!to.toString().includes(CLIENT.client_secret));
});

// ---------- state ----------

test('state : inconnu, absent, rejoué ou expiré → refusé, rien d’écrit', async () => {
  let now = 1_000_000;
  const store = new StateStore(() => now);
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], store, log: silent });
  const ok = { code: 'abc123', scope: 'read,activity:read_all' };

  for (const params of [{ ...ok, state: 'inventé' }, ok]) {
    const { back } = await callback(routes, params);
    assert.equal(back.search, '?strava=refus&raison=lien');
  }

  // Rejoué : le premier passage consomme le state
  const { state } = connect(routes);
  assert.equal((await callback(routes, { ...ok, state })).back.search, '?strava=ok');
  rmSync(secretFile('strava-tokens.json'));
  assert.equal((await callback(routes, { ...ok, state })).back.search, '?strava=refus&raison=lien');

  // Expiré
  const late = connect(routes).state;
  now += STATE_TTL_MS + 1;
  assert.equal((await callback(routes, { ...ok, state: late })).back.search, '?strava=refus&raison=lien');

  assert.equal(calls.length, 1, 'un seul échange de code, celui du state valide');
  assert.equal(existsSync(secretFile('strava-tokens.json')), false);
});

test('state : un refus sur Strava consomme le state sans échange', async () => {
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  const { state } = connect(routes);
  const { back } = await callback(routes, { state, error: 'access_denied' });
  assert.equal(back.search, '?strava=refus&raison=annule');
  assert.equal((await callback(routes, { state, code: 'abc', scope: 'read,activity:read_all' })).back.search, '?strava=refus&raison=lien');
  assert.equal(calls.length, 0);
});

test('state : sans accès aux activités, refusé sans échange', async () => {
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  const { state } = connect(routes);
  assert.equal((await callback(routes, { state, code: 'abc', scope: 'read' })).back.search, '?strava=refus&raison=portee');
  assert.equal(calls.length, 0);
});

// ---------- échange du code ----------

test('échange : POST /oauth/token, jetons écrits avec le scope accordé, jamais renvoyés', async () => {
  mkdirSync(raw, { recursive: true });
  writeFileSync(join(raw, 'sync-state.json'), JSON.stringify({ strava: { reauthSince: '2026-10-01T00:00:00Z', lastError: 'x' }, coros: { lastSuccess: 'y' } }));
  let connected = 0;
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log, onConnected: () => connected++ });
  const { state } = connect(routes);
  const { res, back } = await callback(routes, { state, code: 'abc123', scope: 'read,activity:read' });

  assert.equal(back.pathname, '/aujourdhui');
  assert.equal(back.search, '?strava=ok&raison=public');
  assert.equal(connected, 1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.strava.com/oauth/token');
  assert.equal(calls[0].init.method, 'POST');
  const sent = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
  assert.deepEqual(sent, { client_id: '12345', client_secret: CLIENT.client_secret, code: 'abc123', grant_type: 'authorization_code' });

  const tokens = readSecretFile('strava-tokens.json');
  assert.equal(tokens.access_token, 'ACCESS-SECRET');
  assert.equal(tokens.refresh_token, 'REFRESH-SECRET');
  assert.equal(tokens.scope, 'read,activity:read');
  assert.equal(tokens.athleteId, 777);
  assert.equal(tokens.athleteName, 'Jo');
  assert.equal(tokens.expires_at, 2_000_000_000_000);

  // Rien des jetons dans la réponse ni le journal
  const out = JSON.stringify(res) + lines.join('\n');
  for (const secret of ['ACCESS-SECRET', 'REFRESH-SECRET', 'abc123', CLIENT.client_secret]) assert.ok(!out.includes(secret), secret);

  // Pause de ré-autorisation levée, le reste de l'état intact
  const st = JSON.parse(readFileSync(join(raw, 'sync-state.json'), 'utf8'));
  assert.deepEqual(st, { strava: { lastError: 'x' }, coros: { lastSuccess: 'y' } });

  // GET /api/sync : présence et athlète seulement
  const status = stravaStatus();
  assert.deepEqual(status, { stravaClient: true, stravaConnected: true, stravaAthlete: 'Jo, athlète 777' });
  assert.ok(!JSON.stringify(status).includes('SECRET'));
});

test('échange : refus de Strava → aucun jeton, raison renvoyée', async () => {
  reply = () => new Response(JSON.stringify({ message: 'Bad Request', errors: [{ code: 'invalid' }] }), { status: 400 });
  try {
    const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
    const { state } = connect(routes);
    const { back } = await callback(routes, { state, code: 'abc123', scope: 'read,activity:read_all' });
    assert.equal(back.search, '?strava=refus&raison=echange');
    assert.equal(existsSync(secretFile('strava-tokens.json')), false);
    assert.deepEqual(stravaStatus(), { stravaClient: true, stravaConnected: false, stravaAthlete: null });
  } finally {
    reply = () => new Response(JSON.stringify({ ...TOKENS, athlete: { id: 777, firstname: 'Jo' } }), { status: 200 });
  }
});

// ---------- appli Strava de l'athlète ----------

test('appli : validation stricte, secret jamais renvoyé, changement d’appli → jetons effacés', () => {
  assert.deepEqual(validateStravaClient({ client_id: ' 98765 ', client_secret: 'B'.repeat(40) }), { client_id: '98765', client_secret: 'B'.repeat(40) });
  assert.deepEqual(validateStravaClient({ client_id: 98765, client_secret: 'b'.repeat(40) }).client_id, '98765');
  for (const bad of [null, [], { client_id: 'abc', client_secret: 'b'.repeat(40) }, { client_id: '1', client_secret: 'court' },
    { client_id: '1', client_secret: 'b'.repeat(40), autre: 1 }, { client_id: '1', client_secret: `${'b'.repeat(39)};` }])
    assert.throws(() => validateStravaClient(bad), InvalidEntry, JSON.stringify(bad));

  const routes = stravaConnectRoutes({ raw, origins: [ORIGIN], log: silent });
  writeFileSync(secretFile('strava-tokens.json'), JSON.stringify(TOKENS));
  // Même appli, nouveau secret : jetons gardés
  let out = routes.saveClient({ client_id: '12345', client_secret: 'c'.repeat(40) });
  assert.equal(readSecretFile('strava-client.json').client_secret, 'c'.repeat(40));
  assert.ok(existsSync(secretFile('strava-tokens.json')));
  assert.ok(!JSON.stringify(out).includes('c'.repeat(40)));
  // Autre appli : les jetons de l'ancienne sont inutilisables
  out = routes.saveClient({ client_id: '555', client_secret: 'd'.repeat(40) });
  assert.equal(existsSync(secretFile('strava-tokens.json')), false);
  assert.deepEqual(out, { stravaClient: true, stravaConnected: false, stravaAthlete: null });
});
