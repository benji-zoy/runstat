// Synchro des sources par le moteur (NAS et appareil), fetch bouchonné : COROS (activités, détails, forme, charge, FIT),
// listes blanches, rotation du jeton, renouvellement sérialisé ou refusé (appareil secondaire), pause « ré-autorisation »,
// Strava (activités, streams, limite de débit), Google Health par un point de jeton injecté (relais), Garmin (clé
// personnelle, FIT dans un zip, santé, clé refusée puis remplacée, limite de débit).
import { MemoryStore } from '../storage/memory.ts';
import { zipStream } from '../archive/zip-writer.ts';
import { corosClient } from './coros.ts';
import { stravaClient } from './strava.ts';
import { googleClient } from './google.ts';
import { GARMIN_KEY_FILE, GARMIN_TOKEN_PATH, garminClient, validateGarminKey } from './garmin.ts';
import { fileTokenStore, type Fetch, type TokenStore } from './http.ts';
import { sourceSync } from './run-sources.ts';

const MCP = 'https://mcpeu.coros.com/mcp';
const TOKEN = 'https://mcpeu.coros.com/oauth/token';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const RECORDS = [
  'Sport Records — 2026-03-01 to 2026-03-10 (2 records)',
  '========================',
  '',
  '1. Outdoor Run — 2026-03-09',
  '   Time Window: startTimestamp=1773046800 | endTimestamp=1773050400',
  '   Duration: 1:00:00 | Distance: 12.00 km',
  '   LabelId: 200001 | SportType: 100',
  '',
  '2. Outdoor Run — 2026-03-07',
  '   Time Window: startTimestamp=1772874000 | endTimestamp=1772877600',
  '   Duration: 50:00 | Distance: 10.00 km',
  '   LabelId: 200002 | SportType: 100',
].join('\n');
const FIT = (() => {
  const b = new Uint8Array(32);
  b.set([...'.FIT'].map((c) => c.charCodeAt(0)), 8);
  return b;
})();

/** Serveur COROS simulé : métadonnées OAuth, jeton (rotation du refresh token), MCP JSON-RPC, hôte des FIT */
function fakeCoros({ quota = false } = {}) {
  const calls: string[] = [];
  let refreshes = 0;
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return json({ authorization_endpoint: 'https://mcpeu.coros.com/oauth/authorize', token_endpoint: TOKEN, registration_endpoint: 'https://mcpeu.coros.com/oauth/register' });
    if (url === TOKEN) {
      const p = new URLSearchParams(String(init?.body));
      calls.push(`token:${p.get('grant_type')}:${p.get('refresh_token')}`);
      refreshes++;
      return json({ access_token: `acc-${refreshes}`, refresh_token: `ref-${refreshes}`, expires_in: 3600 });
    }
    if (url.startsWith('https://s3eu.coros.com/')) return new Response(FIT);
    if (url === MCP) {
      const auth = new Headers(init?.headers).get('authorization');
      const msg = JSON.parse(String(init?.body));
      if (!msg.id) return new Response(null, { status: 202 });
      calls.push(msg.method === 'tools/call' ? msg.params.name : msg.method);
      if (auth === 'Bearer revoked') return new Response('', { status: 401 });
      const text = (t: string) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(t) }] } });
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
      switch (msg.params.name) {
        case 'querySportRecords':
          return text(RECORDS);
        case 'getActivityDetail':
          return text('Training Load: 80\nAverage Cadence: 172 spm\nElevation Gain / Loss: 40 m / 38 m');
        case 'queryFitnessAssessmentOverview':
          return text('Fitness Assessment Overview\n\nVO2max: 54');
        case 'queryTrainingLoadAssessment':
          return text('Training Load Assessment\n\n2026-03-09\nShort-Term Load: 60\nLong-Term Load: 55\nLoad Ratio: 1.09');
        case 'queryActivityFitFileDownloadUrls':
          return text(quota ? 'You have reached the daily limit of 50 FIT downloads' : `https://s3eu.coros.com/fit/${msg.params.arguments.labelId}.fit`);
      }
      return text('?');
    }
    throw new Error(`requête inattendue ${url}`);
  };
  return { fetch, calls };
}

async function tokenStore(store: MemoryStore, { expired = false, access = 'acc-0' } = {}) {
  const tokens = fileTokenStore(store);
  await tokens.write('coros-client.json', { issuer: 'https://mcpeu.coros.com', client_id: 'cid', redirect: 'x', registeredAt: '' });
  await tokens.write('coros-tokens.json', { access_token: access, refresh_token: 'ref-0', expires_at: expired ? 0 : Date.now() + 3_600_000 });
  return tokens;
}

const quiet = { log: () => {}, sleep: async () => {}, today: () => '2026-03-10' };

const GARMIN_KEY = 'cle-personnelle-garmin-0123456789';
const b64url = (s: string) => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (n: number) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400, n }))}.sig`;

async function zipped(name: string, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for await (const p of zipStream([{ path: name, data }])) parts.push(p);
  return new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

/** Serveur Garmin simulé : jeton contre la clé, liste des sorties, fichiers d'origine (zip), santé */
function fakeGarmin({ limitFitAfter = Infinity, expireFirstBearer = false } = {}) {
  const calls: string[] = [];
  let issued = 0;
  let fits = 0;
  let expired = !expireFirstBearer;
  const activity = (id: number, day: string, typeKey = 'running', eventKey = 'uncategorized') => ({
    activityId: id, activityName: `Sortie ${id}`, startTimeLocal: `${day} 07:30:00`, beginTimestamp: Date.parse(`${day}T06:30:00Z`),
    activityType: { typeKey }, eventType: { typeKey: eventKey }, distance: 10000, duration: 3000, movingDuration: 2990, averageHR: 150,
  });
  const has = (a: string, b: string) => a <= '2026-03-09' && '2026-03-09' <= b;
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (url.pathname === GARMIN_TOKEN_PATH) {
      calls.push('token');
      if (init?.method !== 'POST' || auth !== `ApiKey ${GARMIN_KEY}`) return new Response('', { status: 401 });
      return new Response(jwt(++issued));
    }
    calls.push(url.pathname);
    if (!auth.startsWith('Bearer ')) return new Response('', { status: 401 });
    // Premier jeton refusé une fois (révoqué entre-temps) : le client doit en redemander un
    if (!expired) return (expired = true), new Response('', { status: 401 });
    const q = url.searchParams;
    const range = url.pathname.match(/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
    const [a, b] = range ? [range[1], range[2]] : [q.get('startDate') ?? '', q.get('endDate') ?? ''];
    switch (true) {
      case url.pathname === '/activitylist-service/activities/search/activities':
        return json([activity(1, '2026-03-09'), activity(2, '2026-03-08', 'trail_running', 'race'), activity(3, '2026-03-07', 'running')]);
      case url.pathname.startsWith('/download-service/files/activity/'):
        if (++fits > limitFitAfter) return new Response('', { status: 429 });
        return url.pathname.endsWith('/3') ? new Response('', { status: 404 }) : new Response(await zipped(`${url.pathname.split('/').at(-1)}_ACTIVITY.fit`, FIT), { headers: { 'content-type': 'application/x-zip-compressed' } });
      case url.pathname === '/sleep-service/sleep/dailySleepSummariesByDate':
        return json(has(a, b) ? [{ calendarDate: '2026-03-09', sleepTimeSeconds: 27000, deepSleepSeconds: 5400 }] : []);
      case url.pathname.startsWith('/hrv-service/hrv/daily/'):
        return has(a, b) ? json({ hrvSummaries: [{ calendarDate: '2026-03-09', lastNightAvg: 62 }] }) : new Response(null, { status: 204 });
      case url.pathname === '/usersummary-service/v2/dailysummaries':
        return json({ data: has(a, b) ? [{ calendarDate: '2026-03-09', heartRate: { restingValue: 47 } }] : [] });
      case url.pathname.startsWith('/weight-service/weight/range/'):
        return json({ dailyWeightSummaries: has(a, b) ? [{ summaryDate: '2026-03-09', latestWeight: { weight: 70.4 } }] : [] });
    }
    throw new Error(`requête inattendue ${url}`);
  };
  return { fetch, calls };
}

async function garminStore(sources = '{"activities":"garmin","health":"garmin"}', key = GARMIN_KEY) {
  const raw = new MemoryStore({ 'sources.json': sources });
  const tokens = fileTokenStore(raw);
  await tokens.write(GARMIN_KEY_FILE, { apiKey: key, days: 365, savedOn: '2026-03-01' });
  return { raw, tokens };
}

describe('synchro des sources', () => {
  it('COROS : activités, détails, forme, charge et FIT dans la zone raw, état enregistré', async () => {
    const raw = new MemoryStore({ 'sources.json': '{"activities":"coros","health":"none"}' });
    const tokens = await tokenStore(raw);
    const server = fakeCoros();
    const coros = corosClient({ tokens, fetch: server.fetch });
    const { state } = await sourceSync(raw, { coros, tokens }, { ...quiet, stage: false }).syncAll();
    expect(await raw.readText('records.txt')).toContain('LabelId: 200001');
    const details = (await raw.readText('details/part-20260310.jsonl'))!.trim().split('\n').map((l) => JSON.parse(l));
    expect(details.map((d) => d.id).sort()).toEqual(['200001', '200002']);
    expect(await raw.readText('fitness.txt')).toContain('VO2max: 54');
    expect(await raw.readText('load.txt')).toContain('Load Ratio: 1.09');
    expect((await raw.list('fit')).sort()).toEqual(['200001.fit', '200002.fit']);
    expect(state.coros?.lastSummary).toMatch(/2 activités du .* 2 détails, 2 FIT/);
    expect(JSON.parse((await raw.readText('sync-state.json'))!).coros.lastSuccessDate).toBe('2026-03-10');
    // stage: false (appareil) : pas de réponses brutes
    expect((await raw.keys()).some((k) => k.startsWith('raw/'))).toBe(false);
  });

  it('COROS : quota FIT atteint, la synchro réussit quand même', async () => {
    const raw = new MemoryStore();
    const tokens = await tokenStore(raw);
    const coros = corosClient({ tokens, fetch: fakeCoros({ quota: true }).fetch });
    const { state } = await sourceSync(raw, { coros, tokens }, quiet).syncAll();
    expect(state.coros?.lastSummary).toContain('quota de 50/jour atteint');
    expect(state.coros?.fitQuotaHitAt).toBeTruthy();
    // stage par défaut (NAS) : réponses brutes conservées
    expect(await raw.readText('raw/coros/querySportRecords/2026-03-10.json')).toContain('200001');
  });

  it('listes blanches : outil COROS d’écriture et chemin Strava hors liste refusés avant tout envoi', async () => {
    const raw = new MemoryStore();
    const tokens = await tokenStore(raw);
    let sent = 0;
    const fetch: Fetch = async () => (sent++, json({}));
    await expect(corosClient({ tokens, fetch }).callTool('createSingleWorkout', {})).rejects.toThrow(/non autorisé/);
    await expect(stravaClient({ tokens, fetch }).get('/athlete')).rejects.toThrow(/non autorisé/);
    expect(sent).toBe(0);
  });

  it('jeton expiré : renouvelé une seule fois pour deux appels simultanés, nouveau refresh token gardé', async () => {
    const raw = new MemoryStore();
    const base = await tokenStore(raw, { expired: true });
    let chain = Promise.resolve();
    let guarded = 0;
    // Verrou comme navigator.locks : un renouvellement à la fois, relecture des jetons une fois le verrou pris
    const tokens: TokenStore = {
      ...base,
      refresh: <T>(_: string, fn: () => Promise<T>) => {
        guarded++;
        const run = chain.then(fn);
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
    };
    const server = fakeCoros();
    const coros = corosClient({ tokens, fetch: server.fetch });
    await Promise.all([coros.callTool('queryFitnessAssessmentOverview'), coros.callTool('queryTrainingLoadAssessment', { days: 7 })]);
    expect(server.calls.filter((c) => c.startsWith('token:'))).toEqual(['token:refresh_token:ref-0']);
    expect(guarded).toBe(2);
    const saved = await base.read('coros-tokens.json');
    expect(saved).toMatchObject({ access_token: 'acc-1', refresh_token: 'ref-1' });
  });

  it('appareil secondaire : renouvellement refusé, aucun appel au serveur de jetons, jetons intacts', async () => {
    const raw = new MemoryStore({ 'sources.json': '{"activities":"coros","health":"none"}' });
    const base = await tokenStore(raw, { expired: true });
    const tokens: TokenStore = {
      ...base,
      refresh: async () => {
        throw new Error('synchro réservée à l’appareil principal');
      },
    };
    const server = fakeCoros();
    const coros = corosClient({ tokens, fetch: server.fetch });
    const { state } = await sourceSync(raw, { coros, tokens }, quiet).syncAll();
    expect(state.coros?.lastError).toMatch(/appareil principal/);
    expect(state.coros?.reauthSince).toBeUndefined();
    expect(server.calls.some((c) => c.startsWith('token:'))).toBe(false);
    expect(await base.read('coros-tokens.json')).toMatchObject({ refresh_token: 'ref-0' });
  });

  it('jeton refusé : pause jusqu’à la reconnexion, puis reprise', async () => {
    const raw = new MemoryStore({ 'sources.json': '{"activities":"coros","health":"none"}' });
    const tokens = await tokenStore(raw, { access: 'revoked' });
    const server = fakeCoros();
    const coros = corosClient({ tokens, fetch: server.fetch });
    const first = await sourceSync(raw, { coros, tokens }, quiet).syncAll();
    expect(first.state.coros?.reauthSince).toBeTruthy();
    const before = server.calls.length;
    const paused = await sourceSync(raw, { coros, tokens }, quiet).syncAll();
    expect(server.calls.length).toBe(before);
    expect(paused.state.coros?.reauthSince).toBeTruthy();
    // Reconnexion : nouveaux jetons écrits après la mise en pause
    await new Promise((r) => setTimeout(r, 5));
    await tokens.write('coros-tokens.json', { access_token: 'acc-new', refresh_token: 'ref-new', expires_at: Date.now() + 3_600_000 });
    const resumed = await sourceSync(raw, { coros, tokens }, quiet).syncAll();
    expect(resumed.state.coros?.reauthSince).toBeUndefined();
    expect(resumed.state.coros?.lastSuccess).toBeTruthy();
  });

  it('Strava : activités fusionnées, streams compressés, arrêt propre à la limite de débit', async () => {
    const raw = new MemoryStore({ 'sources.json': '{"activities":"strava","health":"none"}' });
    const tokens = fileTokenStore(raw);
    await tokens.write('strava-client.json', { client_id: '123', client_secret: 's'.repeat(40) });
    await tokens.write('strava-tokens.json', { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000, scope: 'read,activity:read_all' });
    const run = (id: number, day: string) => ({ id, type: 'Run', sport_type: 'Run', start_date: `${day}T07:00:00Z`, start_date_local: `${day}T08:00:00Z`, distance: 10000, moving_time: 3000, name: 'Sortie' });
    let streamCalls = 0;
    const fetch: Fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v3/athlete/activities') return json([run(11, '2026-03-09'), run(12, '2026-03-08'), { ...run(13, '2026-03-07'), type: 'Ride', sport_type: 'Ride' }]);
      if (url.pathname.endsWith('/streams')) {
        streamCalls++;
        if (streamCalls >= 2) return json({}, 429);
        return json({ time: { data: [0, 1, 2] }, distance: { data: [0, 3, 6] } });
      }
      throw new Error(`inattendu ${url}`);
    };
    const strava = stravaClient({ tokens, fetch });
    const { state } = await sourceSync(raw, { strava, tokens }, quiet).syncAll();
    const list = JSON.parse((await raw.readText('strava/activities.json'))!);
    expect(list.map((a: { id: string }) => a.id).sort()).toEqual(['strava:11', 'strava:12']);
    expect(await raw.list('tracks')).toEqual(['strava-11.json.gz']);
    expect(state.strava?.lastSummary).toMatch(/2 sorties .* 1 tracés \(reste 1\) \(limite de débit atteinte\)/);
  });

  it('Google Health : jeton renouvelé par le point injecté (relais), sans secret côté appareil', async () => {
    const raw = new MemoryStore({ 'sources.json': '{"activities":"strava","health":"google"}' });
    const tokens = fileTokenStore(raw);
    await tokens.write('google-tokens.json', { access_token: 'old', refresh_token: 'g-ref', expires_at: 0 });
    const relayed: Record<string, string>[] = [];
    const google = googleClient({
      tokens,
      token: async (params) => (relayed.push(params), { status: 200, body: { access_token: 'g-acc', expires_in: 3600 } }),
      fetch: async (input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer g-acc');
        const type = String(input).match(/dataTypes\/([^/]+)\//)![1];
        return json(type === 'daily-resting-heart-rate' ? { dataPoints: [{ dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 9 }, beatsPerMinute: 48 } }] } : { dataPoints: [] });
      },
    });
    const { state } = await sourceSync(raw, { google, tokens }, { ...quiet, only: 'google' }).syncAll();
    expect(relayed).toEqual([{ grant_type: 'refresh_token', refresh_token: 'g-ref' }]);
    expect(state.google?.lastError).toBeUndefined();
    expect(await tokens.read('google-tokens.json')).toMatchObject({ access_token: 'g-acc', refresh_token: 'g-ref' });
    expect(await raw.readText('health-api.json')).toBeTruthy();
  });

  it('« Affiner avec le tracé » : FIT d’une sortie COROS connue, erreur notée pour une inconnue', async () => {
    const raw = new MemoryStore({ 'records.txt': RECORDS });
    const tokens = await tokenStore(raw);
    const coros = corosClient({ tokens, fetch: fakeCoros().fetch });
    const sync = sourceSync(raw, { coros, tokens }, quiet);
    expect((await sync.syncOne('200002')).ok).toBe(true);
    expect(await raw.read('fit/200002.fit')).toEqual(FIT);
    expect((await sync.syncOne('999')).ok).toBe(false);
    expect((await sync.loadState())['lastFitError']).toMatch(/999 : activité 999 inconnue/);
  });
  it('Garmin : sorties, FIT extraits des zips, santé ; un seul jeton pour toute la synchro', async () => {
    const { raw, tokens } = await garminStore();
    const server = fakeGarmin();
    const garmin = garminClient({ tokens, fetch: server.fetch });
    const { state } = await sourceSync(raw, { garmin, tokens }, { ...quiet, stage: false }).syncAll();
    const list = JSON.parse((await raw.readText('garmin/activities.json'))!);
    expect(list.map((a: { id: string }) => a.id)).toEqual(['garmin:3', 'garmin:2', 'garmin:1']);
    expect(list.find((a: { id: string }) => a.id === 'garmin:2')).toMatchObject({ sportType: 102, race: true, file: 'fit' });
    expect((await raw.list('fit')).sort()).toEqual(['garmin-1.fit', 'garmin-2.fit']);
    expect(await raw.read('fit/garmin-1.fit')).toEqual(FIT);
    const health = JSON.parse((await raw.readText('health-garmin.json'))!);
    expect(health.days['2026-03-09']).toMatchObject({ sleepMain: 450, deepMin: 90, hrv: 62, rhr: 47 });
    expect(health.weight).toEqual([{ date: '2026-03-09', kg: 70.4 }]);
    expect(state.garmin?.lastSummary).toMatch(/^3 sorties du 2000-01-01 au 2026-03-10, 3 nouvelles, 2 FIT$/);
    expect(state.garminHealth?.lastSummary).toMatch(/1 nuits, 1 VFC, 1 FC de repos, 1 pesées/);
    expect(server.calls.filter((c) => c === 'token')).toHaveLength(1);
    // Une sortie sans fichier (404) n'est plus redemandée
    expect(state.garmin?.fitFailures).toEqual({ 'garmin:3': 3 });
    expect(await raw.list('raw')).toEqual([]);
  });

  it('Garmin : clé refusée → pause sans appel, reprise avec une nouvelle clé', async () => {
    const { raw, tokens } = await garminStore('{"activities":"garmin","health":"none"}', 'cle-expiree-garmin-000000000000');
    const server = fakeGarmin();
    const garmin = garminClient({ tokens, fetch: server.fetch });
    const first = await sourceSync(raw, { garmin, tokens }, quiet).syncAll();
    expect(first.state.garmin?.reauthSince).toBeTruthy();
    expect(first.state.garmin?.lastError).toMatch(/garmin \(clé refusée ou expirée\)/);
    server.calls.length = 0;
    await sourceSync(raw, { garmin, tokens }, quiet).syncAll();
    expect(server.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    await tokens.write(GARMIN_KEY_FILE, { apiKey: GARMIN_KEY, days: 90, savedOn: '2026-03-10' });
    const third = await sourceSync(raw, { garmin, tokens }, quiet).syncAll();
    expect(third.state.garmin?.reauthSince).toBeUndefined();
    expect(third.state.garmin?.lastSummary).toMatch(/3 sorties/);
  });

  it('Garmin : jeton refusé par l’API → un seul nouveau jeton ; arrêt propre à la limite de débit', async () => {
    const { raw, tokens } = await garminStore('{"activities":"garmin","health":"none"}');
    const server = fakeGarmin({ limitFitAfter: 1, expireFirstBearer: true });
    const garmin = garminClient({ tokens, fetch: server.fetch });
    const { state } = await sourceSync(raw, { garmin, tokens }, quiet).syncAll();
    expect(server.calls.filter((c) => c === 'token')).toHaveLength(2);
    expect(state.garmin?.lastSummary).toMatch(/1 FIT \(reste 2\) \(limite de débit atteinte\)/);
  });

  it('Garmin : rien hors de la liste blanche, « Affiner » télécharge le FIT d’une sortie', async () => {
    const { raw, tokens } = await garminStore();
    const server = fakeGarmin();
    const garmin = garminClient({ tokens, fetch: server.fetch });
    await expect(garmin.json('/userprofile-service/userprofile/settings')).rejects.toThrow(/non autorisée/);
    await expect(garmin.json('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: '2026-03-01', endDate: '2026-03-02', foo: 'bar' })).rejects.toThrow(/non autorisée/);
    expect(server.calls).toEqual([]);
    await raw.write('garmin/activities.json', JSON.stringify([{ id: 'garmin:2', sportType: 102, name: 'x', date: '2026-03-08', start: 1, durationSec: 1, distanceKm: 1 }]));
    const sync = sourceSync(raw, { garmin, tokens }, quiet);
    expect(await sync.syncOne('garmin:2')).toEqual({ ok: true, message: 'FIT de garmin:2 (2026-03-08) téléchargé' });
    expect(await raw.read('fit/garmin-2.fit')).toEqual(FIT);
    expect((await sync.syncOne('garmin:9')).ok).toBe(false);
    expect((await sync.loadState()).coros).toBeUndefined();
  });

  it('Garmin : validation de la clé saisie', () => {
    expect(validateGarminKey({ apiKey: `  ${GARMIN_KEY} `, days: '365' }, '2026-03-10')).toEqual({ apiKey: GARMIN_KEY, days: 365, savedOn: '2026-03-10' });
    expect(() => validateGarminKey({ apiKey: 'court', days: 365 })).toThrow(/Clé/);
    expect(() => validateGarminKey({ apiKey: GARMIN_KEY, days: 7 })).toThrow(/Durée/);
    expect(() => validateGarminKey({ apiKey: GARMIN_KEY, days: 30, extra: 1 })).toThrow(/champ inconnu/);
  });
});
