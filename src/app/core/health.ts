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
