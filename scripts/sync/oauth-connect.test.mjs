// Tests de la connexion COROS et Google depuis le site (oauth-connect.mjs, avec les vrais coros.mjs et google-health.mjs) :
// liste blanche des origines, PKCE, state lié au compte, client COROS écrit seulement avec ses jetons, client Google du
// propriétaire pour un proche, rien des jetons dans les réponses. fetch bouchonné, dossiers temporaires.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectStatus, oauthConnectRoutes } from './oauth-connect.mjs';

const ORIGIN = 'https://nas.tail1234.ts.net';
const HEADERS = { 'x-forwarded-host': 'nas.tail1234.ts.net', 'x-forwarded-proto': 'https' };
const ISSUER = 'https://mcpeu.coros.com';
const silent = { log() {}, warn() {}, error() {} };
const root = mkdtempSync(join(tmpdir(), 'runstat-oauth-'));
const GOOGLE = { web: { client_id: 'g-123.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-du-proprio' } };

/** Comptes : alice (propriétaire, client Google) et bob (proche, sans client) */
function account(id) {
  const base = join(root, id);
  const user = { id, raw: join(base, 'data-raw'), secrets: join(base, 'secrets'), googleClientFile: join(root, 'alice', 'secrets', 'google-client.json'), connected: [] };
  user.onConnected = (s) => user.connected.push(s);
  return user;
}
let alice;
let bob;

let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u === `${ISSUER}/.well-known/oauth-authorization-server`)
    return json({ authorization_endpoint: `${ISSUER}/oauth2/authorize`, token_endpoint: `${ISSUER}/oauth2/token`, registration_endpoint: `${ISSUER}/connect/register` });
  if (u === `${ISSUER}/connect/register`) return json({ client_id: `client-${calls.length}` }, 201);
  if (u === `${ISSUER}/oauth2/token`) return json({ access_token: 'COROS-ACCESS', refresh_token: 'COROS-REFRESH', expires_in: 3600, scope: 'openid mcp.tools offline_access' });
  if (u === 'https://oauth2.googleapis.com/token') {
    const sent = Object.fromEntries(new URLSearchParams(String(init.body)));
    return sent.code === 'sans-refresh' ? json({ access_token: 'G-ACCESS' }) : json({ access_token: 'G-ACCESS', refresh_token: 'G-REFRESH', expires_in: 3600, scope: 'sleep' });
  }
  return json({ error: 'inattendu' }, 500);
};
after(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  rmSync(root, { recursive: true, force: true });
  alice = account('alice');
  bob = account('bob');
  for (const u of [alice, bob]) mkdirSync(u.raw, { recursive: true }), mkdirSync(u.secrets, { recursive: true });
  writeFileSync(join(alice.secrets, 'google-client.json'), JSON.stringify(GOOGLE));
});

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headers = {}) => Object.assign(res, { status, headers });
  res.end = (b = '') => (res.body += b);
  return res;
}
async function go(routes, path, user, { headers = HEADERS, query = '' } = {}) {
  const res = fakeRes();
  await routes.handle(path, user, { headers }, res, new URL(`http://runstat${path}${query ? `?${query}` : ''}`));
  assert.equal(res.status, 302);
  return { res, to: new URL(res.headers.Location, ORIGIN) };
}
const secret = (u, name) => join(u.secrets, name);
const sha = (v) => createHash('sha256').update(v).digest('base64url');
const sent = (c) => Object.fromEntries(new URLSearchParams(String(c.init.body)));

// ---------- COROS ----------

test('COROS : hôte hors liste refusé, sans appel à COROS', async () => {
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  const { to } = await go(routes, '/api/coros/connect', alice, { headers: { host: 'evil.example' } });
  assert.equal(to.pathname + to.search, '/aujourdhui?coros=refus&raison=origine');
  assert.equal(calls.length, 0);
});

test('COROS : client enregistré pour l’adresse du site, PKCE, rien écrit avant le retour', async () => {
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  const { to } = await go(routes, '/api/coros/connect', alice);
  assert.equal(`${to.origin}${to.pathname}`, `${ISSUER}/oauth2/authorize`);
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/api/coros/callback`);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('resource'), `${ISSUER}/mcp`);
  const register = calls.find((c) => c.url.endsWith('/connect/register'));
  assert.deepEqual(JSON.parse(register.init.body).redirect_uris, [`${ORIGIN}/api/coros/callback`]);
  assert.equal(to.searchParams.get('client_id'), 'client-2');
  // Anciens client et jetons intacts tant que la connexion n'a pas abouti
  assert.equal(existsSync(secret(alice, 'coros-client.json')), false);
});

test('COROS : retour chez un autre compte → rien d’écrit ; bon compte → client et jetons du compte, pause levée, synchro', async () => {
  writeFileSync(join(alice.raw, 'sync-state.json'), JSON.stringify({ coros: { reauthSince: 'x', lastError: 'e' }, corosHealth: { reauthSince: 'x' }, google: { reauthSince: 'y' } }));
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  const { to } = await go(routes, '/api/coros/connect', alice);
  const state = to.searchParams.get('state');
  const challenge = to.searchParams.get('code_challenge');

  const stolen = await go(routes, '/api/coros/callback', bob, { query: `state=${state}&code=abc` });
  assert.equal(stolen.to.search, '?coros=refus&raison=compte');
  assert.equal(existsSync(secret(bob, 'coros-tokens.json')), false);
  assert.equal(existsSync(secret(alice, 'coros-tokens.json')), false);

  // State consommé par la tentative : il faut recommencer
  const again = await go(routes, '/api/coros/connect', alice);
  calls = [];
  const ok = await go(routes, '/api/coros/callback', alice, { query: `state=${again.to.searchParams.get('state')}&code=abc-123` });
  assert.equal(ok.to.search, '?coros=ok');
  const token = calls.find((c) => c.url.endsWith('/oauth2/token'));
  const body = sent(token);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.redirect_uri, `${ORIGIN}/api/coros/callback`);
  assert.equal(sha(body.code_verifier), again.to.searchParams.get('code_challenge'));
  assert.notEqual(challenge, again.to.searchParams.get('code_challenge'));
  const client = JSON.parse(readFileSync(secret(alice, 'coros-client.json'), 'utf8'));
  assert.equal(client.redirect, `${ORIGIN}/api/coros/callback`);
  assert.equal(client.client_id, body.client_id);
  assert.equal(JSON.parse(readFileSync(secret(alice, 'coros-tokens.json'), 'utf8')).refresh_token, 'COROS-REFRESH');
  assert.equal(existsSync(secret(bob, 'coros-tokens.json')), false);
  const st = JSON.parse(readFileSync(join(alice.raw, 'sync-state.json'), 'utf8'));
  assert.deepEqual(st, { coros: { lastError: 'e' }, corosHealth: {}, google: { reauthSince: 'y' } });
  assert.deepEqual(alice.connected, ['coros']);
  assert.ok(!JSON.stringify(ok.res).includes('COROS-'));

  // Reconnexion : le client du compte (même adresse de retour) est réutilisé
  calls = [];
  await go(routes, '/api/coros/connect', alice);
  assert.equal(calls.filter((c) => c.url.endsWith('/connect/register')).length, 0);
});

test('COROS : state inconnu, d’une autre source ou refus sur COROS → aucun échange', async () => {
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  assert.equal((await go(routes, '/api/coros/callback', alice, { query: 'state=invente&code=a' })).to.search, '?coros=refus&raison=lien');
  const g = (await go(routes, '/api/google/connect', alice)).to.searchParams.get('state');
  assert.equal((await go(routes, '/api/coros/callback', alice, { query: `state=${g}&code=a` })).to.search, '?coros=refus&raison=lien');
  const c = (await go(routes, '/api/coros/connect', alice)).to.searchParams.get('state');
  calls = [];
  assert.equal((await go(routes, '/api/coros/callback', alice, { query: `state=${c}&error=access_denied` })).to.search, '?coros=refus&raison=annule');
  assert.equal(calls.length, 0);
});

// ---------- Google ----------

test('Google : un proche passe par le client du propriétaire, ses jetons restent chez lui', async () => {
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  const { to } = await go(routes, '/api/google/connect', bob);
  assert.equal(`${to.origin}${to.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('client_id'), GOOGLE.web.client_id);
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/api/google/callback`);
  assert.equal(to.searchParams.get('access_type'), 'offline');
  assert.ok(!to.toString().includes(GOOGLE.web.client_secret));
  const ok = await go(routes, '/api/google/callback', bob, { query: `state=${to.searchParams.get('state')}&code=4/0Ab-cd_e` });
  assert.equal(ok.to.search, '?google=ok');
  const body = sent(calls.at(-1));
  assert.equal(body.client_secret, GOOGLE.web.client_secret);
  assert.equal(sha(body.code_verifier), to.searchParams.get('code_challenge'));
  assert.equal(JSON.parse(readFileSync(secret(bob, 'google-tokens.json'), 'utf8')).refresh_token, 'G-REFRESH');
  assert.equal(existsSync(secret(alice, 'google-tokens.json')), false);
  assert.equal(existsSync(secret(bob, 'google-client.json')), false, 'le secret du propriétaire n’est pas recopié');
  assert.deepEqual(bob.connected, ['google']);
  assert.deepEqual(connectStatus(bob.secrets, bob.googleClientFile), { corosConnected: false, googleConnected: true, googleClient: true });
  assert.ok(!JSON.stringify(connectStatus(bob.secrets, bob.googleClientFile)).includes('G-'));
});

test('Google : sans client sur le NAS, ou sans refresh token → refusé, rien d’écrit', async () => {
  const routes = oauthConnectRoutes({ origins: [ORIGIN], log: silent });
  const { to } = await go(routes, '/api/google/connect', alice);
  const noRefresh = await go(routes, '/api/google/callback', alice, { query: `state=${to.searchParams.get('state')}&code=sans-refresh` });
  assert.equal(noRefresh.to.search, '?google=refus&raison=echange');
  assert.equal(existsSync(secret(alice, 'google-tokens.json')), false);
  rmSync(secret(alice, 'google-client.json'));
  assert.equal((await go(routes, '/api/google/connect', bob)).to.search, '?google=refus&raison=appli');
  assert.equal(connectStatus(bob.secrets, bob.googleClientFile).googleClient, false);
});
