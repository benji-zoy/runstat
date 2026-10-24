// Synchronisation des sources choisies (sources.json) dans la zone raw, portable : run.mjs sur le NAS (NodeStore, secrets/),
// appli publique dans le navigateur (IndexedDB, jetons chiffrés dans la sauvegarde). Mêmes fichiers des deux côtés :
//   activités COROS : records.txt (fusion par fenêtre), details/part-*.jsonl, fitness.txt, load.txt, fit/<id>.fit ;
//   activités Strava : strava/activities.json, tracks/strava-<id>.json.gz (streams) ;
//   santé : health-api.json (Google Health), health-coros.json (COROS) ;
//   état : sync-state.json (dernier succès, dernière erreur, ré-autorisation), réponses brutes raw/<source>/<type>/ (option).
// La reconstruction (build-fit, snapshot, météo) reste à l'appelant.
import * as pc from '../parsers/coros.ts';
import { DAILY_TYPES, healthFromGoogle, mergeHealth, type HealthData } from '../parsers/google.ts';
import { healthFromCoros } from '../parsers/coros-health.ts';
import { activityFromApi, mergeStravaActivities, type StravaActivity } from '../parsers/strava.ts';
import { STRAVA_FILE } from '../archive/strava-archive.ts';
import { gzip } from '../archive/zip.ts';
import { fileKey, normalizeSources, type Sources } from '../sources.ts';
import { encodeText, readJson, type FileStore } from '../storage/types.ts';
import { fetchRetry, RateLimited, ReauthRequired, type TokenStore } from './http.ts';
import type { CorosClient } from './coros.ts';
import type { StravaClient } from './strava.ts';
import type { GoogleClient } from './google.ts';

export const SYNC_STATE = 'sync-state.json';
export type SourceKey = 'coros' | 'strava' | 'google' | 'corosHealth';

export interface SourceState {
  lastAttempt?: string;
  lastSuccess?: string;
  lastSuccessDate?: string;
  lastSummary?: string;
  lastError?: string;
  lastErrorAt?: string;
  reauthSince?: string;
  fitFailures?: Record<string, number>;
  fitQuotaHitAt?: string;
  streamFailures?: Record<string, number>;
}

export type SyncState = Partial<Record<SourceKey, SourceState>> & Record<string, any>;

export interface SourceClients {
  coros?: CorosClient;
  strava?: StravaClient;
  google?: GoogleClient;
  tokens: TokenStore;
}

export interface SyncOptions {
  /** Ne synchroniser qu'une source (--only) */
  only?: SourceKey | null;
  overlapDays?: number;
  fitPerRun?: number;
  detailsPerRun?: number;
  streamsPerRun?: number;
  /** Conserver les réponses brutes (raw/<source>/…) : sur le NAS, pas sur l'appareil (sauvegarde plus légère) */
  stage?: boolean;
  log?: (...m: unknown[]) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Date du jour (AAAA-MM-JJ), fuseau local */
  today?: () => string;
}

const TOKEN_FILE: Record<SourceKey, string> = {
  coros: 'coros-tokens.json',
  strava: 'strava-tokens.json',
  google: 'google-tokens.json',
  corosHealth: 'coros-tokens.json',
};

const localToday = () => new Date().toLocaleDateString('sv-SE');
export const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const compact = (date: string) => date.replaceAll('-', '');
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Contexte d'une synchro : zone raw, clients, état, options */
export function sourceSync(raw: FileStore, clients: SourceClients, opts: SyncOptions = {}) {
  const {
    overlapDays = 3,
    fitPerRun = 50,
    detailsPerRun = 60,
    streamsPerRun = 40,
    stage: keepRaw = true,
    log = (...m: unknown[]) => console.log(...m),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    today = localToday,
  } = opts;
  // Chargé une fois (loadState) : run.mjs y ajoute ses propres champs (reconstruction, archive) et l'enregistre aussi
  let state: SyncState = {};
  let loaded = false;

  const writeJson = (path: string, value: unknown) => raw.write(path, JSON.stringify(value));
  async function loadState(): Promise<SyncState> {
    if (!loaded) (state = (await readJson<SyncState>(raw, SYNC_STATE)) ?? {}), (loaded = true);
    return state;
  }
  const saveState = () => writeJson(SYNC_STATE, state);
  // Source sans client (Google sans compte sur l'appareil) : comme sans jetons, à connecter dans Réglages
  const need = <T>(c: T | undefined, source: string): T => {
    if (!c) throw new ReauthRequired(source, 'non connecté');
    return c;
  };

  /** Réponse brute conservée pour pouvoir ré-analyser sans re-télécharger */
  async function stage(source: string, type: string, key: string, payload: Record<string, unknown>) {
    if (keepRaw) await writeJson(`raw/${source}/${type}/${key}.json`, { source, type, fetchedAt: new Date().toISOString(), ...payload });
  }

  /**
   * Lance la synchro d'une source. Une erreur d'autorisation la met en pause jusqu'à ce que ses jetons changent
   * (reconnexion) ; toute autre erreur est retentée à la synchro suivante.
   */
  async function runSource(name: SourceKey, fn: (s: SourceState) => Promise<string>): Promise<boolean> {
    const s = (state[name] ??= {});
    if (s.reauthSince) {
      const saved = await clients.tokens.savedAt(TOKEN_FILE[name]);
      if (!(saved != null && saved > Date.parse(s.reauthSince))) {
        log(`${name.toUpperCase()} : en pause, ré-autorisation nécessaire depuis ${s.reauthSince}.`);
        return false;
      }
      delete s.reauthSince;
    }
    s.lastAttempt = new Date().toISOString();
    try {
      const summary = await fn(s);
      s.lastSuccess = s.lastAttempt;
      s.lastSuccessDate = today();
      s.lastSummary = summary;
      delete s.lastError;
      log(`${name.toUpperCase()} : ${summary}`);
      return true;
    } catch (e) {
      s.lastError = (e as Error).message;
      s.lastErrorAt = new Date().toISOString();
      if (e instanceof ReauthRequired) s.reauthSince = s.lastErrorAt;
      log(`${name.toUpperCase()} : ÉCHEC — ${(e as Error).message}`);
      return false;
    } finally {
      await saveState();
    }
  }

  // ---------- COROS ----------

  const readRecordsText = async () => pc.unwrap((await raw.readText('records.txt')) ?? '');

  async function knownDetails(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const f of (await raw.list('details')).filter((f) => f.endsWith('.jsonl'))) {
      for (const line of ((await raw.readText(`details/${f}`)) ?? '').split('\n')) {
        const id = line.match(/"id"\s*:\s*"?(\d+)/)?.[1];
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  async function toolText(name: string, args: Record<string, unknown>) {
    const coros = need(clients.coros, 'coros');
    const result = await coros.callTool(name, args);
    return { text: pc.unwrap(coros.toolText(result)), isError: Boolean(result?.isError) };
  }

  async function syncCoros(s: SourceState): Promise<string> {
    await need(clients.coros, 'coros').initialize();
    const to = today();
    const existing = await readRecordsText();
    const latest = pc.recordBlocks(existing).reduce((m, r) => (r.date && r.date > m ? r.date : m), '');
    const from = addDays([s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(to, -30), -overlapDays);

    // 1. Activités de la fenêtre, fusionnées dans records.txt
    const LIMIT = 200;
    const recArgs = {
      startDate: compact(from),
      endDate: compact(to),
      sportTypeCodes: [100, 101, 102, 103],
      minDistanceKm: 0,
      maxDistanceKm: 1000,
      minDurationMinutes: 0,
      maxDurationMinutes: 10000,
      maxAveragePace: '',
      locationKeyword: '',
      limit: LIMIT,
    };
    const rec = await toolText('querySportRecords', recArgs);
    await stage('coros', 'querySportRecords', to, { args: recArgs, text: rec.text });
    const fetched = pc.recordBlocks(rec.text);
    if (rec.isError || (!fetched.length && !/Sport Records/i.test(rec.text))) {
      throw new Error(`querySportRecords : réponse inattendue « ${rec.text.slice(0, 160)} »`);
    }
    // Sans en-tête reconnu, on n'efface rien : seule une vraie liste vide prouve une suppression
    const truncated = fetched.length >= LIMIT || !/Sport Records/i.test(rec.text);
    const merged = pc.mergeRecords(existing, rec.text, { from, to, truncated });
    await raw.write('records.txt', merged.text);

    // 2. Détails des activités qui n'en ont pas
    const have = await knownDetails();
    const all = pc.recordBlocks(merged.text);
    const missing = all.filter((r) => !have.has(r.id)).slice(0, detailsPerRun);
    let details = 0;
    for (const r of missing) {
      const d = await toolText('getActivityDetail', { labelId: r.id, sportType: r.sportType });
      await stage('coros', 'getActivityDetail', r.id, { args: { labelId: r.id }, text: d.text });
      const detail = pc.parseDetail(r.id, d.text);
      if (d.isError || !pc.isUsableDetail(detail)) {
        log(`  détail inexploitable pour ${r.id} (${r.date}) : « ${d.text.slice(0, 120)} »`);
        continue;
      }
      const part = `details/part-${compact(to)}.jsonl`;
      await raw.write(part, ((await raw.readText(part)) ?? '') + JSON.stringify(detail) + '\n');
      details++;
    }

    // 3. Forme et charge
    const fit = await toolText('queryFitnessAssessmentOverview', {});
    await stage('coros', 'queryFitnessAssessmentOverview', to, { text: fit.text });
    if (/VO2max/i.test(fit.text)) await raw.write('fitness.txt', fit.text + '\n');
    else log(`  forme : réponse inattendue « ${fit.text.slice(0, 120)} »`);

    const load = await toolText('queryTrainingLoadAssessment', { days: 365 });
    await stage('coros', 'queryTrainingLoadAssessment', to, { args: { days: 365 }, text: load.text });
    if (/Load Ratio/i.test(load.text)) await raw.write('load.txt', pc.mergeLoad(await raw.readText('load.txt'), load.text));
    else log(`  charge : réponse inattendue « ${load.text.slice(0, 120)} »`);

    // 4. Fichiers FIT : nouvelles sorties d'abord, puis la file triée par utilité (fit-queue.txt)
    const fits = await syncFits(s, merged, all);

    return [
      `${fetched.length} activités du ${from} au ${to}`,
      merged.added.length && `${merged.added.length} nouvelles`,
      merged.removed.length && `${merged.removed.length} retirées (supprimées dans COROS)`,
      `${details} détails`,
      fits,
    ]
      .filter(Boolean)
      .join(', ');
  }

  async function syncFits(s: SourceState, merged: { added: { id: string }[] }, all: pc.RecordBlock[]): Promise<string> {
    const have = new Set((await raw.list('fit')).map((f) => f.replace(/\.fit$/, '')));
    const byId = new Map(all.map((r) => [r.id, r]));
    const queue = ((await raw.readText('fit-queue.txt')) ?? '')
      .split('\n')
      .map((l) => l.split(' ')[0])
      .filter(Boolean);
    const recent = all.filter((r) => (r.date ?? '') >= addDays(today(), -14)).map((r) => r.id);
    const failed = (s.fitFailures ??= {});
    const order = [...new Set([...merged.added.map((r) => r.id), ...recent, ...queue, ...all.map((r) => r.id)])].filter(
      (id) => byId.has(id) && !have.has(id) && (failed[id] ?? 0) < 3,
    );

    let ok = 0;
    for (const id of order.slice(0, fitPerRun)) {
      const got = await downloadFit(s, byId.get(id)!);
      if (got === 'quota') return `${ok} FIT (quota de 50/jour atteint, reste ${order.length - ok})`;
      if (got !== 'ok') continue;
      ok++;
      await sleep(1000);
    }
    return `${ok} FIT${order.length > ok ? ` (reste ${order.length - ok})` : ''}`;
  }

  /** Télécharge le FIT d'une activité : 'ok' | 'quota' | 'failed' */
  async function downloadFit(s: SourceState, r: pc.RecordBlock): Promise<'ok' | 'quota' | 'failed'> {
    const failed = (s.fitFailures ??= {});
    // Uniquement labelId + sportType : les requêtes par plage de dates déclenchent l'anti-abus
    const res = await toolText('queryActivityFitFileDownloadUrls', { labelId: r.id, sportType: r.sportType });
    if (pc.isFitQuota(res.text)) {
      s.fitQuotaHitAt = new Date().toISOString();
      return 'quota';
    }
    const url = pc.fitUrls(res.text)[0];
    const buf = url ? new Uint8Array(await (await fetchRetry(need(clients.coros, 'coros').fetch, url)).arrayBuffer()) : null;
    if (!buf || !pc.isFitFile(buf)) {
      failed[r.id] = (failed[r.id] ?? 0) + 1;
      log(`  FIT indisponible pour ${r.id} (${r.date}) : « ${res.text.slice(0, 120)} »`);
      return 'failed';
    }
    await raw.write(`fit/${r.id}.fit`, buf);
    delete failed[r.id];
    return 'ok';
  }

  // ---------- Strava (API REST) ----------

  /** Sorties qui ont déjà un tracé (FIT de l'archive ou streams) */
  async function tracked(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const dir of ['fit', 'tracks']) for (const f of await raw.list(dir)) keys.add(f.replace(/\.(fit|gpx|tcx|json)(\.gz)?$/, ''));
    return keys;
  }

  /** Streams d'une sortie → tracks/strava-<id>.json.gz : 'ok' | 'empty' */
  async function downloadStreams(a: StravaActivity): Promise<'ok' | 'empty'> {
    const st = await need(clients.strava, 'strava').streams(a.id.slice('strava:'.length));
    if (!st?.time?.data?.length || !st?.distance?.data?.length) return 'empty';
    await raw.write(`tracks/${fileKey(a.id)}.json.gz`, await gzip(encodeText(JSON.stringify({ start: a.start, ...st }))));
    a.file = 'streams';
    return 'ok';
  }

  async function syncStrava(s: SourceState): Promise<string> {
    const strava = need(clients.strava, 'strava');
    const existing = (await readJson<StravaActivity[]>(raw, STRAVA_FILE)) ?? [];
    const to = today();
    const latest = existing.reduce((m, a) => (a.date > m ? a.date : m), '');
    const from = addDays([s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(to, -30), -overlapDays);
    // Un jour de marge : `after` est un instant UTC, les dates des sorties sont locales
    const after = Math.floor(Date.parse(`${addDays(from, -1)}T00:00:00Z`) / 1000);
    const list = await strava.activitiesSince(after);
    await stage('strava', 'activities', to, { args: { after }, activities: list });
    const fetched = list.map(activityFromApi).filter((a): a is StravaActivity => a != null);
    // Sans activity:read_all, les sorties privées manquent à la réponse : on ne retire rien
    const complete = /activity:read_all/.test((await clients.tokens.read('strava-tokens.json'))?.scope ?? '');
    const merged = mergeStravaActivities(existing, fetched, { window: complete ? { from, to } : null });
    await writeJson(STRAVA_FILE, merged.list);

    // Streams (seconde par seconde) : nouvelles sorties et 14 derniers jours d'abord, puis le reste de l'historique
    const have = await tracked();
    const failed = (s.streamFailures ??= {});
    const recent = addDays(to, -14);
    const todo = [...merged.list]
      .filter((a) => !have.has(fileKey(a.id)) && (failed[a.id] ?? 0) < 3)
      .sort((a, b) => Number(b.date >= recent) - Number(a.date >= recent) || b.date.localeCompare(a.date));
    let ok = 0;
    let limited = '';
    for (const a of todo.slice(0, streamsPerRun)) {
      try {
        if ((await downloadStreams(a)) === 'ok') (ok++, delete failed[a.id]);
        else failed[a.id] = 3; // saisie manuelle, sans capteur : inutile de redemander
      } catch (e) {
        if (e instanceof RateLimited) {
          limited = ' (limite de débit atteinte)';
          break;
        }
        if (e instanceof ReauthRequired) throw e;
        failed[a.id] = (failed[a.id] ?? 0) + 1;
        log(`  streams indisponibles pour ${a.id} (${a.date}) : ${(e as Error).message}`);
      }
      await sleep(500);
    }
    await writeJson(STRAVA_FILE, merged.list);
    const rest = todo.length - ok;
    return [
      `${fetched.length} sorties du ${from} au ${to}`,
      merged.added.length && `${merged.added.length} nouvelles`,
      merged.removed.length && `${merged.removed.length} retirées (supprimées dans Strava)`,
      `${ok} tracés${rest > 0 ? ` (reste ${rest})` : ''}${limited}`,
    ]
      .filter(Boolean)
      .join(', ');
  }

  /** « Affiner avec le tracé » pour une sortie Strava : ses streams */
  async function syncOneStreams(id: string): Promise<string> {
    const list = (await readJson<StravaActivity[]>(raw, STRAVA_FILE)) ?? [];
    const a = list.find((x) => x.id === id);
    if (!a) throw new Error(`activité ${id} inconnue de data-raw/strava`);
    if ((await tracked()).has(fileKey(id))) return `tracé de ${id} déjà présent`;
    try {
      if ((await downloadStreams(a)) !== 'ok') throw new Error(`aucun tracé pour ${id} (saisie manuelle ?)`);
    } catch (e) {
      if (e instanceof RateLimited) throw new Error('limite de débit Strava atteinte, réessaie dans un quart d’heure');
      if (e instanceof ReauthRequired) (state.strava ??= {}).reauthSince = new Date().toISOString();
      throw e;
    }
    await writeJson(STRAVA_FILE, list);
    return `tracé de ${id} (${a.date}) téléchargé`;
  }

  // ---------- santé COROS ----------

  async function syncCorosHealth(s: SourceState): Promise<string> {
    await need(clients.coros, 'coros').initialize();
    const existing = await readJson<HealthData & { days: Record<string, unknown> }>(raw, 'health-coros.json');
    const latest = Object.keys(existing?.days ?? {}).sort().at(-1);
    const to = today();
    // Premier passage : un an d'historique ; ensuite la dernière date connue moins le recouvrement
    const from = latest ? addDays([s.lastSuccessDate, latest].filter((x): x is string => Boolean(x)).sort()[0], -overlapDays) : addDays(to, -365);
    const days = daysBetween(from, to) + 1;
    const daily = await toolText('queryDailyHealthData', { days });
    const rhr = await toolText('queryRestingHeartRate', { days });
    if (daily.isError || rhr.isError) throw new Error(`santé COROS : « ${(daily.isError ? daily : rhr).text.slice(0, 160)} »`);
    // VFC : 7 jours au plus par appel
    const hrv: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 7)) {
      const end = [addDays(d, 6), to].sort()[0];
      const r = await toolText('querySleepHrv', { startDate: compact(d), endDate: compact(end), days: 7 });
      if (!r.isError) hrv.push(r.text);
    }
    await stage('coros', 'health', to, { args: { from, days }, daily: daily.text, rhr: rhr.text, hrv });
    const health = healthFromCoros({ daily: [daily.text], hrv, rhr: [rhr.text] });
    await writeJson('health-coros.json', mergeHealth(existing, health, new Date().toISOString()));
    const list = Object.values(health.days);
    const count = (k: string) => list.filter((d) => (d as Record<string, unknown>)[k] != null).length;
    return `${list.length} jours du ${from}, ${count('sleepMin')} nuits, ${count('hrv')} VFC, ${count('rhr')} FC de repos`;
  }

  // ---------- Google Health ----------

  async function syncGoogle(s: SourceState): Promise<string> {
    const google = need(clients.google, 'google');
    const existing = await readJson<HealthData>(raw, 'health-api.json');
    const takeout = await readJson<HealthData>(raw, 'health.json');
    const latest = [...Object.keys(existing?.days ?? {}), ...Object.keys(takeout?.days ?? {})].sort().at(-1);
    const to = addDays(today(), 1);
    const from = addDays([s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(today(), -30), -overlapDays);

    const filters: Record<string, string> = Object.fromEntries(
      DAILY_TYPES.map((t) => {
        const f = google.filterField(t);
        return [t, `${f}.date >= "${from}" AND ${f}.date < "${to}"`];
      }),
    );
    filters['sleep'] = `sleep.interval.end_time >= "${from}T00:00:00Z"`;
    filters['weight'] = `weight.sample_time.physical_time >= "${from}T00:00:00Z"`;

    const points: Record<string, any[]> = {};
    const errors: string[] = [];
    for (const [type, filter] of Object.entries(filters)) {
      try {
        points[type] = await google.dataPoints(type, filter);
        await stage('google', type, today(), { filter, dataPoints: points[type] });
      } catch (e) {
        if (e instanceof ReauthRequired) throw e;
        errors.push((e as Error).message);
      }
    }
    const health = healthFromGoogle(points);
    await writeJson('health-api.json', mergeHealth(existing, health, new Date().toISOString()));
    const nights = Object.values(health.days).filter((d) => d.sleepMin != null).length;
    const summary = `${Object.keys(health.days).length} jours du ${from}, ${nights} nuits, ${health.weight.length} pesées`;
    if (errors.length) throw new Error(`${summary} ; échecs : ${errors.join(' | ')}`);
    return summary;
  }

  // ---------- points d'entrée ----------

  /** Toutes les sources choisies, l'une après l'autre ; renvoie les sources choisies et l'état final */
  async function syncAll(): Promise<{ sources: Sources; state: SyncState }> {
    await loadState();
    const sources = normalizeSources((await readJson(raw, 'sources.json')) ?? {});
    const want = (name: SourceKey) => !opts.only || opts.only === name;
    log(`Synchronisation (activités ${sources.activities}, santé ${sources.health})…`);
    if (sources.activities === 'coros' && want('coros')) await runSource('coros', syncCoros);
    if (sources.activities === 'strava' && want('strava')) await runSource('strava', syncStrava);
    if (sources.health === 'google' && want('google')) await runSource('google', syncGoogle);
    if (sources.health === 'coros' && want('corosHealth')) await runSource('corosHealth', syncCorosHealth);
    return { sources, state };
  }

  /**
   * Bouton « Affiner avec le tracé » : le FIT (COROS) ou les streams (Strava) d'une seule sortie. Ne touche pas à la date de
   * dernière synchro. Erreur dans state.lastFitError.
   */
  async function syncOne(id: string): Promise<{ ok: boolean; message: string }> {
    await loadState();
    try {
      let message: string;
      if (id.startsWith('strava:')) message = await syncOneStreams(id);
      else {
        const s = (state.coros ??= {});
        const r = pc.recordBlocks(await readRecordsText()).find((x) => x.id === id);
        if (!r) throw new Error(`activité ${id} inconnue de records.txt`);
        if ((await raw.read(`fit/${id}.fit`)) != null) message = `FIT de ${id} déjà présent`;
        else {
          await need(clients.coros, 'coros').initialize();
          const got = await downloadFit(s, r);
          if (got === 'quota') throw new Error('quota de 50 FIT par jour atteint, réessaie demain');
          if (got !== 'ok') throw new Error(`FIT indisponible pour ${id}`);
          message = `FIT de ${id} (${r.date}) téléchargé`;
        }
      }
      delete state['lastFitError'];
      log(message);
      return { ok: true, message };
    } catch (e) {
      state['lastFitError'] = `${id} : ${(e as Error).message}`;
      if (e instanceof ReauthRequired && !id.startsWith('strava:')) (state.coros ??= {}).reauthSince = new Date().toISOString();
      log(`FIT : ÉCHEC — ${(e as Error).message}`);
      return { ok: false, message: (e as Error).message };
    } finally {
      await saveState();
    }
  }

  return { syncAll, syncOne, loadState, saveState };
}
