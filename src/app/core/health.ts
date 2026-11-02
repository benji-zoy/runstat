/**
 * Récupération : VFC, FC de repos et sommeil (export Google Health / Fitbit).
 * Statut VFC inspiré de Garmin / Whoop : moyenne 7 jours comparée à une base personnelle.
 */
import { Activity, Health, HealthDay } from './models';
import { EfPoint } from './science';
import { addDays, isoDay, parseDay } from './stats';

type Metric = 'hrv' | 'rhr' | 'sleepMin' | 'readiness' | 'sleepScore';

export interface Baseline {
  date: Date;
  value: number | null;
  /** Moyenne glissante 7 jours */
  avg7: number | null;
  /** Base personnelle : moyenne et écart-type des 30 jours précédant la semaine */
  mean: number | null;
  sd: number | null;
}

/** Série quotidienne d'une métrique avec moyenne 7 j et base 30 j (jours 8 à 37 avant) */
export function baselineSeries(h: Health, metric: Metric, from: Date, to: Date): Baseline[] {
  const val = (d: Date) => {
    const v = h.days[isoDay(d)]?.[metric];
    return typeof v === 'number' ? v : null;
  };
  const window = (d: Date, start: number, end: number) => {
    const xs: number[] = [];
    for (let i = start; i <= end; i++) {
      const v = val(addDays(d, -i));
      if (v !== null) xs.push(v);
    }
    return xs;
  };
  const out: Baseline[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const last7 = window(d, 0, 6);
    const base = window(d, 7, 36);
    const mean = base.length >= 10 ? base.reduce((s, x) => s + x, 0) / base.length : null;
    const sd = mean !== null ? Math.sqrt(base.reduce((s, x) => s + (x - mean) ** 2, 0) / base.length) : null;
    out.push({
      date: d,
      value: val(d),
      avg7: last7.length >= 3 ? last7.reduce((s, x) => s + x, 0) / last7.length : null,
      mean,
      sd,
    });
  }
  return out;
}

export type Status = { label: string; tone: 'good' | 'neutral' | 'warning' | 'critical'; text: string };

/** Statut VFC : moyenne 7 j dans / au-dessus / en dessous de la base ± 1 écart-type */
export function hrvStatus(b: Baseline | undefined): Status | null {
  if (!b?.avg7 || b.mean === null || b.sd === null) return null;
  const low = b.mean - b.sd, high = b.mean + b.sd;
  if (b.avg7 < b.mean - 2 * b.sd) return { label: 'Basse', tone: 'critical', text: 'Nettement sous ta base : fatigue, stress ou début de maladie possible.' };
  if (b.avg7 < low) return { label: 'Déséquilibrée', tone: 'warning', text: 'Sous ta base cette semaine : privilégie la récupération.' };
  if (b.avg7 > high) return { label: 'Élevée', tone: 'neutral', text: 'Au-dessus de ta base : bonne récupération (ou repos inhabituel).' };
  return { label: 'Équilibrée', tone: 'good', text: 'Dans ta plage habituelle.' };
}

/** FC de repos : une hausse de plus de 3 bpm sur 7 jours est un signal de fatigue classique */
export function rhrStatus(b: Baseline | undefined): Status | null {
  if (!b?.avg7 || b.mean === null) return null;
  const diff = b.avg7 - b.mean;
  if (diff > 5) return { label: `+${diff.toFixed(1).replace('.', ',')} bpm`, tone: 'critical', text: 'FC de repos nettement au-dessus de ta base.' };
  if (diff > 3) return { label: `+${diff.toFixed(1).replace('.', ',')} bpm`, tone: 'warning', text: 'FC de repos en hausse : surveille fatigue et sommeil.' };
  const sign = diff >= 0 ? '+' : '−';
  return { label: `${sign}${Math.abs(diff).toFixed(1).replace('.', ',')} bpm`, tone: 'good', text: 'Dans ta plage habituelle.' };
}

/** Dette de sommeil sur 7 nuits par rapport à l'objectif (minutes) */
export function sleepDebt(h: Health, today: Date, goalMin = 450): { avg: number; debt: number; nights: number } | null {
  const nights: number[] = [];
  for (let i = 0; i < 7; i++) {
    const v = h.days[isoDay(addDays(today, -i))]?.sleepMin;
    if (v) nights.push(v);
  }
  if (!nights.length) return null;
  const avg = nights.reduce((s, x) => s + x, 0) / nights.length;
  return { avg, debt: nights.reduce((s, x) => s + Math.max(0, goalMin - x), 0), nights: nights.length };
}

export interface Bucket {
  label: string;
  n: number;
  /** Valeur moyenne de l'effet mesuré (en %) */
  mean: number | null;
}

function bucketize<T>(items: T[], buckets: { label: string; test: (x: T) => boolean }[], value: (x: T) => number): Bucket[] {
  return buckets.map((b) => {
    const xs = items.filter(b.test).map(value);
    return { label: b.label, n: xs.length, mean: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null };
  });
}

/**
 * Efficacité des sorties d'endurance (écart à leur référence, en %) selon la nuit précédente,
 * la VFC du matin et le score de préparation. Analyse exploratoire : peu de données.
 */
export function efByRecovery(ef: EfPoint[], h: Health, hrvBase: Map<string, Baseline>) {
  const rows = ef
    .map((p) => ({ p, day: h.days[p.activity.date] as HealthDay | undefined, base: hrvBase.get(p.activity.date) }))
    .filter((r) => r.day);
  const effect = (r: (typeof rows)[number]) => (r.p.ef / r.p.baseline - 1) * 100;
  return {
    sleep: bucketize(rows, [
      { label: '< 6 h', test: (r) => (r.day!.sleepMin ?? 0) > 0 && r.day!.sleepMin! < 360 },
      { label: '6 – 7 h', test: (r) => r.day!.sleepMin! >= 360 && r.day!.sleepMin! < 420 },
      { label: '7 – 8 h', test: (r) => r.day!.sleepMin! >= 420 && r.day!.sleepMin! < 480 },
      { label: '≥ 8 h', test: (r) => r.day!.sleepMin! >= 480 },
    ], effect),
    hrv: bucketize(rows, [
      { label: 'VFC basse', test: (r) => !!r.day!.hrv && !!r.base?.mean && r.day!.hrv! < r.base.mean - (r.base.sd ?? 0) },
      { label: 'VFC normale', test: (r) => !!r.day!.hrv && !!r.base?.mean && Math.abs(r.day!.hrv! - r.base.mean) <= (r.base.sd ?? 0) },
      { label: 'VFC haute', test: (r) => !!r.day!.hrv && !!r.base?.mean && r.day!.hrv! > r.base.mean + (r.base.sd ?? 0) },
    ], effect),
    readiness: bucketize(rows, [
      { label: 'Préparation < 50', test: (r) => r.day!.readiness !== undefined && r.day!.readiness < 50 },
      { label: '50 – 75', test: (r) => r.day!.readiness !== undefined && r.day!.readiness >= 50 && r.day!.readiness < 75 },
      { label: '≥ 75', test: (r) => r.day!.readiness !== undefined && r.day!.readiness >= 75 },
    ], effect),
  };
}

/**
 * VFC du lendemain selon la charge Coros de la veille, en écart (%) à la moyenne des 14 jours précédents
 * (référence locale, pour ne pas confondre l'effet de la séance avec la tendance de fond).
 */
export function hrvAfterLoad(acts: Activity[], h: Health): Bucket[] {
  const loadByDay = new Map<string, number>();
  for (const a of acts) loadByDay.set(a.date, (loadByDay.get(a.date) ?? 0) + (a.trainingLoad ?? 0));
  const rows: { load: number; delta: number }[] = [];
  for (const [date, day] of Object.entries(h.days)) {
    if (!day.hrv) continue;
    const d = parseDay(date);
    const prev: number[] = [];
    for (let i = 2; i <= 15; i++) {
      const v = h.days[isoDay(addDays(d, -i))]?.hrv;
      if (v) prev.push(v);
    }
    if (prev.length < 7) continue;
    const ref = prev.reduce((s, x) => s + x, 0) / prev.length;
    const yesterday = isoDay(addDays(d, -1));
    rows.push({ load: loadByDay.get(yesterday) ?? 0, delta: (day.hrv / ref - 1) * 100 });
  }
  return bucketize(rows, [
    { label: 'Repos', test: (r) => r.load === 0 },
    { label: 'Charge < 100', test: (r) => r.load > 0 && r.load < 100 },
    { label: '100 – 200', test: (r) => r.load >= 100 && r.load < 200 },
    { label: '≥ 200', test: (r) => r.load >= 200 },
  ], (r) => r.delta);
}

/** État le plus récent de l'export : jour, VFC et FC de repos avec leur base (pour l'onglet Aujourd'hui) */
export function healthNow(h: Health): { date: Date; day: HealthDay; hrv: Baseline | undefined; rhr: Baseline | undefined } | null {
  const keys = Object.keys(h.days).sort();
  if (!keys.length) return null;
  const last = parseDay(keys.at(-1)!);
  const from = addDays(last, -40);
  return {
    date: last,
    day: h.days[keys.at(-1)!],
    hrv: baselineSeries(h, 'hrv', from, last).at(-1),
    rhr: baselineSeries(h, 'rhr', from, last).at(-1),
  };
}

// ---------------------------------------------------------------------------
// Préparation du jour : score Google/Fitbit s'il existe, sinon estimé
// ---------------------------------------------------------------------------

export interface Readiness {
  score: number;
  /** Absent de la source (l'API Google Health ne le fournit pas) : calculé par RunStat */
  estimated: boolean;
  /** Nombre de jours de score Fitbit qui ont servi à caler l'estimation (0 : poids par défaut) */
  calibratedOn: number;
  /** Écart moyen (points) entre l'estimation et le score Fitbit sur ces jours */
  error: number | null;
}

/** Écarts du jour à la base personnelle (30 jours précédents) : VFC, FC de repos (inversée), sommeil en heures */
function readinessFeatures(h: Health, date: Date): [number, number, number] | null {
  const day = h.days[isoDay(date)];
  if (!day || day.hrv === undefined || day.rhr === undefined || day.sleepMin === undefined) return null;
  const base = (m: 'hrv' | 'rhr') => {
    const xs: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const v = h.days[isoDay(addDays(date, -i))]?.[m];
      if (typeof v === 'number') xs.push(v);
    }
    if (xs.length < 10) return null;
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) || 1;
    return { mean, sd };
  };
  const hrv = base('hrv'), rhr = base('rhr');
  if (!hrv || !rhr) return null;
  const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  return [
    clip((day.hrv - hrv.mean) / hrv.sd, -3, 3),
    clip(-(day.rhr - rhr.mean) / rhr.sd, -3, 3),
    clip((day.sleepMin - 450) / 60, -3, 1.5),
  ];
}

/** Poids par défaut (sans historique Fitbit) : 65 de base, la VFC compte le plus */
const DEFAULT_WEIGHTS = [65, 10, 6, 5];

/**
 * Moindres carrés : constante + 3 écarts, résolus par élimination de Gauss. Légère pénalité (ridge) sur les poids :
 * la VFC et la FC de repos bougent souvent ensemble, sans elle le système peut devenir singulier.
 */
function fit(rows: [number, number, number][], y: number[]): number[] | null {
  const n = 4;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  rows.forEach((r, k) => {
    const x = [1, ...r];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i][j] += x[i] * x[j];
      a[i][n] += x[i] * y[k];
    }
  });
  for (let i = 1; i < n; i++) a[i][i] += 1;
  for (let c = 0; c < n; c++) {
    const p = a.reduce((best, row, i) => (i >= c && Math.abs(row[c]) > Math.abs(a[best][c]) ? i : best), c);
    if (Math.abs(a[p][c]) < 1e-9) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = a[i][c] / a[c][c];
      for (let j = c; j <= n; j++) a[i][j] -= f * a[c][j];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

const calibration = new WeakMap<Health, { w: number[]; n: number; error: number | null }>();

/** Poids calés sur les jours où la source donnait son propre score (export Google Takeout / Fitbit) */
function weightsFor(h: Health): { w: number[]; n: number; error: number | null } {
  const cached = calibration.get(h);
  if (cached) return cached;
  const rows: [number, number, number][] = [], y: number[] = [];
  for (const [key, day] of Object.entries(h.days)) {
    if (typeof day.readiness !== 'number') continue;
    const f = readinessFeatures(h, parseDay(key));
    if (f) {
      rows.push(f);
      y.push(day.readiness);
    }
  }
  const w = rows.length >= 20 ? fit(rows, y) : null;
  const error = w ? rows.reduce((s, r, k) => s + Math.abs(w[0] + w[1] * r[0] + w[2] * r[1] + w[3] * r[2] - y[k]), 0) / rows.length : null;
  const out = w ? { w, n: rows.length, error } : { w: DEFAULT_WEIGHTS, n: 0, error: null };
  calibration.set(h, out);
  return out;
}

/**
 * Préparation d'un jour (0-100). Le score de la source quand il existe ; sinon une estimation à partir de la VFC,
 * de la FC de repos (écarts à ta base des 30 jours précédents) et de la durée de la nuit, avec des poids calés sur
 * ton historique de scores Fitbit quand il y en a au moins 20 jours.
 */
export function readinessFor(h: Health, date: Date): Readiness | null {
  const day = h.days[isoDay(date)];
  if (typeof day?.readiness === 'number') return { score: Math.round(day.readiness), estimated: false, calibratedOn: 0, error: null };
  const f = readinessFeatures(h, date);
  if (!f) return null;
  const { w, n, error } = weightsFor(h);
  const score = w[0] + w[1] * f[0] + w[2] * f[1] + w[3] * f[2];
  return { score: Math.round(Math.max(1, Math.min(99, score))), estimated: true, calibratedOn: n, error };
}
