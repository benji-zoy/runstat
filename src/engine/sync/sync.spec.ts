// Synchro des sources par le moteur (NAS et appareil), fetch bouchonné : COROS (activités, détails, forme, charge, FIT),
// listes blanches, rotation du jeton, renouvellement sérialisé ou refusé (appareil secondaire), pause « ré-autorisation »,
// Strava (activités, streams, limite de débit), Google Health par un point de jeton injecté (relais).
import { MemoryStore } from '../storage/memory.ts';
import { corosClient } from './coros.ts';
import { stravaClient } from './strava.ts';
import { googleClient } from './google.ts';
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
});
