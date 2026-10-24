// Une synchronisation des sources choisies (data-raw/sources.json, scripts/sync/sources.mjs) :
//   activités : COROS (activités, détails, forme, charge, FIT) ou Strava (API REST : activités, streams) ;
//   santé : Google Health, COROS (sommeil, VFC, FC de repos) ou aucune ;
// puis reconstruction des données du site (build-fit, build-data, file FIT, météo).
// Lancé en boucle par le conteneur runstat-sync (deploy/docker-compose.yml), ou à la main :
//   node scripts/sync/run.mjs [--only coros|strava|google|corosHealth] [--no-build]
//   node scripts/sync/run.mjs --fit <id>        (tracé d'une seule sortie, bouton « Affiner avec le tracé », puis build-fit + build-data)
//   node scripts/sync/run.mjs --rebuild         (sans les sources : reconstruction après une saisie depuis le site)
//   node scripts/sync/run.mjs --import-strava <zip>  (archive Strava envoyée depuis le site, supprimée après import)
// Réponses brutes : data-raw/raw/<source>/<type>/… ; état : data-raw/sync-state.json.
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import * as coros from './coros.mjs';
import * as google from './google-health.mjs';
import { secretsDir, readSecret, ReauthRequired } from './secrets.mjs';
import { rawDir } from '../paths.mjs';
import { fetchRetry } from './retry.mjs';
import * as pc from '#engine/parsers/coros.ts';
import { DAILY_TYPES, healthFromGoogle, mergeHealth } from '#engine/parsers/google.ts';
import { healthFromCoros } from '#engine/parsers/coros-health.ts';
import * as strava from './strava.mjs';
import { activityFromApi, mergeStravaActivities } from '#engine/parsers/strava.ts';
import { importStravaArchive, stravaFile } from './strava-archive.mjs';
import { ACTIVITY_ID, fileKey, readSources } from './sources.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Données de l'utilisateur du run (RUNSTAT_RAW posé par server.mjs, sinon data-raw/ du dépôt)
const raw = rawDir();
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const fitOnly = args.includes('--fit') ? args[args.indexOf('--fit') + 1] : null;
const rebuildOnly = args.includes('--rebuild');
const archive = args.includes('--import-strava') ? args[args.indexOf('--import-strava') + 1] : null;
if (fitOnly !== null && !ACTIVITY_ID.test(fitOnly ?? '')) {
  console.error('Usage : --fit <labelId COROS | strava:<id>>');
  process.exit(1);
}
const sources = readSources(raw);
const OVERLAP_DAYS = Number(process.env.SYNC_OVERLAP_DAYS ?? 3);
const FIT_PER_RUN = Number(process.env.SYNC_FIT_PER_RUN ?? 50);
const DETAILS_PER_RUN = 60;
const STREAMS_PER_RUN = Number(process.env.SYNC_STREAMS_PER_RUN ?? 40);

// ---------- utilitaires ----------

const log = (...m) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...m);
const today = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, fuseau du conteneur (TZ)
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const compact = (date) => date.replaceAll('-', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

/** Réponse brute conservée pour pouvoir ré-analyser sans re-télécharger */
function stage(source, type, key, payload) {
  writeJson(join(raw, 'raw', source, type, `${key}.json`), {
    source,
    type,
    fetchedAt: new Date().toISOString(),
    ...payload,
  });
}

const stateFile = join(raw, 'sync-state.json');
const state = readJson(stateFile, {});
const saveState = () => writeJson(stateFile, state);

/** Un seul run à la fois (boucle du conteneur + lancement manuel) */
const lockFile = join(raw, '.sync.lock');
if (existsSync(lockFile) && Date.now() - statSync(lockFile).mtimeMs < 3_600_000) {
  log('Synchro déjà en cours (data-raw/.sync.lock), abandon.');
  process.exit(0);
}
writeFileSync(lockFile, String(process.pid));

/**
 * Lance la synchro d'une source. Une erreur d'autorisation la met en pause jusqu'à ce que son
 * fichier de tokens change (npm run auth) ; toute autre erreur est retentée au prochain run.
 */
async function runSource(name, tokenFile, fn, auth = name) {
  const s = (state[name] ??= {});
  const tokens = join(secretsDir(), tokenFile);
  if (s.reauthSince) {
    const changed = existsSync(tokens) && statSync(tokens).mtimeMs > Date.parse(s.reauthSince);
    if (!changed) {
      log(
        `${name.toUpperCase()} : en pause, ré-autorisation nécessaire depuis ${s.reauthSince} (npm run auth -- ${auth}).`,
      );
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
    s.lastError = e.message;
    s.lastErrorAt = new Date().toISOString();
    if (e instanceof ReauthRequired) s.reauthSince = s.lastErrorAt;
    log(`${name.toUpperCase()} : ÉCHEC — ${e.message}`);
    return false;
  } finally {
    saveState();
  }
}

// ---------- COROS ----------

const recordsFile = join(raw, 'records.txt');
const readRecordsText = () =>
  existsSync(recordsFile) ? pc.unwrap(readFileSync(recordsFile, 'utf8')) : '';

function knownDetails() {
  const dir = join(raw, 'details');
  const ids = new Set();
  if (!existsSync(dir)) return ids;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const id = line.match(/"id"\s*:\s*"?(\d+)/)?.[1];
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function toolText(name, args) {
  const result = await coros.callTool(name, args);
  const text = pc.unwrap(coros.toolText(result));
  return { text, isError: Boolean(result.isError) };
}

async function syncCoros(s) {
  await coros.initialize();
  const to = today();
  const existing = readRecordsText();
  const latest = pc.recordBlocks(existing).reduce((m, r) => (r.date > m ? r.date : m), '');
  const from = addDays(
    [s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(to, -30),
    -OVERLAP_DAYS,
  );

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
  stage('coros', 'querySportRecords', to, { args: recArgs, text: rec.text });
  const fetched = pc.recordBlocks(rec.text);
  if (rec.isError || (!fetched.length && !/Sport Records/i.test(rec.text))) {
    throw new Error(`querySportRecords : réponse inattendue « ${rec.text.slice(0, 160)} »`);
  }
  // Sans en-tête reconnu, on n'efface rien : seule une vraie liste vide prouve une suppression
  const truncated = fetched.length >= LIMIT || !/Sport Records/i.test(rec.text);
  const merged = pc.mergeRecords(existing, rec.text, { from, to, truncated });
  writeFileSync(recordsFile, merged.text);

  // 2. Détails des activités qui n'en ont pas
  const have = knownDetails();
  const all = pc.recordBlocks(merged.text);
  const missing = all.filter((r) => !have.has(r.id)).slice(0, DETAILS_PER_RUN);
  let details = 0;
  for (const r of missing) {
    const d = await toolText('getActivityDetail', { labelId: r.id, sportType: r.sportType });
    stage('coros', 'getActivityDetail', r.id, { args: { labelId: r.id }, text: d.text });
    const detail = pc.parseDetail(r.id, d.text);
    if (d.isError || !pc.isUsableDetail(detail)) {
      log(`  détail inexploitable pour ${r.id} (${r.date}) : « ${d.text.slice(0, 120)} »`);
      continue;
    }
    mkdirSync(join(raw, 'details'), { recursive: true });
    appendFileSync(
      join(raw, 'details', `part-${compact(to)}.jsonl`),
      JSON.stringify(detail) + '\n',
    );
    details++;
  }

  // 3. Forme et charge
  const fit = await toolText('queryFitnessAssessmentOverview', {});
  stage('coros', 'queryFitnessAssessmentOverview', to, { text: fit.text });
  if (/VO2max/i.test(fit.text)) writeFileSync(join(raw, 'fitness.txt'), fit.text + '\n');
  else log(`  forme : réponse inattendue « ${fit.text.slice(0, 120)} »`);

  const load = await toolText('queryTrainingLoadAssessment', { days: 365 });
  stage('coros', 'queryTrainingLoadAssessment', to, { args: { days: 365 }, text: load.text });
  const loadFile = join(raw, 'load.txt');
  if (/Load Ratio/i.test(load.text)) {
    const before = existsSync(loadFile) ? readFileSync(loadFile, 'utf8') : '';
    writeFileSync(loadFile, pc.mergeLoad(before, load.text));
  } else log(`  charge : réponse inattendue « ${load.text.slice(0, 120)} »`);

  // 4. Fichiers FIT : nouvelles sorties d'abord, puis la file triée par utilité (fit-queue.txt)
  const fits = await syncFits(s, merged, all);

  const changes = [
    `${fetched.length} activités du ${from} au ${to}`,
    merged.added.length && `${merged.added.length} nouvelles`,
    merged.removed.length && `${merged.removed.length} retirées (supprimées dans COROS)`,
    `${details} détails`,
    fits,
  ];
  return changes.filter(Boolean).join(', ');
}

async function syncFits(s, merged, all) {
  const fitDir = join(raw, 'fit');
  mkdirSync(fitDir, { recursive: true });
  const have = new Set(readdirSync(fitDir).map((f) => f.replace(/\.fit$/, '')));
  const byId = new Map(all.map((r) => [r.id, r]));
  const queueFile = join(raw, 'fit-queue.txt');
  const queue = existsSync(queueFile)
    ? readFileSync(queueFile, 'utf8')
        .split('\n')
        .map((l) => l.split(' ')[0])
        .filter(Boolean)
    : [];
  const recent = all.filter((r) => r.date >= addDays(today(), -14)).map((r) => r.id);
  const failed = (s.fitFailures ??= {});
  const order = [
    ...new Set([...merged.added.map((r) => r.id), ...recent, ...queue, ...all.map((r) => r.id)]),
  ].filter((id) => byId.has(id) && !have.has(id) && (failed[id] ?? 0) < 3);

  let ok = 0;
  for (const id of order.slice(0, FIT_PER_RUN)) {
    const got = await downloadFit(s, byId.get(id));
    if (got === 'quota') return `${ok} FIT (quota de 50/jour atteint, reste ${order.length - ok})`;
    if (got !== 'ok') continue;
    ok++;
    await sleep(1000);
  }
  return `${ok} FIT${order.length > ok ? ` (reste ${order.length - ok})` : ''}`;
}

/** Télécharge le FIT d'une activité : 'ok' | 'quota' | 'failed' */
async function downloadFit(s, r) {
  const failed = (s.fitFailures ??= {});
  // Uniquement labelId + sportType : les requêtes par plage de dates déclenchent l'anti-abus
  const res = await toolText('queryActivityFitFileDownloadUrls', {
    labelId: r.id,
    sportType: r.sportType,
  });
  if (pc.isFitQuota(res.text)) {
    s.fitQuotaHitAt = new Date().toISOString();
    return 'quota';
  }
  const url = pc.fitUrls(res.text)[0];
  const buf = url && Buffer.from(await (await fetchRetry(url)).arrayBuffer());
  if (!buf || !pc.isFitFile(buf)) {
    failed[r.id] = (failed[r.id] ?? 0) + 1;
    log(`  FIT indisponible pour ${r.id} (${r.date}) : « ${res.text.slice(0, 120)} »`);
    return 'failed';
  }
  mkdirSync(join(raw, 'fit'), { recursive: true });
  writeFileSync(join(raw, 'fit', `${r.id}.fit`), buf);
  delete failed[r.id];
  return 'ok';
}

/**
 * Bouton « Affiner avec le tracé » : le FIT d'une seule sortie. Ne touche pas à la date de dernière synchro
 * (la fenêtre de la prochaine synchro complète reste la même).
 */
async function syncOneFit(id) {
  if (id.startsWith('strava:')) return syncOneStreams(id);
  const s = (state.coros ??= {});
  const r = pc.recordBlocks(readRecordsText()).find((x) => x.id === id);
  if (!r) throw new Error(`activité ${id} inconnue de records.txt`);
  if (existsSync(join(raw, 'fit', `${id}.fit`))) return `FIT de ${id} déjà présent`;
  await coros.initialize();
  const got = await downloadFit(s, r);
  if (got === 'quota') throw new Error('quota de 50 FIT par jour atteint, réessaie demain');
  if (got !== 'ok') throw new Error(`FIT indisponible pour ${id}`);
  return `FIT de ${id} (${r.date}) téléchargé`;
}

// ---------- Strava (API REST) ----------

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Sorties qui ont déjà un tracé (FIT de l'archive ou streams) */
function tracked() {
  const keys = new Set();
  for (const dir of ['fit', 'tracks']) {
    if (!existsSync(join(raw, dir))) continue;
    for (const f of readdirSync(join(raw, dir))) keys.add(f.replace(/\.(fit|gpx|tcx|json)(\.gz)?$/, ''));
  }
  return keys;
}

/** Streams d'une sortie → data-raw/tracks/strava-<id>.json.gz : 'ok' | 'empty' */
async function downloadStreams(a) {
  const st = await strava.streams(a.id.slice('strava:'.length));
  if (!st?.time?.data?.length || !st?.distance?.data?.length) return 'empty';
  mkdirSync(join(raw, 'tracks'), { recursive: true });
  writeFileSync(join(raw, 'tracks', `${fileKey(a.id)}.json.gz`), gzipSync(JSON.stringify({ start: a.start, ...st })));
  a.file = 'streams';
  return 'ok';
}

async function syncStrava(s) {
  const file = stravaFile(raw);
  const existing = readJson(file, []);
  const to = today();
  const latest = existing.reduce((m, a) => (a.date > m ? a.date : m), '');
  const from = addDays(
    [s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(to, -30),
    -OVERLAP_DAYS,
  );
  // Un jour de marge : `after` est un instant UTC, les dates des sorties sont locales
  const after = Math.floor(Date.parse(`${addDays(from, -1)}T00:00:00Z`) / 1000);
  const list = await strava.activitiesSince(after);
  stage('strava', 'activities', to, { args: { after }, activities: list });
  const fetched = list.map(activityFromApi).filter(Boolean);
  // Sans activity:read_all, les sorties privées manquent à la réponse : on ne retire rien
  const complete = /activity:read_all/.test(readSecret('strava-tokens.json')?.scope ?? '');
  const merged = mergeStravaActivities(existing, fetched, { window: complete ? { from, to } : null });
  writeJson(file, merged.list);

  // Streams (seconde par seconde) : nouvelles sorties et 14 derniers jours d'abord, puis le reste de l'historique
  const have = tracked();
  const failed = (s.streamFailures ??= {});
  const recent = addDays(to, -14);
  const todo = [...merged.list]
    .filter((a) => !have.has(fileKey(a.id)) && (failed[a.id] ?? 0) < 3)
    .sort((a, b) => Number(b.date >= recent) - Number(a.date >= recent) || b.date.localeCompare(a.date));
  let ok = 0, limited = '';
  for (const a of todo.slice(0, STREAMS_PER_RUN)) {
    try {
      if ((await downloadStreams(a)) === 'ok') (ok++, delete failed[a.id]);
      else failed[a.id] = 3; // saisie manuelle, sans capteur : inutile de redemander
    } catch (e) {
      if (e instanceof strava.RateLimited) {
        limited = ' (limite de débit atteinte)';
        break;
      }
      if (e instanceof ReauthRequired) throw e;
      failed[a.id] = (failed[a.id] ?? 0) + 1;
      log(`  streams indisponibles pour ${a.id} (${a.date}) : ${e.message}`);
    }
    await sleep(500);
  }
  writeJson(file, merged.list);
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
async function syncOneStreams(id) {
  const file = stravaFile(raw);
  const list = readJson(file, []);
  const a = list.find((x) => x.id === id);
  if (!a) throw new Error(`activité ${id} inconnue de data-raw/strava`);
  if (tracked().has(fileKey(id))) return `tracé de ${id} déjà présent`;
  try {
    if ((await downloadStreams(a)) !== 'ok') throw new Error(`aucun tracé pour ${id} (saisie manuelle ?)`);
  } catch (e) {
    if (e instanceof strava.RateLimited) throw new Error('limite de débit Strava atteinte, réessaie dans un quart d’heure');
    if (e instanceof ReauthRequired) (state.strava ??= {}).reauthSince = new Date().toISOString();
    throw e;
  }
  writeJson(file, list);
  return `tracé de ${id} (${a.date}) téléchargé`;
}

// ---------- santé COROS ----------

async function syncCorosHealth(s) {
  await coros.initialize();
  const file = join(raw, 'health-coros.json');
  const existing = readJson(file, null);
  const latest = Object.keys(existing?.days ?? {}).sort().at(-1);
  const to = today();
  // Premier passage : un an d'historique ; ensuite la dernière date connue moins le recouvrement
  const from = latest
    ? addDays([s.lastSuccessDate, latest].filter(Boolean).sort()[0], -OVERLAP_DAYS)
    : addDays(to, -365);
  const days = daysBetween(from, to) + 1;
  const daily = await toolText('queryDailyHealthData', { days });
  const rhr = await toolText('queryRestingHeartRate', { days });
  if (daily.isError || rhr.isError) throw new Error(`santé COROS : « ${(daily.isError ? daily : rhr).text.slice(0, 160)} »`);
  // VFC : 7 jours au plus par appel
  const hrv = [];
  for (let d = from; d <= to; d = addDays(d, 7)) {
    const end = [addDays(d, 6), to].sort()[0];
    const r = await toolText('querySleepHrv', { startDate: compact(d), endDate: compact(end), days: 7 });
    if (!r.isError) hrv.push(r.text);
  }
  stage('coros', 'health', to, { args: { from, days }, daily: daily.text, rhr: rhr.text, hrv });
  const health = healthFromCoros({ daily: [daily.text], hrv, rhr: [rhr.text] });
  writeJson(file, mergeHealth(existing, health, new Date().toISOString()));
  const list = Object.values(health.days);
  const count = (k) => list.filter((d) => d[k] != null).length;
  return `${list.length} jours du ${from}, ${count('sleepMin')} nuits, ${count('hrv')} VFC, ${count('rhr')} FC de repos`;
}

// ---------- Google Health ----------

async function syncGoogle(s) {
  const apiFile = join(raw, 'health-api.json');
  const existing = readJson(apiFile, null);
  const takeout = readJson(join(raw, 'health.json'), null);
  const latest = [...Object.keys(existing?.days ?? {}), ...Object.keys(takeout?.days ?? {})]
    .sort()
    .at(-1);
  const to = addDays(today(), 1);
  const from = addDays(
    [s.lastSuccessDate, latest].filter(Boolean).sort()[0] ?? addDays(today(), -30),
    -OVERLAP_DAYS,
  );

  const filters = Object.fromEntries(
    DAILY_TYPES.map((t) => {
      const f = google.filterField(t);
      return [t, `${f}.date >= "${from}" AND ${f}.date < "${to}"`];
    }),
  );
  filters.sleep = `sleep.interval.end_time >= "${from}T00:00:00Z"`;
  filters.weight = `weight.sample_time.physical_time >= "${from}T00:00:00Z"`;

  const points = {};
  const errors = [];
  for (const [type, filter] of Object.entries(filters)) {
    try {
      points[type] = await google.dataPoints(type, filter);
      stage('google', type, today(), { filter, dataPoints: points[type] });
    } catch (e) {
      if (e instanceof ReauthRequired) throw e;
      errors.push(e.message);
    }
  }
  const health = healthFromGoogle(points);
  writeJson(apiFile, mergeHealth(existing, health, new Date().toISOString()));
  const nights = Object.values(health.days).filter((d) => d.sleepMin != null).length;
  const summary = `${Object.keys(health.days).length} jours du ${from}, ${nights} nuits, ${health.weight.length} pesées`;
  if (errors.length) throw new Error(`${summary} ; échecs : ${errors.join(' | ')}`);
  return summary;
}

// ---------- reconstruction ----------

function step(script, ...flags) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', script), ...flags], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error(`${script} a échoué (code ${res.status})`);
}

try {
  if (fitOnly) {
    log(`Tracé de la sortie ${fitOnly}…`);
    try {
      log(await syncOneFit(fitOnly));
      delete state.lastFitError;
    } catch (e) {
      state.lastFitError = `${fitOnly} : ${e.message}`;
      if (e instanceof ReauthRequired && !fitOnly.startsWith('strava:')) state.coros.reauthSince = new Date().toISOString();
      log(`FIT : ÉCHEC — ${e.message}`);
    }
    saveState();
  } else if (archive) {
    log('Import de l’archive Strava…');
    try {
      const r = importStravaArchive(archive, raw);
      state.stravaArchive = { importedAt: new Date().toISOString(), ...r };
      delete state.lastImportError;
      log(`Archive Strava : ${r.runs} sorties de course à pied (${r.added} nouvelles), ${r.files} tracés`);
    } catch (e) {
      state.lastImportError = e.message;
      log(`Archive Strava : ÉCHEC — ${e.message}`);
    } finally {
      rmSync(archive, { force: true });
    }
    saveState();
  } else if (rebuildOnly) {
    log('Reconstruction après une saisie…');
  } else {
    log(`Synchronisation (activités ${sources.activities}, santé ${sources.health})…`);
    const want = (name) => !only || only === name;
    if (sources.activities === 'coros' && want('coros')) await runSource('coros', 'coros-tokens.json', syncCoros);
    if (sources.activities === 'strava' && want('strava')) await runSource('strava', 'strava-tokens.json', syncStrava);
    if (sources.health === 'google' && want('google')) await runSource('google', 'google-tokens.json', syncGoogle);
    if (sources.health === 'coros' && want('corosHealth'))
      await runSource('corosHealth', 'coros-tokens.json', syncCorosHealth, 'coros');
  }
  if (fitOnly && !state.lastFitError) {
    try {
      step('build-fit.mjs');
      step('build-data.mjs');
    } catch (e) {
      state.lastBuildError = e.message;
      log(`Reconstruction : ÉCHEC — ${e.message}`);
    }
    saveState();
  } else if (!fitOnly && !args.includes('--no-build')) {
    try {
      // Réglages de l'athlète utilisés par build-fit modifiés (site ou npm run nas -- push athlete.json) : FC max/repos,
      // seuils → tout recalculer ; poids, taille ou poids des courses ne touchent pas aux FIT
      const athlete = join(raw, 'athlete.json');
      const a = readJson(athlete, {});
      const fitKey = JSON.stringify([a.hrMax, a.hrRest, a.lt1Hr ?? null, a.lt2Hr ?? null]);
      const changed =
        state.athleteFit !== undefined
          ? state.athleteFit !== fitKey
          : state.lastBuild && existsSync(athlete) && statSync(athlete).mtimeMs > Date.parse(state.lastBuild);
      step('build-fit.mjs', ...(changed ? ['--force'] : []));
      step('build-data.mjs');
      if (sources.activities === 'coros') step('fit-queue.mjs');
      step('fetch-weather.mjs');
      step('build-data.mjs');
      state.lastBuild = new Date().toISOString();
      state.athleteFit = fitKey;
      delete state.lastBuildError;
    } catch (e) {
      state.lastBuildError = e.message;
      log(`Reconstruction : ÉCHEC — ${e.message}`);
    }
    saveState();
  }
  log('Terminé.');
} finally {
  unlinkSync(lockFile);
}
