// Points de la Google Health API → jours de santé au format de data-raw/health.json
// (mêmes champs et mêmes définitions que scripts/import-health.mjs). Fonctions pures.

/** Une journée de santé (health.json, health-api.json, health-coros.json) */
export interface HealthDay {
  rhr?: number;
  hrv?: number;
  nremHr?: number;
  breath?: number;
  skinTemp?: number;
  spo2?: number;
  readiness?: number;
  sleepMin?: number;
  sleepMain?: number;
  awakeMin?: number | null;
  deepMin?: number;
  remPct?: number | null;
  sleepScore?: number;
  [key: string]: number | null | undefined;
}

export interface WeightEntry {
  date: string;
  kg: number | null;
}

export interface HealthData {
  days: Record<string, HealthDay>;
  weight: WeightEntry[];
}

/** Fichier de santé synchronisé (health-api.json, health-coros.json) */
export interface HealthFile extends HealthData {
  updatedAt: string;
}

/** Santé du snapshot */
export interface Health extends HealthData {
  importedAt?: string;
  syncedAt?: string;
  updatedAt?: string;
}

export const DAILY_TYPES = [
  'daily-resting-heart-rate',
  'daily-heart-rate-variability',
  'daily-respiratory-rate',
  'daily-sleep-temperature-derivations',
  'daily-oxygen-saturation',
];

const pad = (n: number) => String(n).padStart(2, '0');
const civilDate = (d: CivilDate | undefined) => (d?.year ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : null);
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Point de données de l'API (champs utilisés seulement) */
export interface GooglePoint {
  dataSource?: { platform?: string };
  [field: string]: any;
}

/** Date locale de fin : instant UTC + décalage (« 7200s ») */
function localDate(time: string, offset: string | undefined) {
  const sec = Number(String(offset ?? '0s').replace('s', '')) || 0;
  return new Date(new Date(time).getTime() + sec * 1000).toISOString().slice(0, 10);
}

/** Quand plusieurs sources donnent le même jour, le bracelet porté la nuit prime (comme import-health) */
const priority = (p: GooglePoint) => (p.dataSource?.platform === 'FITBIT' ? 2 : 1);

interface SleepSession {
  asleep: number;
  awake: number | null;
  deep: number | null;
  rem: number | null;
  main: boolean;
}

/**
 * @param points { [dataType]: DataPoint[] }
 * @returns { days: { [date]: {...} }, weight: [{ date, kg }] }
 */
export function healthFromGoogle(points: Record<string, GooglePoint[] | undefined>): HealthData {
  const days: Record<string, HealthDay> = {};
  const rank: Record<string, number> = {};
  const put = (date: string | null, key: string, value: number | null, p: GooglePoint) => {
    if (!date || value == null || Number.isNaN(value)) return;
    const k = `${date}/${key}`;
    if ((rank[k] ?? 0) > priority(p)) return;
    rank[k] = priority(p);
    (days[date] ??= {})[key] = value;
  };

  for (const p of points['daily-resting-heart-rate'] ?? []) {
    const v = p['dailyRestingHeartRate'];
    put(civilDate(v?.date), 'rhr', num(v?.beatsPerMinute), p);
  }
  for (const p of points['daily-heart-rate-variability'] ?? []) {
    const v = p['dailyHeartRateVariability'];
    put(civilDate(v?.date), 'hrv', num(v?.averageHeartRateVariabilityMilliseconds), p);
    put(civilDate(v?.date), 'nremHr', num(v?.nonRemHeartRateBeatsPerMinute) || null, p);
  }
  for (const p of points['daily-respiratory-rate'] ?? []) {
    const v = p['dailyRespiratoryRate'];
    put(civilDate(v?.date), 'breath', num(v?.breathsPerMinute), p);
  }
  for (const p of points['daily-sleep-temperature-derivations'] ?? []) {
    const v = p['dailySleepTemperatureDerivations'];
    put(civilDate(v?.date), 'skinTemp', num(v?.nightlyTemperatureCelsius), p);
  }
  for (const p of points['daily-oxygen-saturation'] ?? []) {
    const v = p['dailyOxygenSaturation'];
    put(civilDate(v?.date), 'spo2', num(v?.averagePercentage), p);
  }

  // Sommeil : nuit rattachée à la date locale du réveil ; total = toutes les sessions (siestes comprises)
  const nights = new Map<string, { total: number; sessions: SleepSession[] }>();
  for (const p of points['sleep'] ?? []) {
    const s = p['sleep'];
    if (!s?.interval?.endTime || !s.summary) continue;
    const date = localDate(s.interval.endTime, s.interval.endUtcOffset);
    const asleep = num(s.summary.minutesAsleep) ?? 0;
    const stage = (t: string) => num(s.summary.stagesSummary?.find((x: { type: string }) => x.type === t)?.minutes);
    const session = {
      asleep,
      awake: num(s.summary.minutesAwake),
      deep: stage('DEEP'),
      rem: stage('REM'),
      main: Boolean(s.metadata?.mainSleep),
    };
    const n = nights.get(date) ?? { total: 0, sessions: [] };
    n.total += asleep;
    n.sessions.push(session);
    nights.set(date, n);
  }
  for (const [date, n] of nights) {
    const main =
      n.sessions.find((x) => x.main) ?? n.sessions.reduce((a, b) => (b.asleep > a.asleep ? b : a));
    const d = (days[date] ??= {});
    d.sleepMin = n.total;
    d.sleepMain = main.asleep;
    d.awakeMin = main.awake;
    if (main.deep != null) d.deepMin = main.deep;
    if (main.rem != null && main.asleep) d.remPct = round1((main.rem / main.asleep) * 100);
  }

  // Poids : moyenne par jour. Date UTC de la mesure, comme l'export Takeout (sinon décalage d'un jour)
  const weights = new Map<string, number[]>();
  for (const p of points['weight'] ?? []) {
    const g = num(p['weight']?.weightGrams);
    const t = p['weight']?.sampleTime?.physicalTime;
    if (!g || !t) continue;
    const date = t.slice(0, 10);
    weights.set(date, [...(weights.get(date) ?? []), g / 1000]);
  }
  const weight = [...weights]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, w]) => ({ date, kg: round1(w.reduce((a, b) => a + b, 0) / w.length) }));

  return { days, weight };
}

/**
 * Fusionne une synchro dans health-api.json : les jours récupérés remplacent les champs connus,
 * les autres jours restent. Idempotent.
 */
export function mergeHealth(existing: HealthData | null | undefined, fetched: HealthData, fetchedAt: string): HealthFile {
  const days = { ...(existing?.days ?? {}) };
  for (const [date, d] of Object.entries(fetched.days)) days[date] = { ...days[date], ...d };
  const weight = new Map((existing?.weight ?? []).map((w) => [w.date, w]));
  for (const w of fetched.weight) weight.set(w.date, w);
  return {
    updatedAt: fetchedAt,
    days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))),
    weight: [...weight.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Takeout (health.json) + API (health-api.json) : l'API prime jour par jour, champ par champ */
export function combineHealth(takeout: Health | null, api: HealthFile | null): Health | null {
  if (!api) return takeout;
  if (!takeout) return { importedAt: api.updatedAt, ...api };
  const days = { ...takeout.days };
  for (const [date, d] of Object.entries(api.days ?? {})) days[date] = { ...days[date], ...d };
  const weight = new Map((takeout.weight ?? []).map((w) => [w.date, w]));
  for (const w of api.weight ?? []) weight.set(w.date, w);
  return {
    importedAt: takeout.importedAt,
    syncedAt: api.updatedAt,
    days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))),
    weight: [...weight.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
