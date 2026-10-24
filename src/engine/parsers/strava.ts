// Strava → sorties au format de data-raw/strava/activities.json (fusionnées par snapshot/build.ts). Fonctions pures,
// testées par scripts/sync/strava.test.mjs. Deux entrées : activities.csv de l'archive (export localisé : en-têtes
// anglais ou français, colonnes en double) et les activités de l'API REST.

/** Fuseau des dates locales (comme build-data et les sorties COROS) */
export const TIME_ZONE = 'Europe/Paris';

/** Sortie Strava de data-raw/strava/activities.json */
export interface StravaActivity {
  /** « strava:123 » */
  id: string;
  /** Code COROS : 100 route, 101 tapis/virtuel, 102 trail */
  sportType: number;
  name: string;
  date: string;
  start: number | null;
  /** Temps de déplacement */
  durationSec: number;
  elapsedSec?: number | null;
  distanceKm: number;
  avgHr?: number | null;
  maxHr?: number | null;
  calories?: number | null;
  elevGain?: number | null;
  elevLoss?: number | null;
  /** Pas par minute */
  cadence?: number | null;
  power?: number | null;
  lat?: number | null;
  lon?: number | null;
  race?: boolean;
  /** Tracé disponible : "fit" | "gpx" | "tcx" | "streams" */
  file?: string;
  /** Chemin du tracé dans l'archive, le temps de l'import */
  filename?: string | null;
}

const localDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: TIME_ZONE });
const round = (v: number | null | undefined, d = 0): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

/** CSV RFC 4180 : guillemets, virgules et sauts de ligne dans les champs */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

const norm = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Colonnes utiles, en anglais et en français (en-têtes normalisés : minuscules, sans accents ni ponctuation) */
const COLUMNS = {
  id: /^(activity id|id de l activite)$/,
  date: /^(activity date|date de l activite)$/,
  name: /^(activity name|nom de l activite)$/,
  type: /^(activity type|type d activite|type de l activite)$/,
  filename: /^(filename|nom du fichier|nom de fichier)$/,
  elapsed: /^(elapsed time|temps ecoule|duree ecoulee)$/,
  moving: /^(moving time|duree de deplacement|temps de deplacement)$/,
  distance: /^distance$/,
  elevGain: /^(elevation gain|denivele positif)$/,
  elevLoss: /^(elevation loss|denivele negatif)$/,
  avgHr: /^(average heart rate|frequence cardiaque moyenne)$/,
  maxHr: /^(max heart rate|frequence cardiaque max(imale|imum)?)$/,
  cadence: /^(average cadence|cadence moyenne)$/,
  power: /^(average watts|puissance moyenne)$/,
  calories: /^calories$/,
};
type Column = keyof typeof COLUMNS;

/** Course à pied seulement : sportType COROS, ou null pour les autres sports */
export function runSportType(type: unknown, { trainer = false }: { trainer?: boolean } = {}): number | null {
  const t = norm(String(type ?? '')).replace(/ /g, '');
  if (!/run|course|trail/.test(t)) return null;
  if (/virtual|virtuel/.test(t) || trainer) return 101;
  if (/trail/.test(t)) return 102;
  if (/^(run|course|courseapied)$/.test(t)) return 100;
  return null;
}

const MONTHS = [
  /^jan/, /^(feb|fev)/, /^mar/, /^(apr|avr)/, /^(may|mai)/, /^(jun|juin)/, /^(jul|juil)/, /^(aug|aou)/, /^sep/, /^oct/, /^nov/, /^dec/,
];

/** Date de l'archive (UTC) → millisecondes : « Jan 5, 2020, 7:30:12 AM », « 5 janv. 2020, 07:30:12 », ISO */
export function parseArchiveDate(text: unknown): number | null {
  const s = String(text ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]);
  const time = s.match(/(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp][Mm])?/);
  const words = norm(s.replace(time?.[0] ?? '', '')).split(' ').filter(Boolean);
  const monthOf = (w: string) => MONTHS.findIndex((m) => m.test(w));
  const mi = words.findIndex((w) => !/^\d+$/.test(w) && monthOf(w) >= 0);
  const nums = words.filter((w) => /^\d+$/.test(w)).map(Number);
  const year = nums.find((n) => n > 1900);
  const day = nums.find((n) => n >= 1 && n <= 31);
  if (mi < 0 || !year || !day || !time) return null;
  let h = Number(time[1]) % (time[4] ? 12 : 24);
  if (time[4] && /p/i.test(time[4])) h += 12;
  return Date.UTC(year, monthOf(words[mi]), day, h, Number(time[2]), Number(time[3]));
}

/** Nombre de l'archive : « 10.02 », « 10,02 », « 1,234.5 » ou vide */
function number(text: string | undefined): number | null {
  const s = String(text ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const v = Number(/,\d{1,2}$/.test(s) && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * activities.csv de l'archive Strava → sorties de course à pied (les autres sports sont ignorés).
 * Chaque sortie garde `filename` (chemin du tracé dans l'archive) pour l'import.
 */
export function parseActivitiesCsv(text: string): StravaActivity[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const names = header.map(norm);
  // Colonne en double (temps écoulé, distance, FC max…) : la seconde est la valeur brute (s, m)
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, re]) => [k, names.map((n, i) => (re.test(n) ? i : -1)).filter((i) => i >= 0)]),
  ) as Record<Column, number[]>;
  if (!col.id.length || !col.date.length || !col.type.length) throw new Error('activities.csv : colonnes inconnues');
  const out: StravaActivity[] = [];
  for (const r of rows) {
    const get = (k: Column) => (col[k].length ? r[col[k].at(-1)!] : undefined);
    const sportType = runSportType(get('type'));
    const id = String(get('id') ?? '').trim();
    const ms = parseArchiveDate(get('date'));
    if (sportType == null || !/^\d+$/.test(id) || ms == null) continue;
    // Distance : la seconde colonne est en mètres ; une seule (anciennes archives) : kilomètres
    const distM = col.distance.length > 1 ? number(r[col.distance.at(-1)!]) : (number(get('distance')) ?? 0) * 1000;
    const elapsed = number(get('elapsed'));
    const moving = number(get('moving')) ?? elapsed;
    if (!distM || !moving) continue;
    out.push({
      id: `strava:${id}`,
      sportType,
      name: String(get('name') ?? '').trim(),
      date: localDate(ms),
      start: Math.round(ms / 1000),
      durationSec: Math.round(moving),
      elapsedSec: elapsed != null ? Math.round(elapsed) : null,
      distanceKm: round(distM / 1000, 3)!,
      avgHr: round(number(get('avgHr'))),
      maxHr: round(number(get('maxHr'))),
      calories: round(number(get('calories'))),
      elevGain: round(number(get('elevGain'))),
      elevLoss: round(number(get('elevLoss'))),
      // Strava compte les pas d'une jambe : × 2 pour des pas par minute, comme COROS
      cadence: number(get('cadence')) ? Math.round(number(get('cadence'))! * 2) : null,
      power: round(number(get('power'))),
      lat: null,
      lon: null,
      filename: String(get('filename') ?? '').trim() || null,
    });
  }
  return out;
}

/** Activité de l'API REST (SummaryActivity ou DetailedActivity), champs utilisés */
export interface StravaApiActivity {
  id?: number | string;
  name?: string;
  type?: string;
  sport_type?: string;
  trainer?: boolean;
  start_date: string;
  start_date_local?: string;
  moving_time?: number;
  elapsed_time?: number;
  distance?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number;
  kilojoules?: number;
  total_elevation_gain?: number;
  average_cadence?: number;
  average_watts?: number;
  start_latlng?: number[];
  workout_type?: number | null;
}

/** Activité de l'API REST (SummaryActivity ou DetailedActivity) → sortie, ou null si ce n'est pas de la course */
export function activityFromApi(a: StravaApiActivity): StravaActivity | null {
  const sportType = runSportType(a.sport_type ?? a.type, { trainer: a.trainer });
  if (sportType == null || !a.id || !a.distance || !a.moving_time) return null;
  const ms = Date.parse(a.start_date);
  const out: StravaActivity = {
    id: `strava:${a.id}`,
    sportType,
    name: a.name ?? '',
    // start_date_local : heure locale notée comme de l'UTC
    date: a.start_date_local?.slice(0, 10) ?? localDate(ms),
    start: Math.round(ms / 1000),
    durationSec: a.moving_time,
    elapsedSec: a.elapsed_time ?? null,
    distanceKm: round(a.distance / 1000, 3)!,
    avgHr: round(a.average_heartrate),
    maxHr: round(a.max_heartrate),
    calories: round(a.calories ?? (a.kilojoules ? a.kilojoules / 4.184 : null)),
    elevGain: round(a.total_elevation_gain),
    elevLoss: null,
    cadence: a.average_cadence ? Math.round(a.average_cadence * 2) : null,
    power: round(a.average_watts),
    lat: a.start_latlng?.length === 2 ? a.start_latlng[0] : null,
    lon: a.start_latlng?.length === 2 ? a.start_latlng[1] : null,
  };
  // workout_type 1 = course (en course à pied) : classée comme telle dans l'analyse
  if (a.workout_type === 1) out.race = true;
  return out;
}

/** Champs absents (null) d'une sortie : ne remplacent pas une valeur connue */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<T>;

/**
 * Fusionne des sorties dans la liste existante, par identifiant. Idempotent.
 * - `prefer: 'fetched'` (API) : les valeurs reçues l'emportent ; avec `window` ({ from, to }), les sorties de la
 *   fenêtre absentes de la réponse sont retirées (supprimées dans Strava, ou devenues un autre sport).
 * - `prefer: 'existing'` (archive) : ne fait que compléter, sans rien retirer.
 * @returns { list (triée par départ), added, removed }
 */
export function mergeStravaActivities(
  existing: StravaActivity[] | null | undefined,
  fetched: StravaActivity[],
  { prefer = 'fetched', window = null }: { prefer?: 'fetched' | 'existing'; window?: { from: string; to: string } | null } = {},
): { list: StravaActivity[]; added: string[]; removed: string[] } {
  const byId = new Map((existing ?? []).map((a) => [a.id, a]));
  const added: string[] = [];
  for (const f of fetched) {
    const old = byId.get(f.id);
    if (!old) added.push(f.id);
    byId.set(f.id, old ? (prefer === 'fetched' ? { ...old, ...defined(f) } : { ...f, ...defined(old) }) : f);
  }
  const removed: string[] = [];
  if (window) {
    const seen = new Set(fetched.map((f) => f.id));
    for (const [id, a] of byId)
      if (a.date >= window.from && a.date <= window.to && !seen.has(id)) byId.delete(id), removed.push(id);
  }
  const list = [...byId.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.id.localeCompare(b.id));
  return { list, added, removed };
}
