// Construit le snapshot de l'appli (coros.json, nom historique, et routes.json) à partir des données brutes des
// sources choisies (sources.json, COROS + Google Health par défaut) :
//   records.txt      -> sortie brute de querySportRecords (liste des activités COROS)
//   strava/activities.json -> sorties Strava (archive et API, parsers/strava.ts), à la place de records.txt
//   details/*.jsonl  -> une ligne JSON par activité (dénivelé, cadence, charge…)
//   fitness.txt      -> sortie brute de queryFitnessAssessmentOverview
//   load.txt         -> sortie brute de queryTrainingLoadAssessment
//   athlete.json     -> FC max / repos, sexe, poids (réglages)
//   fit-derived/     -> analyses des fichiers FIT (pipeline/build-fit.ts)
//   splits/, laps/   -> splits et tours au km Coros des sorties sans FIT
//   results/         -> classements officiels
//   weather/         -> météo horaire Open-Meteo (scripts/fetch-weather.mjs), altitude, prévisions des objectifs
//   health.json      -> santé & sommeil (scripts/import-health.mjs, export Google Takeout)
//   health-api.json  -> santé & sommeil synchronisés par l'API Google Health, prioritaires
//   health-coros.json -> santé & sommeil COROS (source de santé « coros »)
//   goals.json       -> objectifs de course
// Tout passe par un FileStore : le même code tourne sur le NAS (Node) et dans le navigateur (IndexedDB).
import type { FitDerived } from '../fit/types.ts';
import { firstPoint } from '../fit/analyse.ts';
import { combineHealth, type Health, type HealthFile } from '../parsers/google.ts';
import type { StravaActivity } from '../parsers/strava.ts';
import { fileKey, normalizeSources, type Sources } from '../sources.ts';
import { readJson, type FileStore, type Storage } from '../storage/types.ts';
import { parseFitness, parseLoad, parseRecords, rawText, SPORTS, toSeconds, type Fitness, type LoadDay } from './coros-text.ts';

/** Réglages de l'athlète (athlete.json) */
export interface Athlete {
  hrMax: number;
  hrRest: number;
  sex?: 'M' | 'F';
  lt1Hr?: number | null;
  lt2Hr?: number | null;
  [key: string]: unknown;
}

/** Analyse FIT dans le snapshot : sans la trace (routes.json), les splits ni les tours (portés par la sortie) */
export type SnapshotFit = Omit<FitDerived, 'v' | 'route' | 'splits' | 'km'>;

export interface Weather {
  temp: number;
  dew: number;
  rh: number;
  wind: number;
  dir?: number;
}

/** Sortie du snapshot (voir Activity dans src/app/core/models.ts) */
export interface SnapshotActivity {
  id: string;
  source: 'coros' | 'strava';
  sportType: number;
  kind: string;
  date: string;
  name: string;
  start: number | null;
  durationSec: number;
  distanceKm: number;
  avgHr: number | null;
  calories: number | null;
  lat: number | null;
  lon: number | null;
  elevGain?: number | null;
  elevLoss?: number | null;
  cadence?: number | null;
  stride?: number | null;
  power?: number | null;
  trainingLoad?: number | null;
  aerobicTE?: number | null;
  anaerobicTE?: number | null;
  focus?: string | null;
  bestKmSec?: number | null;
  race?: boolean;
  splits?: number[];
  km?: number[][];
  fit?: SnapshotFit;
  result?: Record<string, unknown>;
  weather?: Weather;
  startAlt?: number;
}

/** Objectif de course (goals.json), plus la prévision météo du jour J */
export interface Goal {
  id: string;
  name: string;
  date: string;
  startTime?: string;
  distanceKm: number;
  targetSec?: number;
  kind: 'road' | 'trail';
  forecast?: Weather & { fetchedAt?: string };
  [key: string]: unknown;
}

export interface Snapshot {
  generatedAt: string;
  sources: Sources;
  athlete: Athlete | null;
  activities: SnapshotActivity[];
  fitness: Fitness | null;
  load: LoadDay[];
  health: Health | null;
  goals: Goal[];
}

export interface SnapshotStats {
  withFit: number;
  withLaps: number;
  withWeather: number;
  withResult: number;
}

export interface SnapshotResult {
  snapshot: Snapshot;
  /** Traces GPS (polyline) par sortie, chargées à la demande */
  routes: Record<string, string>;
  /** Activités COROS sans détail (`<labelId> <sportType> <date>`) ; null avec Strava */
  missing: string[] | null;
  stats: SnapshotStats;
  warnings: string[];
}

interface Detail {
  id?: string | number;
  elevGain?: number | null;
  elevLoss?: number | null;
  cadence?: number | null;
  stride?: number | null;
  power?: number | null;
  trainingLoad?: number | null;
  aerobicTE?: number | null;
  anaerobicTE?: number | null;
  focus?: string | null;
  bestKm?: string | null;
}

/** Sorties Strava (strava/activities.json) au format Activity ; la foulée est déduite de la cadence */
function stravaActivities(list: StravaActivity[]): SnapshotActivity[] {
  return list.map((s) => ({
    id: s.id,
    source: 'strava',
    sportType: s.sportType,
    kind: SPORTS[s.sportType] ?? 'other',
    date: s.date,
    name: s.name,
    start: s.start ?? null,
    durationSec: s.durationSec,
    distanceKm: s.distanceKm,
    avgHr: s.avgHr ?? null,
    calories: s.calories ?? null,
    lat: s.lat ?? null,
    lon: s.lon ?? null,
    elevGain: s.elevGain ?? null,
    elevLoss: s.elevLoss ?? null,
    cadence: s.cadence ?? null,
    stride: s.cadence ? Math.round(((s.distanceKm * 1000) / s.durationSec / (s.cadence / 60)) * 100) / 100 : null,
    power: s.power ?? null,
    ...(s.race && { race: true }),
  }));
}

async function readDetails(raw: FileStore, warnings: string[]): Promise<Map<string, Detail>> {
  const map = new Map<string, Detail>();
  for (const f of (await raw.list('details')).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of (await raw.readText(`details/${f}`))!.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as Detail;
        if (d.id) map.set(String(d.id), d);
      } catch {
        warnings.push(`Ligne ignorée dans ${f}: ${line.slice(0, 80)}`);
      }
    }
  }
  return map;
}

/** Clé horaire Open-Meteo (« AAAA-MM-JJTHH:00 ») d'une date dont les champs locaux sont l'heure voulue */
const hourKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;

type Hourly = Record<string, { t?: number | null; dew?: number; rh?: number; wind?: number; dir?: number | null; [k: string]: unknown }>;

export async function buildSnapshot(raw: FileStore, { now = new Date() }: { now?: Date } = {}): Promise<SnapshotResult> {
  const warnings: string[] = [];
  const sources = normalizeSources((await readJson(raw, 'sources.json')) ?? {});
  const athlete = await readJson<Athlete>(raw, 'athlete.json');
  const strava = sources.activities === 'strava';

  const recordsText = strava ? null : await raw.readText('records.txt');
  const activities: SnapshotActivity[] = strava
    ? stravaActivities((await readJson<StravaActivity[]>(raw, 'strava/activities.json')) ?? [])
    : recordsText != null
      ? parseRecords(rawText(recordsText))
      : [];
  const details = strava ? new Map<string, Detail>() : await readDetails(raw, warnings);
  const missing: string[] = [];
  for (const a of activities) {
    if (strava) continue;
    const d = details.get(a.id);
    if (!d) {
      missing.push(`${a.id} ${a.sportType} ${a.date}`);
      continue;
    }
    a.elevGain = d.elevGain ?? null;
    a.elevLoss = d.elevLoss ?? null;
    a.cadence = d.cadence ?? null;
    a.stride = d.stride ?? null;
    a.power = d.power ?? null;
    a.trainingLoad = d.trainingLoad ?? null;
    a.aerobicTE = d.aerobicTE ?? null;
    a.anaerobicTE = d.anaerobicTE ?? null;
    a.focus = d.focus ?? null;
    a.bestKmSec = d.bestKm ? toSeconds(d.bestKm) : null;
  }
  activities.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  // Analyses FIT : les traces GPS partent dans un fichier séparé, chargé à la demande
  const routes: Record<string, string> = {};
  let withFit = 0;
  for (const a of activities) {
    const derived = await readJson<FitDerived & { empty?: boolean }>(raw, `fit-derived/${fileKey(a.id)}.json`);
    if (!derived) continue;
    const { route, v, empty, splits, km, ...fit } = derived;
    if (empty) continue;
    if (route) routes[a.id] = route;
    if (splits?.length) a.splits = splits;
    if (km?.length) a.km = km;
    a.fit = fit;
    withFit++;
  }

  // Splits au kilomètre saisis à part (données de tours Coros) pour les courses sans fichier FIT
  for (const a of activities) {
    if (a.splits) continue;
    const s = await readJson<{ km: number[] }>(raw, `splits/${fileKey(a.id)}.json`);
    if (s) a.splits = s.km;
  }

  // Classements officiels (results/<id>.json, ou date-AAAA-MM-JJ-<km>.json rattaché par la date et la distance)
  let withResult = 0;
  for (const f of (await raw.list('results')).filter((x) => x.endsWith('.json'))) {
    const { activityId, ...res } = (await readJson<Record<string, unknown>>(raw, `results/${f}`))!;
    const m = f.match(/^date-(\d{4}-\d{2}-\d{2})-(\d+)\.json$/);
    const a = activityId
      ? activities.find((x) => x.id === activityId)
      : m && activities.filter((x) => x.date === m[1]).sort((x, y) => Math.abs(x.distanceKm - +m[2]) - Math.abs(y.distanceKm - +m[2]))[0];
    // Catégorie : « SE H » / « SEH » (chronométreurs) → « SEM » (notation FFA)
    if (typeof res['category'] === 'string') res['category'] = res['category'].replace(/^SE ?[HM]$/, 'SEM').replace(/^SE ?[FD]$/, 'SEF');
    delete res['date'];
    // Fichier rattaché par la date : remplacé par <id>.json à la première saisie depuis le site
    if (m) res['file'] = f;
    if (a) (a.result = res), withResult++;
    else warnings.push(`Classement sans sortie correspondante : ${f}`);
  }

  // Tours au km Coros (queryActivityLapData) pour les sorties longues sans fichier FIT : durabilité
  let withLaps = 0;
  for (const a of activities) {
    if (a.km) continue;
    const laps = await readJson<{ km?: number[][] }>(raw, `laps/${fileKey(a.id)}.json`);
    if (laps?.km?.length) (a.km = laps.km), withLaps++;
  }

  // Sans COROS : charge = TRIMP (même calcul que trimp() de src/app/core/science.ts), meilleur km et lieu de départ
  // tirés du tracé
  if (strava) {
    for (const a of activities) {
      if (a.fit?.trimp) a.trainingLoad = a.fit.trimp;
      else if (a.avgHr && athlete) {
        const hrr = Math.max(0, Math.min(1, (a.avgHr - athlete.hrRest) / (athlete.hrMax - athlete.hrRest)));
        const [k, b] = athlete.sex === 'F' ? [0.86, 1.67] : [0.64, 1.92];
        a.trainingLoad = Math.round((a.durationSec / 60) * hrr * k * Math.exp(b * hrr));
      } else a.trainingLoad = null;
      if (a.fit?.efforts?.['1000']) a.bestKmSec = a.fit.efforts['1000'];
      const p = a.lat == null && routes[a.id] ? firstPoint(routes[a.id]) : null;
      if (p) [a.lat, a.lon] = p.map((v) => Math.round(v * 1e4) / 1e4);
    }
  }

  // Météo moyenne pendant la sortie (heures pleines couvertes par la sortie)
  const weatherCache = new Map<string, Hourly | null>();
  let withWeather = 0;
  for (const a of activities) {
    if (a.lat == null || !a.start) continue;
    const key = `${a.lat.toFixed(1)}_${a.lon!.toFixed(1)}`;
    if (!weatherCache.has(key)) {
      weatherCache.set(key, (await readJson<{ hourly: Hourly }>(raw, `weather/${key}.json`))?.hourly ?? null);
    }
    const hourly = weatherCache.get(key);
    if (!hourly) continue;
    const hours: Hourly[string][] = [];
    for (let t = a.start; t <= a.start + a.durationSec; t += 3600) {
      // Heure locale du lieu, au format des clés Open-Meteo (timezone=auto)
      const d = new Date(t * 1000);
      const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      const k = hourKey(local);
      if (hourly[k]?.t != null) hours.push(hourly[k]);
    }
    if (!hours.length) continue;
    const avg = (f: string) => Math.round((hours.reduce((s, h) => s + ((h[f] as number | undefined) ?? 0), 0) / hours.length) * 10) / 10;
    a.weather = { temp: avg('t'), dew: avg('dew'), rh: avg('rh'), wind: avg('wind') };
    // Direction d'où vient le vent : moyenne vectorielle pondérée par la vitesse
    const withDir = hours.filter((h) => h.dir != null);
    if (withDir.length) {
      const rad = Math.PI / 180;
      const x = withDir.reduce((s, h) => s + h.wind! * Math.sin(h.dir! * rad), 0);
      const y = withDir.reduce((s, h) => s + h.wind! * Math.cos(h.dir! * rad), 0);
      if (x || y) a.weather.dir = Math.round(((Math.atan2(x, y) / rad) + 360) % 360);
    }
    withWeather++;
  }

  // Altitude du point de départ (weather/elevation.json, npm run weather) : altitude des sorties sans FIT
  const elevation = (await readJson<Record<string, number | null>>(raw, 'weather/elevation.json')) ?? {};
  for (const a of activities) {
    if (a.lat == null || a.lon == null) continue;
    const z = elevation[`${a.lat.toFixed(2)}_${a.lon.toFixed(2)}`];
    if (z != null) a.startAlt = Math.round(z);
  }

  // Objectifs : météo moyenne prévue entre le départ et l'arrivée estimée (heure locale de la machine, comme sur
  // le NAS réglé sur Europe/Paris)
  const goals = (await readJson<Goal[]>(raw, 'goals.json')) ?? [];
  for (const g of goals) {
    const forecast = await readJson<{ hourly: Hourly; fetchedAt?: string }>(raw, `weather/forecast-${g.id}.json`);
    if (!forecast) continue;
    const { hourly, fetchedAt } = forecast;
    const [h, m] = (g.startTime ?? '09:00').split(':').map(Number);
    const hoursLong = Math.max(1, Math.ceil((g.targetSec ?? g.distanceKm * (g.kind === 'trail' ? 540 : 330)) / 3600));
    const hours: Hourly[string][] = [];
    for (let i = 0; i < hoursLong; i++) {
      const d = new Date(`${g.date}T00:00:00`);
      d.setMinutes(h * 60 + m + i * 60);
      const k = hourKey(d);
      if (hourly[k]?.t != null) hours.push(hourly[k]);
    }
    if (!hours.length) continue;
    const avg = (k: string) => Math.round((hours.reduce((s, x) => s + ((x[k] as number | undefined) ?? 0), 0) / hours.length) * 10) / 10;
    g.forecast = { temp: avg('t'), dew: avg('dew'), rh: avg('rh'), wind: avg('wind'), fetchedAt };
  }

  // Santé : Google (Takeout + API), COROS ou aucune
  const health = async (): Promise<Health | null> => {
    if (sources.health === 'none') return null;
    if (sources.health === 'coros') {
      const h = await readJson<HealthFile>(raw, 'health-coros.json');
      return h ? { importedAt: h.updatedAt, syncedAt: h.updatedAt, days: h.days, weight: h.weight ?? [] } : null;
    }
    return combineHealth(await readJson<Health>(raw, 'health.json'), await readJson<HealthFile>(raw, 'health-api.json')) ?? null;
  };

  // Forme et charge COROS : seulement avec les activités COROS
  const corosText = async (file: string) => (strava ? null : await raw.readText(file));
  const fitnessText = await corosText('fitness.txt');
  const loadText = await corosText('load.txt');
  const snapshot: Snapshot = {
    generatedAt: now.toISOString(),
    sources,
    athlete,
    activities,
    fitness: fitnessText != null ? parseFitness(rawText(fitnessText)) : null,
    load: loadText != null ? parseLoad(rawText(loadText)) : [],
    health: await health(),
    goals,
  };
  return { snapshot, routes, missing: strava ? null : missing, stats: { withFit, withLaps, withWeather, withResult }, warnings };
}

/** Écrit coros.json et routes.json (zone snapshot) et missing-details.txt (données brutes, COROS seulement) */
export async function writeSnapshot(storage: Storage, { snapshot, routes, missing }: SnapshotResult): Promise<void> {
  await storage.snapshot.write('coros.json', JSON.stringify(snapshot));
  await storage.snapshot.write('routes.json', JSON.stringify(routes));
  if (missing) await storage.raw.write('missing-details.txt', missing.join('\n') + (missing.length ? '\n' : ''));
}

/** Résumé d'une construction, une ligne */
export function snapshotSummary({ snapshot, missing, stats }: SnapshotResult): string {
  const { activities, sources, load } = snapshot;
  const km = activities.reduce((s, a) => s + a.distanceKm, 0);
  return (
    `${activities.length} activités ${sources.activities.toUpperCase()}, ${km.toFixed(1)} km, ` +
    (missing
      ? `${activities.length - missing.length} enrichies, ${missing.length} sans détail (voir data-raw/missing-details.txt), `
      : '') +
    `${load.length} jours de charge, ` +
    `${stats.withFit} avec FIT, ${stats.withLaps} avec tours Coros, ${stats.withWeather} avec météo, ${stats.withResult} avec classement`
  );
}
