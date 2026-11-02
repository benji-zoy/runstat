// Garmin Connect Personal API → sorties au format de data-raw/garmin/activities.json (même forme que celles de Strava,
// fusionnées par snapshot/build.ts) et jours de santé (health-garmin.json, comme healthFromGoogle). Champs d'après le
// Swagger officiel (developer.garmin.com/gc-developer-program/personal/swagger-docs). Fonctions pures.
import type { HealthData, HealthDay } from './google.ts';
import type { StravaActivity } from './strava.ts';

/** SummarizedActivityDTO de /activitylist-service/activities/search/activities (champs utiles) */
export interface GarminApiActivity {
  activityId?: number;
  activityName?: string;
  /** « AAAA-MM-JJ HH:mm:ss », heure locale de la sortie */
  startTimeLocal?: string;
  /** Départ en millisecondes epoch */
  beginTimestamp?: number;
  activityType?: { typeKey?: string };
  eventType?: { typeKey?: string };
  /** Mètres */
  distance?: number;
  /** Secondes (chronomètre, moins les pauses, déplacement, total) */
  duration?: number;
  movingDuration?: number;
  elapsedDuration?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  averageRunningCadenceInStepsPerMinute?: number;
  avgPower?: number;
  startLatitude?: number;
  startLongitude?: number;
}

/** Sortie Garmin : même forme que les sorties Strava, identifiant « garmin:<activityId> » */
export type GarminActivity = StravaActivity;

/** Type d'activité Garmin (typeKey) → code COROS : 100 route, 101 tapis/virtuel, 102 trail, 103 piste ; null hors course */
const SPORT_TYPES: Record<string, number> = {
  running: 100,
  street_running: 100,
  obstacle_run: 100,
  treadmill_running: 101,
  indoor_running: 101,
  virtual_run: 101,
  trail_running: 102,
  ultra_run: 102,
  track_running: 103,
};

const round = (v: number | null | undefined, d = 0): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

/** Activité de la liste → sortie, ou null si ce n'est pas de la course */
export function activityFromGarmin(a: GarminApiActivity): GarminActivity | null {
  const sportType = SPORT_TYPES[a.activityType?.typeKey ?? ''] ?? null;
  const moving = a.movingDuration ?? a.duration;
  if (sportType == null || !a.activityId || !a.distance || !moving || !a.startTimeLocal) return null;
  const out: GarminActivity = {
    id: `garmin:${a.activityId}`,
    sportType,
    name: a.activityName ?? '',
    date: a.startTimeLocal.slice(0, 10),
    start: a.beginTimestamp ? Math.round(a.beginTimestamp / 1000) : null,
    durationSec: Math.round(moving),
    elapsedSec: round(a.elapsedDuration),
    distanceKm: round(a.distance / 1000, 3)!,
    avgHr: round(a.averageHR),
    maxHr: round(a.maxHR),
    calories: round(a.calories),
    elevGain: round(a.elevationGain),
    elevLoss: round(a.elevationLoss),
    cadence: round(a.averageRunningCadenceInStepsPerMinute),
    power: round(a.avgPower),
    lat: a.startLatitude ?? null,
    lon: a.startLongitude ?? null,
  };
  if (a.eventType?.typeKey === 'race') out.race = true;
  return out;
}

/** DailySleepDTO (/sleep-service/sleep/dailySleepSummariesByDate) */
export interface GarminSleep {
  /** Date du réveil */
  calendarDate?: string;
  /** Sommeil mesuré, siestes exclues */
  sleepTimeSeconds?: number | null;
  napTimeSeconds?: number | null;
  deepSleepSeconds?: number | null;
  remSleepSeconds?: number | null;
  awakeSleepSeconds?: number | null;
  averageRespirationValue?: number | null;
  averageSpO2Value?: number | null;
  sleepScores?: { overall?: { value?: number | null } } | null;
}

/** Entrée de HrvDailySummaryDTO.hrvSummaries */
export interface GarminHrv {
  calendarDate?: string;
  lastNightAvg?: number | null;
}

/** UserDailySummaryV2DTO (/usersummary-service/v2/dailysummaries, champ data) */
export interface GarminDailySummary {
  calendarDate?: string;
  heartRate?: { restingValue?: number | null } | null;
}

/** DailyWeightSummary (/weight-service/weight/range, champ dailyWeightSummaries) */
export interface GarminWeight {
  summaryDate?: string;
  latestWeight?: { weight?: number | null } | null;
}

const minutes = (sec: number | null | undefined) => (sec == null ? null : Math.round(sec / 60));
const round1 = (v: number) => Math.round(v * 10) / 10;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Réponses santé de la Personal API → jours de santé (format de health.json). Nuit rattachée à sa calendarDate (date du
 * réveil, comme COROS et Google). Poids en kg d'après le Swagger ; une valeur en grammes (ancienne API) est convertie.
 */
export function healthFromGarmin({
  sleep = [],
  hrv = [],
  summaries = [],
  weight = [],
}: {
  sleep?: GarminSleep[];
  hrv?: GarminHrv[];
  summaries?: GarminDailySummary[];
  weight?: GarminWeight[];
}): HealthData {
  const days: Record<string, HealthDay> = {};
  const put = (date: string, patch: HealthDay) => (days[date] = { ...days[date], ...patch });
  for (const s of sleep) {
    const main = minutes(s.sleepTimeSeconds);
    if (!isDate(s.calendarDate) || !main) continue;
    const d: HealthDay = { sleepMin: main + (minutes(s.napTimeSeconds) ?? 0), sleepMain: main };
    const awake = minutes(s.awakeSleepSeconds);
    const deep = minutes(s.deepSleepSeconds);
    const rem = minutes(s.remSleepSeconds);
    if (awake != null) d.awakeMin = awake;
    if (deep != null) d.deepMin = deep;
    if (rem != null) d.remPct = round1((rem / main) * 100);
    if (s.sleepScores?.overall?.value) d.sleepScore = s.sleepScores.overall.value;
    if (s.averageRespirationValue) d.breath = round1(s.averageRespirationValue);
    if (s.averageSpO2Value) d.spo2 = round1(s.averageSpO2Value);
    put(s.calendarDate, d);
  }
  for (const h of hrv) if (isDate(h.calendarDate) && h.lastNightAvg) put(h.calendarDate, { hrv: h.lastNightAvg });
  for (const s of summaries) {
    const rhr = s.heartRate?.restingValue;
    if (isDate(s.calendarDate) && rhr) put(s.calendarDate, { rhr });
  }
  const kg = (w: number) => round1(w > 1000 ? w / 1000 : w);
  const weights = weight
    .filter((w) => isDate(w.summaryDate) && w.latestWeight?.weight)
    .map((w) => ({ date: w.summaryDate!, kg: kg(w.latestWeight!.weight!) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))), weight: weights };
}
