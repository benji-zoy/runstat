// Comptes et autorisation (accounts.mjs, app.mjs, queue.mjs, migrate-users.sh) : identité selon la zone d'écoute,
// cloisonnement des comptes (A ne lit ni n'écrit rien de B), administration, file des runs, environnement des runs,
// migration de l'instance mono-utilisateur. Dossiers temporaires, vrai serveur HTTP sur un port libre, runs factices.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidEntry } from './entries.mjs';
import { accountsLoader, resolveUser, runEnv, userPaths, validateUsers } from './accounts.mjs';
import { createApp } from './app.mjs';
import { RunQueue, jobs } from './queue.mjs';
import { stravaConnectRoutes } from './strava-connect.mjs';
import { oauthConnectRoutes } from './oauth-connect.mjs';
import { AuthStore } from './auth-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const USERS = [
  { id: 'alice', name: 'Alice', role: 'owner', mode: 'hosted', logins: ['alice@exemple.fr'] },
  { id: 'bob', name: 'Bob', role: 'member', mode: 'hosted', logins: ['Bob@Exemple.fr'] },
  { id: 'carol', name: 'Carol', role: 'member', mode: 'local', logins: ['carol@exemple.fr'] },
];
const silent = { log() {}, warn() {}, error() {} };
const ATHLETE = { hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

// ---------- liste des comptes ----------

test('comptes : validation (propriétaire unique, identifiants, logins uniques sans casse)', () => {
  const ok = validateUsers(USERS);
  assert.deepEqual(ok[1].logins, ['bob@exemple.fr']);
  const bad = (list, re) => assert.throws(() => validateUsers(list), (e) => e instanceof InvalidEntry && re.test(e.message), re.source);
  bad([{ ...USERS[0] }, { ...USERS[1], role: 'owner' }], /un et un seul propriétaire/);
  bad([USERS[1]], /un et un seul propriétaire/);
  bad([USERS[0], { ...USERS[1], id: 'alice' }], /en double/);
  bad([USERS[0], { ...USERS[1], id: 'auth' }], /identifiant/);
  bad([USERS[0], { ...USERS[1], id: '../x' }], /identifiant/);
  bad([USERS[0], { ...USERS[1], logins: ['ALICE@exemple.fr'] }], /déjà pris/);
  bad([USERS[0], { ...USERS[1], logins: ['pas un login'] }], /login Tailscale invalide/);
  bad([USERS[0], { ...USERS[1], admin: true }], /champ inconnu/);
  bad([{ ...USERS[0], mode: 'local' }], /propriétaire est en mode hébergé/);
  bad('x', /liste/);
});

test('identité : la zone fait foi, jamais un en-tête du réseau local', () => {
  const acc = { multi: true, dir: '/x', users: validateUsers(USERS) };
  const spoof = { 'tailscale-user-login': 'bob@exemple.fr' };
  assert.equal(resolveUser(acc, 'lan', spoof).user.id, 'alice');
  assert.equal(resolveUser(acc, 'lan', spoof).admin, false);
  assert.equal(resolveUser(acc, 'tailnet', { 'tailscale-user-login': 'BOB@exemple.fr ' }).user.id, 'bob');
  assert.equal(resolveUser(acc, 'tailnet', { 'tailscale-user-login': 'alice@exemple.fr' }).admin, true);
  assert.equal(resolveUser(acc, 'tailnet', {}).status, 403);
  assert.equal(resolveUser(acc, 'tailnet', { 'tailscale-user-login': 'eve@exemple.fr' }).status, 403);
  assert.equal(resolveUser(acc, 'tailnet', { 'tailscale-user-login': 'carol@exemple.fr' }).status, 403);
  assert.equal(resolveUser(acc, 'public', spoof).status, 403);
  // Mono-utilisateur : le seul compte, quelle que soit la zone
  const single = accountsLoader('/nulle/part', { raw: 'r', snapshot: 's', secrets: 'k' })();
  assert.equal(single.multi, false);
  assert.deepEqual(userPaths(single, resolveUser(single, 'tailnet', spoof).user), { raw: 'r', snapshot: 's', secrets: 'k' });
});

test('environnement des runs : liste blanche et dossiers du compte', () => {
  const env = runEnv({ raw: '/u/bob/data-raw', snapshot: '/u/bob/snapshot', secrets: '/u/bob/secrets' }, '/u', {
    PATH: '/bin', TZ: 'Europe/Paris', SYNC_FIT_PER_RUN: '5', RUNSTAT_SECRETS: '/secrets', RUNSTAT_RAW: '/autre', GITHUB_TOKEN: 'x',
  });
  assert.deepEqual(env, {
    PATH: '/bin', TZ: 'Europe/Paris', SYNC_FIT_PER_RUN: '5',
    RUNSTAT_USERS: '/u', RUNSTAT_RAW: '/u/bob/data-raw', RUNSTAT_SNAPSHOT: '/u/bob/snapshot', RUNSTAT_SECRETS: '/u/bob/secrets',
  });
});

test('instance à comptes : un run sans dossiers explicites échoue au lieu de prendre les données du propriétaire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runstat-users-'));
  try {
    writeFileSync(join(dir, 'users.json'), JSON.stringify(USERS));
    const env = { PATH: process.env.PATH, RUNSTAT_USERS: dir };
    for (const script of ['scripts/build-data.mjs', 'scripts/fetch-weather.mjs', 'scripts/sync/run.mjs']) {
      const r = spawnSync(process.execPath, [join(repo, script), '--rebuild'], { env, encoding: 'utf8', cwd: repo });
      assert.notEqual(r.status, 0, script);
      assert.match(r.stderr, /RUNSTAT_(RAW|SNAPSHOT) absent/, script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- file des runs ----------

test('file : un seul run à la fois, ordre d’arrivée, une tâche de chaque sorte par compte', async () => {
  const started = [];
  let running = 0;
  let max = 0;
  const release = [];
  const q = new RunQueue({
    start: (user, job) => {
      started.push(`${user}:${job.kind}`);
      max = Math.max(max, ++running);
      return new Promise((r) => release.push(() => (running--, r(0))));
    },
  });
  assert.equal(q.enqueue('a', jobs.full('x')), 'started');
  assert.equal(q.enqueue('b', jobs.rebuild()), 'queued');
  assert.equal(q.enqueue('a', jobs.rebuild()), 'queued');
  assert.equal(q.enqueue('a', jobs.rebuild()), 'duplicate');
  // La synchro complète remplace la reconstruction en attente
  assert.equal(q.enqueue('a', jobs.full('y')), 'queued');
  assert.equal(q.enqueue('a', jobs.rebuild()), 'duplicate');
  assert.equal(q.enqueue('a', jobs.fit('1')), 'queued');
  assert.equal(q.enqueue('a', jobs.fit('1')), 'duplicate');
  assert.equal(q.enqueue('a', jobs.fit('2')), 'busy');
  assert.deepEqual(q.status('a'), { ...q.status('a'), running: true, queued: true, kind: 'full' });
  assert.equal(q.status('b').running, false);
  while (release.length || q.current) {
    await new Promise((r) => setTimeout(r, 5));
    release.shift()?.();
  }
  await q.idle();
  assert.equal(max, 1);
  assert.deepEqual(started, ['a:full', 'b:rebuild', 'a:full', 'a:fit']);
});

// ---------- API : cloisonnement des comptes ----------

let usersDir;
let calls;
let servers;
const base = {};

function startApp(zone, accounts, queue, extra = {}) {
  const origins = ['https://nas.tailxxxx.ts.net'];
  const strava = stravaConnectRoutes({ origins, log: silent });
  const oauth = oauthConnectRoutes({ origins, log: silent });
  const server = createServer(createApp({ zone, accounts, queue, strava, oauth, log: silent, quotaBytes: 50_000, ...extra }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  usersDir = mkdtempSync(join(tmpdir(), 'runstat-users-'));
  writeFileSync(join(usersDir, 'users.json'), JSON.stringify(USERS));
  const accounts = accountsLoader(usersDir, null);
  for (const id of ['alice', 'bob']) {
    const p = userPaths(accounts(), { id });
    mkdirSync(p.raw, { recursive: true });
    mkdirSync(p.snapshot, { recursive: true });
    writeFileSync(join(p.snapshot, 'coros.json'), JSON.stringify({ owner: id }));
  }
  const queue = new RunQueue({ start: (user, job) => (calls.push({ user, kind: job.kind, args: job.args }), 0) });
  servers = { lan: await startApp('lan', accounts, queue), tailnet: await startApp('tailnet', accounts, queue) };
  for (const [zone, s] of Object.entries(servers)) base[zone] = `http://127.0.0.1:${s.address().port}`;
});

after(() => {
  for (const s of Object.values(servers ?? {})) s.close();
  rmSync(usersDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

/** Requête sur une zone, pour un login Tailscale (zone tailnet) */
function api(zone, path, { login, method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (login) h['Tailscale-User-Login'] = login;
  if (method !== 'GET') h['X-RunStat'] = h['X-RunStat'] ?? 'sync';
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return fetch(`${base[zone]}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const raw = (id, file) => join(usersDir, id, 'data-raw', file);
const json = async (res) => ({ status: res.status, body: await res.json() });
const idle = () => new Promise((r) => setTimeout(r, 30));

test('API : chacun lit son instantané, jamais celui d’un autre', async () => {
  assert.deepEqual((await json(await api('tailnet', '/api/data/coros.json', { login: 'bob@exemple.fr' }))).body, { owner: 'bob' });
  assert.deepEqual((await json(await api('tailnet', '/api/data/coros.json', { login: 'alice@exemple.fr' }))).body, { owner: 'alice' });
  // Réseau local : le propriétaire, même avec un en-tête d'identité forgé
  assert.deepEqual((await json(await api('lan', '/api/data/coros.json', { login: 'bob@exemple.fr' }))).body, { owner: 'alice' });
  assert.equal((await api('tailnet', '/api/data/coros.json')).status, 403);
  assert.equal((await api('tailnet', '/api/data/coros.json', { login: 'eve@exemple.fr' })).status, 403);
  assert.equal((await api('tailnet', '/api/data/../users.json', { login: 'bob@exemple.fr' })).status, 404);
  assert.equal((await api('tailnet', '/api/data/routes.json', { login: 'bob@exemple.fr' })).status, 404);
  // Requête conditionnelle
  const first = await api('tailnet', '/api/data/coros.json', { login: 'bob@exemple.fr' });
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const etag = first.headers.get('etag');
  assert.equal((await api('tailnet', '/api/data/coros.json', { login: 'bob@exemple.fr', headers: { 'If-None-Match': etag } })).status, 304);
});

test('API : la saisie de B n’écrit que chez B, et sa reconstruction est la sienne', async () => {
  const goals = [{ id: 'semi-b', name: 'Semi', date: '2027-04-04', distanceKm: 21.0975, kind: 'road' }];
  const put = await api('tailnet', '/api/goals', { login: 'bob@exemple.fr', method: 'PUT', body: goals });
  assert.equal(put.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(raw('bob', 'goals.json'), 'utf8'))[0].id, 'semi-b');
  assert.equal(existsSync(raw('alice', 'goals.json')), false);
  assert.deepEqual((await json(await api('tailnet', '/api/goals', { login: 'alice@exemple.fr' }))).body, []);
  assert.equal((await json(await api('lan', '/api/goals', { login: 'bob@exemple.fr' }))).body.length, 0);
  await idle();
  assert.deepEqual(calls, [{ user: 'bob', kind: 'rebuild', args: ['--rebuild'] }]);

  // Réseau local avec en-tête forgé : écrit chez le propriétaire
  assert.equal((await api('lan', '/api/athlete', { login: 'bob@exemple.fr', method: 'PUT', body: ATHLETE })).status, 200);
  assert.ok(existsSync(raw('alice', 'athlete.json')));
  assert.equal(existsSync(raw('bob', 'athlete.json')), false);

  // Classement
  const result = { event: '10 km', source: 'https://example.org', rank: 3, finishers: 10 };
  assert.equal((await api('tailnet', '/api/results/123', { login: 'bob@exemple.fr', method: 'PUT', body: result })).status, 200);
  assert.ok(existsSync(join(usersDir, 'bob', 'data-raw', 'results', '123.json')));
  assert.equal((await api('tailnet', '/api/results/123', { login: 'alice@exemple.fr', method: 'DELETE' })).status, 404);
  assert.ok(existsSync(join(usersDir, 'bob', 'data-raw', 'results', '123.json')));
});

test('API : synchro, tracé et appli Strava rangés chez le compte de la requête', async () => {
  assert.equal((await api('tailnet', '/api/sync', { login: 'bob@exemple.fr', method: 'POST' })).status, 202);
  assert.equal((await api('tailnet', '/api/fit?id=42', { login: 'bob@exemple.fr', method: 'POST' })).status, 202);
  await idle();
  assert.deepEqual(calls.map((c) => `${c.user}:${c.kind}`), ['bob:full', 'bob:fit']);
  const st = (await json(await api('tailnet', '/api/sync', { login: 'bob@exemple.fr' }))).body;
  assert.equal(st.stravaClient, false);
  assert.ok(Array.isArray(st.log));

  const client = { client_id: '12345', client_secret: 'a'.repeat(40) };
  assert.equal((await api('tailnet', '/api/strava/client', { login: 'bob@exemple.fr', method: 'PUT', body: client })).status, 200);
  assert.ok(existsSync(join(usersDir, 'bob', 'secrets', 'strava-client.json')));
  assert.equal(existsSync(join(usersDir, 'alice', 'secrets', 'strava-client.json')), false);
  assert.equal((statSync(join(usersDir, 'bob', 'secrets', 'strava-client.json')).mode & 0o777).toString(8), '600');
  assert.equal((await json(await api('tailnet', '/api/sync', { login: 'bob@exemple.fr' }))).body.stravaClient, true);
  assert.equal((await json(await api('tailnet', '/api/sync', { login: 'alice@exemple.fr' }))).body.stravaClient, false);
});

test('API : gardes (en-tête du site, compte local-first, route inconnue, quota)', async () => {
  assert.equal((await api('tailnet', '/api/goals', { login: 'bob@exemple.fr', method: 'PUT', body: [], headers: { 'X-RunStat': '' } })).status, 403);
  assert.equal((await api('tailnet', '/api/goals', { login: 'carol@exemple.fr' })).status, 403);
  assert.equal((await api('tailnet', '/api/autre', { login: 'bob@exemple.fr' })).status, 404);
  assert.equal((await api('tailnet', '/pas-api', { login: 'bob@exemple.fr' })).status, 404);
  // Connexions : compte obligatoire, navigations GET seulement
  assert.equal((await api('tailnet', '/api/coros/connect')).status, 403);
  assert.equal((await api('tailnet', '/api/google/connect', { login: 'bob@exemple.fr', method: 'POST' })).status, 405);
  const nav = await fetch(`${base.tailnet}/api/coros/connect`, { redirect: 'manual', headers: { 'Tailscale-User-Login': 'bob@exemple.fr', Host: 'evil.example' } });
  assert.equal(nav.status, 302);
  assert.equal(nav.headers.get('location'), '/aujourdhui?coros=refus&raison=origine');
  // Compte plein (quota de 50 ko dans ce test) : nouvelle instance, taille mesurée après l'ajout du gros fichier
  writeFileSync(raw('bob', 'gros.bin'), Buffer.alloc(60_000));
  const accounts = accountsLoader(usersDir, null);
  const fresh = await startApp('tailnet', accounts, new RunQueue({ start: () => 0 }));
  try {
    const res = await fetch(`http://127.0.0.1:${fresh.address().port}/api/athlete`, {
      method: 'PUT',
      headers: { 'Tailscale-User-Login': 'bob@exemple.fr', 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
      body: JSON.stringify(ATHLETE),
    });
    assert.equal(res.status, 507);
    assert.equal(existsSync(raw('bob', 'athlete.json')), false);
  } finally {
    fresh.close();
    rmSync(raw('bob', 'gros.bin'));
  }
});

test('API : /api/me et administration réservée au propriétaire par le tailnet', async () => {
  assert.deepEqual((await json(await api('tailnet', '/api/me', { login: 'bob@exemple.fr' }))).body,
    { id: 'bob', name: 'Bob', role: 'member', mode: 'hosted', multi: true, admin: false });
  assert.equal((await json(await api('lan', '/api/me'))).body.admin, false);
  assert.equal((await api('lan', '/api/admin/users')).status, 403);
  assert.equal((await api('tailnet', '/api/admin/users', { login: 'bob@exemple.fr' })).status, 403);
  assert.equal((await api('tailnet', '/api/admin/users', { login: 'bob@exemple.fr', method: 'PUT', body: USERS })).status, 403);
  const list = (await json(await api('tailnet', '/api/admin/users', { login: 'alice@exemple.fr' }))).body;
  assert.equal(list.length, 3);

  const owner = { login: 'alice@exemple.fr', method: 'PUT' };
  // Le propriétaire ne peut ni se retirer, ni perdre le login de sa requête, ni céder son rôle par erreur
  assert.equal((await api('tailnet', '/api/admin/users', { ...owner, body: USERS.slice(1) })).status, 400);
  assert.equal((await api('tailnet', '/api/admin/users', { ...owner, body: [{ ...USERS[0], logins: ['autre@exemple.fr'] }, ...USERS.slice(1)] })).status, 400);
  assert.equal((await api('tailnet', '/api/admin/users', { ...owner, body: [{ ...USERS[0], role: 'member' }, { ...USERS[1], role: 'owner' }] })).status, 400);

  const dave = { id: 'dave', name: 'Dave', role: 'member', mode: 'hosted', logins: ['dave@exemple.fr'] };
  const saved = await api('tailnet', '/api/admin/users', { ...owner, body: [...USERS, dave] });
  assert.equal(saved.status, 200);
  assert.ok(existsSync(join(usersDir, 'dave', 'data-raw')));
  assert.equal((statSync(join(usersDir, 'dave', 'secrets')).mode & 0o777).toString(8), '700');
  // Droits explicites (ACL de DSM) : dossiers 755, users.json 644
  assert.equal((statSync(join(usersDir, 'dave')).mode & 0o777).toString(8), '755');
  assert.equal((statSync(join(usersDir, 'dave', 'data-raw')).mode & 0o777).toString(8), '755');
  assert.equal((statSync(join(usersDir, 'users.json')).mode & 0o777).toString(8), '644');
  assert.equal((await json(await api('tailnet', '/api/me', { login: 'dave@exemple.fr' }))).body.id, 'dave');
  // Retiré : plus d'accès (ses données restent sur le disque)
  assert.equal((await api('tailnet', '/api/admin/users', { ...owner, body: USERS })).status, 200);
  assert.equal((await api('tailnet', '/api/me', { login: 'dave@exemple.fr' })).status, 403);
});

test('API : invitation d’un proche local-first et réinitialisation, propriétaire par le tailnet seulement', async () => {
  const owner = { login: 'alice@exemple.fr', method: 'POST' };
  // Sans accès public configuré
  assert.equal((await api('tailnet', '/api/admin/invitations', { ...owner, body: { id: 'erin', name: 'Erin' } })).status, 503);
  const fresh = await startApp('tailnet', accountsLoader(usersDir, null), new RunQueue({ start: () => 0 }), {
    appUrl: 'https://app.example/runstat/', publicUrl: 'https://nas.tailxxxx.ts.net:8443',
  });
  const at = (path, opts) => fetch(`http://127.0.0.1:${fresh.address().port}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Tailscale-User-Login': opts.login, 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  try {
    assert.equal((await at('/api/admin/invitations', { login: 'bob@exemple.fr', method: 'POST', body: { id: 'erin', name: 'Erin' } })).status, 403);
    assert.equal((await api('lan', '/api/admin/invitations', { method: 'POST', body: { id: 'erin', name: 'Erin' } })).status, 403);
    const r = await at('/api/admin/invitations', { ...owner, body: { id: 'erin', name: 'Erin' } });
    assert.equal(r.status, 201);
    const { link } = await r.json();
    const u = new URL(link);
    assert.equal(`${u.origin}${u.pathname}`, 'https://app.example/runstat/rejoindre');
    const frag = new URLSearchParams(u.hash.slice(1));
    assert.equal(frag.get('nas'), 'https://nas.tailxxxx.ts.net:8443');
    const auth = new AuthStore(usersDir);
    assert.equal(auth.findCode(frag.get('code'), 'invite').userId, 'erin');
    const erin = JSON.parse(readFileSync(join(usersDir, 'users.json'), 'utf8')).find((x) => x.id === 'erin');
    assert.deepEqual(erin, { id: 'erin', name: 'Erin', role: 'member', mode: 'local', logins: [] });
    // Compte hébergé : pas d'invitation local-first
    assert.equal((await at('/api/admin/invitations', { ...owner, body: { id: 'bob' } })).status, 400);
    // Réinitialisation : ancien lien caduc, nouveau lien
    const reset = await at('/api/admin/users/erin/reset', owner);
    assert.equal(reset.status, 200);
    assert.equal(auth.findCode(frag.get('code'), 'invite'), null);
    const code2 = new URLSearchParams(new URL((await reset.json()).link).hash.slice(1)).get('code');
    assert.equal(auth.findCode(code2, 'invite').userId, 'erin');
    assert.equal((await at('/api/admin/users/bob/reset', owner)).status, 404);
    // Compte retiré de la liste : plus rien ne vaut
    const list = JSON.parse(readFileSync(join(usersDir, 'users.json'), 'utf8')).filter((x) => x.id !== 'erin');
    assert.equal((await at('/api/admin/users', { login: 'alice@exemple.fr', method: 'PUT', body: list })).status, 200);
    assert.equal(auth.findCode(code2, 'invite'), null);
  } finally {
    fresh.close();
  }
});

// ---------- migration ----------

test('migration : à blanc sans rien toucher, puis déplacement sans perte, idempotente', () => {
  const dest = mkdtempSync(join(tmpdir(), 'runstat-nas-'));
  const script = join(repo, 'scripts/migrate-users.sh');
  try {
    mkdirSync(join(dest, 'data-raw/details'), { recursive: true });
    writeFileSync(join(dest, 'data-raw/records.txt'), 'activités');
    writeFileSync(join(dest, 'data-raw/details/part-1.jsonl'), '{}\n');
    mkdirSync(join(dest, 'html/data'), { recursive: true });
    writeFileSync(join(dest, 'html/data/coros.json'), '{}');
    writeFileSync(join(dest, 'html/index.html'), '<html>');
    mkdirSync(join(dest, 'secrets'));
    writeFileSync(join(dest, 'secrets/coros-tokens.json'), '{"refresh_token":"x"}');
    const run = (...args) => spawnSync('sh', [script, dest, ...args], { encoding: 'utf8' });

    assert.notEqual(run('--owner', 'Alice', '--login', 'a@b.fr').status, 0);
    assert.notEqual(run('--owner', 'alice', '--login', 'pas-un-login').status, 0);
    assert.notEqual(run('--owner', 'alice', '--login', 'a@b.fr', '--name', 'A"B').status, 0);

    const dry = run('--owner', 'alice', '--login', 'Alice@Exemple.fr', '--name', 'Alice');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /À blanc/);
    assert.ok(existsSync(join(dest, 'data-raw/records.txt')) && !existsSync(join(dest, 'users')));

    const done = run('--owner', 'alice', '--login', 'Alice@Exemple.fr', '--name', 'Alice', '--apply');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(readFileSync(join(dest, 'users/alice/data-raw/records.txt'), 'utf8'), 'activités');
    assert.ok(existsSync(join(dest, 'users/alice/data-raw/details/part-1.jsonl')));
    assert.equal(readFileSync(join(dest, 'users/alice/snapshot/coros.json'), 'utf8'), '{}');
    assert.ok(existsSync(join(dest, 'html/index.html')));
    assert.equal(existsSync(join(dest, 'data-raw')), false);
    assert.equal((statSync(join(dest, 'users/alice/secrets')).mode & 0o777).toString(8), '700');
    assert.equal((statSync(join(dest, 'users')).mode & 0o777).toString(8), '755');
    assert.equal((statSync(join(dest, 'users/alice')).mode & 0o777).toString(8), '755');
    assert.equal((statSync(join(dest, 'users/users.json')).mode & 0o777).toString(8), '644');
    assert.equal((statSync(join(dest, 'users/alice/secrets/coros-tokens.json')).mode & 0o777).toString(8), '600');
    // users.json valide pour le service, login en minuscules
    const users = validateUsers(JSON.parse(readFileSync(join(dest, 'users/users.json'), 'utf8')));
    assert.deepEqual(users, [{ id: 'alice', name: 'Alice', role: 'owner', mode: 'hosted', logins: ['alice@exemple.fr'] }]);
    // Sauvegarde complète hors des volumes
    const backup = done.stdout.match(/Sauvegarde : .*\/(migration-[\d-]+)/)[1];
    assert.equal((statSync(join(dest, backup)).mode & 0o777).toString(8), '700');
    assert.equal(readFileSync(join(dest, backup, 'data-raw/records.txt'), 'utf8'), 'activités');
    assert.ok(existsSync(join(dest, backup, 'secrets/coros-tokens.json')));

    const again = run('--owner', 'alice', '--login', 'a@b.fr', '--apply');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Déjà migré/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

// ---------- export et suppression (RGPD) ----------

test('export : zip des données du compte de la requête, sans secrets ni données d’un autre', async () => {
  const { openZip, blobSource } = await import('#engine/archive/zip.ts');
  mkdirSync(join(usersDir, 'bob', 'data-raw', 'fit'), { recursive: true });
  writeFileSync(join(usersDir, 'bob', 'data-raw', 'fit', '7.fit'), 'FIT de Bob');
  mkdirSync(join(usersDir, 'bob', 'secrets'), { recursive: true });
  writeFileSync(join(usersDir, 'bob', 'secrets', 'coros-tokens.json'), '{"refresh_token":"SECRET-BOB"}');
  const res = await api('tailnet', '/api/export', { login: 'bob@exemple.fr' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /runstat-bob-\d{4}-\d{2}-\d{2}\.zip/);
  const blob = new Blob([await res.arrayBuffer()]);
  const zip = await openZip(blobSource(blob));
  const names = zip.entries.map((e) => e.name);
  assert.ok(names.includes('data-raw/fit/7.fit') && names.includes('snapshot/coros.json') && names.includes('LISEZMOI.txt'));
  assert.ok(!names.some((n) => n.includes('secrets') || n.includes('coros-tokens')));
  assert.equal(new TextDecoder().decode(await zip.read(zip.entries.find((e) => e.name === 'snapshot/coros.json'))), '{"owner":"bob"}');
  assert.ok(!new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())).includes('SECRET-BOB'));
  // Le propriétaire n'exporte que ses propres données
  const mine = await openZip(blobSource(new Blob([await (await api('tailnet', '/api/export', { login: 'alice@exemple.fr' })).arrayBuffer()])));
  assert.ok(!mine.entries.some((e) => e.name.includes('7.fit')));
});

test('suppression : un proche hébergé efface son compte, jamais celui d’un autre ni celui du propriétaire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runstat-suppr-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify(USERS));
  const accounts = accountsLoader(dir, null);
  for (const id of ['alice', 'bob']) mkdirSync(userPaths(accounts(), { id }).raw, { recursive: true });
  writeFileSync(join(dir, 'bob', 'data-raw', 'goals.json'), '[]');
  const queue = new RunQueue({ start: () => 0 });
  const zones = { lan: await startApp('lan', accounts, queue), tailnet: await startApp('tailnet', accounts, queue) };
  const del = (zone, login, confirm) =>
    fetch(`http://127.0.0.1:${zones[zone].address().port}/api/account`, {
      method: 'DELETE',
      headers: { 'Tailscale-User-Login': login, 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    });
  try {
    assert.equal((await del('tailnet', 'alice@exemple.fr', 'alice')).status, 403);
    assert.equal((await del('lan', 'bob@exemple.fr', 'bob')).status, 403);
    // Alice ne peut viser Bob : la confirmation doit être son propre identifiant
    assert.equal((await del('tailnet', 'alice@exemple.fr', 'bob')).status, 403);
    assert.equal((await del('tailnet', 'bob@exemple.fr', 'alice')).status, 400);
    assert.ok(existsSync(join(dir, 'bob', 'data-raw', 'goals.json')));
    const ok = await del('tailnet', 'bob@exemple.fr', 'bob');
    assert.equal(ok.status, 200);
    assert.equal(existsSync(join(dir, 'bob')), false);
    assert.ok(existsSync(join(dir, 'alice', 'data-raw')));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')).map((u) => u.id), ['alice', 'carol']);
    // Plus de compte : plus d'accès
    assert.equal((await fetch(`http://127.0.0.1:${zones.tailnet.address().port}/api/me`, { headers: { 'Tailscale-User-Login': 'bob@exemple.fr' } })).status, 403);
  } finally {
    for (const s of Object.values(zones)) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Proches : retirer un proche local-first révoque son accès et met sa sauvegarde en suppression douce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runstat-retrait-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify(USERS));
  mkdirSync(join(dir, 'carol', 'backup', 'manifests'), { recursive: true });
  const accounts = accountsLoader(dir, null);
  const server = await startApp('tailnet', accounts, new RunQueue({ start: () => 0 }));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/users`, {
      method: 'PUT',
      headers: { 'Tailscale-User-Login': 'alice@exemple.fr', 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
      body: JSON.stringify(USERS.filter((u) => u.id !== 'carol')),
    });
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(dir, 'carol', 'backup')), false);
    assert.ok(readdirSync(join(dir, 'carol')).some((f) => f.startsWith('backup-supprimee-')));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
