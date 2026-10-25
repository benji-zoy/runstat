/**
 * Algorithmes d'analyse issus de la littérature et des outils de référence.
 * Chaque fonction cite sa source ; voir aussi l'onglet Labo.
 */
import { Activity, Athlete, Goal } from './models';
import { addDays, parseDay } from './stats';
import { C } from '../ui/palette';

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

// ---------------------------------------------------------------------------
// Daniels & Gilbert (Oxygen Power, 1979) : VDOT et prédictions
// ---------------------------------------------------------------------------

/** Coût en O2 (ml/kg/min) à la vitesse v (m/min) */
export function vo2AtSpeed(v: number): number {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

/** Fraction de VO2max soutenable pendant t minutes */
export function fractionVo2max(tMin: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
}

export function vdot(distM: number, tSec: number): number {
  const tMin = tSec / 60;
  return vo2AtSpeed(distM / tMin) / fractionVo2max(tMin);
}

/** Temps (s) prédit sur `distM` pour un VDOT donné (bissection) */
export function timeForVdot(v: number, distM: number): number {
  let lo = 60, hi = 8 * 3600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(distM, mid) > v) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Riegel (1981) et exposant personnel
// ---------------------------------------------------------------------------

export function riegel(t1: number, d1: number, d2: number, k = 1.06): number {
  return t1 * Math.pow(d2 / d1, k);
}

/** Exposant de fatigue personnel k = ln(t2/t1) / ln(d2/d1) */
export function personalExponent(t1: number, d1: number, t2: number, d2: number): number {
  return Math.log(t2 / t1) / Math.log(d2 / d1);
}

// ---------------------------------------------------------------------------
// Tanda (2011) : marathon à partir du volume et de l'allure des 8 dernières semaines
// ---------------------------------------------------------------------------

export function tanda(acts: Activity[], ref: Date): { seconds: number; kmPerWeek: number; paceSec: number } | null {
  const from = addDays(ref, -56);
  const window = acts.filter((a) => parseDay(a.date) > from && parseDay(a.date) <= ref);
  if (window.length < 8) return null;
  const km = window.reduce((s, a) => s + a.distanceKm, 0);
  // Le trail fausse l'allure moyenne : il compte dans le volume mais pas dans l'allure
  const flat = window.filter((a) => a.kind !== 'trail');
  const flatKm = flat.reduce((s, a) => s + a.distanceKm, 0);
  const K = km / 8;
  const P = flat.reduce((s, a) => s + a.durationSec, 0) / Math.max(1, flatKm);
  return { seconds: tandaPace(K, P) * 42.195, kmPerWeek: K, paceSec: P };
}

/** Allure marathon de Tanda (s/km) pour un volume K (km/sem) et une allure moyenne d'entraînement P (s/km) */
export function tandaPace(K: number, P: number): number {
  return 17.1 + 140.0 * Math.exp(-0.0053 * K) + 0.55 * P;
}

// ---------------------------------------------------------------------------
// Vickers & Vertosick (2016), modèle 1 : une course de référence + volume hebdo
// ---------------------------------------------------------------------------

export function vickers(tSec: number, distM: number, kmPerWeek: number): number {
  const vRiegel = 42195 / (tSec * Math.pow(42195 / distM, 1.07));
  const miles = kmPerWeek / 1.609344;
  const v = 0.16018617 + 0.83076202 * vRiegel + 0.06423826 * (miles / 10);
  return 42195 / v;
}

// ---------------------------------------------------------------------------
// Vitesse critique (Smyth & Muniz-Pumares 2020) : régression distance = CS·t + D'
// ---------------------------------------------------------------------------

export interface CriticalSpeed {
  cs: number;
  dPrime: number;
  r2: number;
  points: { dist: number; time: number }[];
}

export function criticalSpeed(points: { dist: number; time: number }[]): CriticalSpeed | null {
  const pts = points.filter((p) => p.time >= 120 && p.time <= 1500);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.time, 0) / n;
  const md = pts.reduce((s, p) => s + p.dist, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) {
    sxy += (p.time - mt) * (p.dist - md);
    sxx += (p.time - mt) ** 2;
    syy += (p.dist - md) ** 2;
  }
  const cs = sxy / sxx;
  return { cs, dPrime: md - cs * mt, r2: (sxy * sxy) / (sxx * syy), points: pts };
}

/** Meilleurs efforts FIT (ajustés à la pente) sur une fenêtre de jours */
export function bestEfforts(acts: Activity[], ref: Date, days: number | null, gap = true): Map<number, { time: number; activity: Activity }> {
  const out = new Map<number, { time: number; activity: Activity }>();
  for (const a of acts) {
    if (!a.fit || a.kind === 'indoor') continue;
    if (days !== null && daysBetween(parseDay(a.date), ref) > days) continue;
    const efforts = gap && Object.keys(a.fit.effortsGap).length ? a.fit.effortsGap : a.fit.efforts;
    for (const [d, t] of Object.entries(efforts)) {
      if (!t) continue;
      const dist = Number(d);
      const cur = out.get(dist);
      if (!cur || t < cur.time) out.set(dist, { time: t, activity: a });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Performances de référence : courses sur route (résumé) + meilleurs efforts FIT récents
// ---------------------------------------------------------------------------

export interface Reference {
  dist: number;
  time: number;
  date: string;
  label: string;
  vdot: number;
  source: 'course' | 'fit';
}

export function references(acts: Activity[], types: Map<string, SessionType>, ref: Date): Reference[] {
  const out: Reference[] = [];
  for (const a of acts) {
    if (types.get(a.id) !== 'race' || a.kind !== 'road' || daysBetween(parseDay(a.date), ref) > 540) continue;
    const dist = a.distanceKm * 1000;
    out.push({ dist, time: a.durationSec, date: a.date, label: a.name, vdot: vdot(dist, a.durationSec), source: 'course' });
  }
  for (const [dist, e] of bestEfforts(acts, ref, 112)) {
    if (dist < 3000) continue;
    out.push({ dist, time: e.time, date: e.activity.date, label: `${e.activity.name} (meilleur effort)`, vdot: vdot(dist, e.time), source: 'fit' });
  }
  return out.sort((a, b) => b.vdot - a.vdot);
}

// ---------------------------------------------------------------------------
// Mur du marathon et exposant de fatigue pondéré
// ---------------------------------------------------------------------------

const STANDARD_KM = [5, 10, 21.0975, 42.195];

/** Distance officielle (m) si la distance GPS est à moins de 4 % d'une distance standard */
export function officialDistance(km: number): number {
  const std = STANDARD_KM.find((d) => Math.abs(km - d) / d < 0.04);
  return (std ?? km) * 1000;
}

export interface WallAnalysis {
  wall: boolean;
  /** Kilomètre où commence le premier tronçon de 5 km effondré */
  wallKm: number | null;
  /** Dernier kilomètre tenu avant le ralentissement */
  preWallKm: number;
  /** Allure moyenne des 20 premiers km (s/km) */
  basePace: number;
  /** Ralentissement du pire tronçon de 5 km après le 25e km */
  fade: number;
  /** Temps estimé sans le mur : la partie tenue prolongée avec Riegel (k = 1,06) */
  potential: number | null;
}

/**
 * Détection du « mur » à partir des splits au km : un tronçon de 5 km après le 25e
 * au moins 20 % plus lent que les 20 premiers km (inspiré de Smyth 2018).
 */
export function wallAnalysis(a: Activity): WallAnalysis | null {
  const s = a.splits;
  if (!s || s.length < 25) return null;
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const base = mean(s.slice(0, 20));
  let worst = 0;
  let wallKm: number | null = null;
  for (let i = 24; i + 5 <= s.length; i++) {
    const seg = mean(s.slice(i, i + 5));
    worst = Math.max(worst, seg);
    if (wallKm === null && seg >= 1.2 * base) wallKm = i + 1;
  }
  const fade = worst ? worst / base : 1;
  if (wallKm === null) return { wall: false, wallKm: null, preWallKm: s.length, basePace: base, fade, potential: null };
  // Dernier km avant le premier split plus lent de 8 % que l'allure de base
  let pre = s.findIndex((x, i) => i >= 20 && x > 1.08 * base);
  if (pre < 0 || pre > wallKm) pre = wallKm - 1;
  const held = s.slice(0, pre).reduce((t, x) => t + x, 0);
  const potential = riegel(held, pre, a.distanceKm);
  return { wall: true, wallKm, preWallKm: pre, basePace: base, fade, potential };
}

/** Valeur a priori de l'exposant pour un coureur amateur (Vickers & Vertosick 2016) */
export const PRIOR_EXPONENT = 1.07;

export interface ExponentPart {
  label: string;
  date: string;
  k: number;
  weight: number;
  note: string;
}

export interface ExponentEstimate {
  /** Exposant retenu : moyenne pondérée de l'a priori et des courses longues */
  k: number;
  /** Exposant brut, sur les chronos réels sans pondération */
  raw: number;
  short: Reference;
  parts: ExponentPart[];
}

/**
 * Exposant de fatigue personnel, pondéré : l'a priori (1,07, poids 1) est combiné aux exposants
 * mesurés entre ta meilleure course courte et chaque course longue (≥ 2× plus longue).
 * Une course avec un mur compte avec son temps « potentiel » et un poids divisé par deux ;
 * `raceWeights` (athlete.json) permet de forcer le poids d'une course.
 */
export function personalExponentFromRaces(
  acts: Activity[],
  types: Map<string, SessionType>,
  ath: Athlete,
  ref: Date,
): ExponentEstimate | null {
  const races = acts
    .filter((a) => types.get(a.id) === 'race' && a.kind === 'road' && daysBetween(parseDay(a.date), ref) <= 730)
    .filter((a) => (ath.raceWeights?.[a.id] ?? 1) > 0)
    .map((a) => ({ a, dist: officialDistance(a.distanceKm) }));
  const shorts = races.filter((r) => r.dist <= 10500);
  if (!shorts.length) return null;
  const best = shorts.reduce((m, r) => (vdot(r.dist, r.a.durationSec) > vdot(m.dist, m.a.durationSec) ? r : m));
  const short: Reference = {
    dist: best.dist, time: best.a.durationSec, date: best.a.date, label: best.a.name,
    vdot: vdot(best.dist, best.a.durationSec), source: 'course',
  };
  const longs = races.filter((r) => r.dist >= 2 * short.dist);
  if (!longs.length) return null;

  const parts: ExponentPart[] = [{ label: 'A priori coureur amateur', date: '', k: PRIOR_EXPONENT, weight: 1, note: 'Vickers & Vertosick 2016' }];
  let raw = 0;
  for (const r of longs) {
    const wall = wallAnalysis(r.a);
    const forced = ath.raceWeights?.[r.a.id];
    const time = wall?.wall && wall.potential ? wall.potential : r.a.durationSec;
    const weight = forced ?? (wall?.wall ? 0.5 : 1);
    raw = personalExponent(short.time, short.dist, r.a.durationSec, r.dist);
    parts.push({
      label: r.a.name,
      date: r.a.date,
      k: personalExponent(short.time, short.dist, time, r.dist),
      weight,
      note: wall?.wall
        ? `mur au ${wall.wallKm}e km : temps potentiel ${Math.floor(time / 3600)} h ${String(Math.round((time % 3600) / 60)).padStart(2, '0')} au lieu du chrono réel`
        : forced !== undefined ? 'poids forcé dans athlete.json' : 'chrono réel',
    });
  }
  const wSum = parts.reduce((t, p) => t + p.weight, 0);
  const k = parts.reduce((t, p) => t + p.k * p.weight, 0) / wSum;
  return { k, raw, short, parts };
}

// ---------------------------------------------------------------------------
// VO2max « effective » façon Runalyze (FC moyenne + vitesse), corrigée sur les courses
// ---------------------------------------------------------------------------

/** VO2max non corrigée déduite de la FC moyenne et de la vitesse d'une sortie */
export function vo2maxFromHr(a: Activity, ath: Athlete): number | null {
  if (!a.avgHr || a.distanceKm < 2 || a.durationSec < 15 * 60 || a.kind === 'indoor') return null;
  const ratio = a.avgHr / ath.hrMax;
  if (ratio < 0.6 || ratio > 1) return null;
  const pct = Math.exp((ratio - 1.00466) / 0.68725);
  // Vitesse ajustée à la pente si le fichier FIT est disponible
  const meters = a.fit?.gapDistance ?? a.distanceKm * 1000;
  const v = meters / (a.durationSec / 60) / pct;
  return vo2AtSpeed(v);
}

/**
 * Facteur de correction (Runalyze) : rapport entre le VDOT réel des courses sur route
 * et la VO2max estimée par la FC sur ces mêmes courses (médiane des 3 plus récentes).
 */
export function vo2maxCorrection(acts: Activity[], ath: Athlete, types: Map<string, SessionType>): number {
  const ratios = acts
    .filter((a) => types.get(a.id) === 'race' && a.kind === 'road' && a.distanceKm >= 3)
    .map((a) => {
      const hrEst = vo2maxFromHr(a, ath);
      return hrEst ? vdot(a.distanceKm * 1000, a.durationSec) / hrEst : null;
    })
    .filter((r): r is number => r !== null)
    .slice(-3)
    .sort((x, y) => x - y);
  if (!ratios.length) return 0.92;
  return Math.min(1.05, Math.max(0.8, ratios[Math.floor(ratios.length / 2)]));
}

/**
 * Indice de forme FC/allure : VO2max estimée par la FC, moyennée sur 30 jours et pondérée par la durée.
 * `factor` permet d'appliquer la correction de Runalyze ; par défaut l'indice n'est pas corrigé.
 */
export function vo2maxCurve(acts: Activity[], ath: Athlete, today: Date, factor = 1): { date: Date; value: number }[] {
  const est = acts
    .map((a) => ({ a, v: vo2maxFromHr(a, ath) }))
    .filter((x): x is { a: Activity; v: number } => x.v !== null);
  if (!est.length) return [];
  const out: { date: Date; value: number }[] = [];
  const start = parseDay(est[0].a.date);
  for (let d = addDays(start, 30); d <= today; d = addDays(d, 7)) {
    const win = est.filter((x) => {
      const age = daysBetween(parseDay(x.a.date), d);
      return age >= 0 && age < 30;
    });
    if (win.length < 3) continue;
    const w = win.reduce((s, x) => s + x.a.durationSec, 0);
    out.push({ date: d, value: (win.reduce((s, x) => s + x.v * x.a.durationSec, 0) / w) * factor });
  }
  return out;
}

// ---------------------------------------------------------------------------
// « Marathon shape » de Runalyze : préparation au marathon selon volume et sorties longues
// ---------------------------------------------------------------------------

export function marathonShape(acts: Activity[], vo2max: number, today: Date): { shape: number; weekly: number; weeklyTarget: number; longTarget: number } {
  const weeklyTarget = Math.pow(vo2max, 1.135);
  const longTarget = 12 * Math.log(vo2max / 4);
  const last182 = acts.filter((a) => daysBetween(parseDay(a.date), today) < 182);
  const first = last182[0] ? daysBetween(parseDay(last182[0].date), today) : 0;
  const span = Math.max(70, Math.min(182, first + 1));
  const weekly = (last182.reduce((s, a) => s + a.distanceKm, 0) / span) * 7;
  let longScore = 0;
  for (const a of acts) {
    const age = daysBetween(parseDay(a.date), today);
    if (age < 0 || age >= 70 || a.distanceKm <= 13) continue;
    longScore += (2 - (2 * age) / 70) * Math.pow((a.distanceKm - 13) / Math.max(1, longTarget - 13), 2);
  }
  longScore *= 7 / 70;
  const shape = 100 * (0.67 * Math.min(1.5, weekly / weeklyTarget) + 0.33 * Math.min(1.5, longScore));
  return { shape, weekly, weeklyTarget, longTarget };
}

// ---------------------------------------------------------------------------
// Charge : TRIMP de Banister, monotonie & strain de Foster, ACWR (EWMA)
// ---------------------------------------------------------------------------

/** TRIMP de Banister : seconde par seconde si FIT, sinon à partir de la FC moyenne */
export function trimp(a: Activity, ath: Athlete): number | null {
  if (a.fit?.trimp) return a.fit.trimp;
  if (!a.avgHr) return null;
  const hrr = Math.max(0, Math.min(1, (a.avgHr - ath.hrRest) / (ath.hrMax - ath.hrRest)));
  const [k, b] = ath.sex === 'F' ? [0.86, 1.67] : [0.64, 1.92];
  return (a.durationSec / 60) * hrr * k * Math.exp(b * hrr);
}

/** Charge journalière (charge Coros par défaut) sur une plage de jours */
export function dailyLoads(acts: Activity[], from: Date, to: Date, load: (a: Activity) => number | null): number[] {
  const byDay = new Map<string, number>();
  for (const a of acts) byDay.set(a.date, (byDay.get(a.date) ?? 0) + (load(a) ?? 0));
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(byDay.get(k) ?? 0);
  }
  return out;
}

/** Monotonie (moyenne / écart-type sur 7 jours) et strain (charge hebdo × monotonie), Foster 1998 */
export function foster(week: number[]): { monotony: number; strain: number; load: number } {
  const load = week.reduce((s, x) => s + x, 0);
  const mean = load / week.length;
  const sd = Math.sqrt(week.reduce((s, x) => s + (x - mean) ** 2, 0) / week.length);
  const monotony = sd > 0 ? mean / sd : 0;
  return { monotony, strain: load * monotony, load };
}

/** Ratio charge aiguë / chronique en moyennes exponentielles (Williams 2017) */
export function acwr(daily: number[]): number[] {
  const la = 2 / (7 + 1), lc = 2 / (28 + 1);
  let a = 0, c = 0;
  return daily.map((x) => {
    a = la * x + (1 - la) * a;
    c = lc * x + (1 - lc) * c;
    return c > 0 ? a / c : 0;
  });
}

// ---------------------------------------------------------------------------
// Classification automatique des séances (règles inspirées de la littérature)
// ---------------------------------------------------------------------------

export type SessionType = 'race' | 'interval' | 'tempo' | 'long' | 'trail' | 'recovery' | 'easy';

export const SESSION_TYPES: Record<SessionType, { label: string; icon: string; color: string }> = {
  race: { label: 'Course / test', icon: '🏁', color: C.bad },
  interval: { label: 'Fractionné', icon: '⚡', color: C.amber },
  tempo: { label: 'Tempo / seuil', icon: '🎯', color: C.s6 },
  long: { label: 'Sortie longue', icon: '🛣️', color: C.s5 },
  trail: { label: 'Trail', icon: '⛰️', color: C.s3 },
  recovery: { label: 'Récupération', icon: '🧘', color: C.muted },
  easy: { label: 'Endurance', icon: '🙂', color: C.s1 },
};

// « Semi des Collines 2025 » : les événements portent souvent leur millésime en fin de nom
const RACE_NAME = /(marathon|semi|10 ?km|5 ?km|trail des|foulées|corrida|ekiden|cross|race|run in|\b20\d\d$)/i;
// Noms de séances d'entraînement, y compris ceux des plans Coros (« 10KM-S3-4-Sortie Longue »)
const WORKOUT_NAME = /(allure|intervalle|fraction|vma|séance|répétition|seuil|tempo|endurance|sortie longue|fondament|foulées|-s\d+-|\d+ ?x ?\d)/i;

export function classify(a: Activity, medianKm: number, ath: Athlete): SessionType {
  const hrPct = a.avgHr ? a.avgHr / ath.hrMax : 0;
  const dPlusPerKm = (a.elevGain ?? 0) / Math.max(0.1, a.distanceKm);
  const hard = hrPct >= 0.8 || a.focus === 'Threshold' || a.focus === 'VO2 Max' || (a.anaerobicTE ?? 0) >= 3;
  if (RACE_NAME.test(a.name) && !WORKOUT_NAME.test(a.name) && hard) return 'race';
  if (a.kind === 'trail' || dPlusPerKm > 25) return 'trail';
  if ((a.fit?.lapCv ?? 0) > 0.12 || (a.anaerobicTE ?? 0) >= 3.5 || a.focus === 'Anaerobic' || a.focus === 'VO2 Max' || /vma|fraction|intervalle|répétition|\d+ ?x ?\d/i.test(a.name)) {
    return 'interval';
  }
  if (a.durationSec >= 90 * 60 || a.distanceKm >= 1.6 * medianKm) return 'long';
  if (a.focus === 'Tempo' || a.focus === 'Threshold') return 'tempo';
  if (a.focus === 'Recovery' || (a.distanceKm < 0.7 * medianKm && hrPct > 0 && hrPct < 0.75)) return 'recovery';
  return 'easy';
}

/** Classification de toutes les sorties, avec la médiane glissante des 8 semaines précédentes */
export function classifyAll(acts: Activity[], ath: Athlete): Map<string, SessionType> {
  const out = new Map<string, SessionType>();
  for (const a of acts) {
    const d = parseDay(a.date);
    const window = acts.filter((x) => {
      const age = daysBetween(parseDay(x.date), d);
      return age > 0 && age <= 56;
    });
    const kms = window.map((x) => x.distanceKm).sort((x, y) => x - y);
    const median = kms.length ? kms[Math.floor(kms.length / 2)] : a.distanceKm;
    out.set(a.id, classify(a, median, ath));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Efficacité (Efficiency Factor de Friel) et détection d'anomalies
// ---------------------------------------------------------------------------

/** EF = vitesse (m/min, ajustée à la pente si possible) / FC moyenne */
export function efficiency(a: Activity): number | null {
  if (!a.avgHr) return null;
  const meters = a.fit?.gapDistance ?? a.distanceKm * 1000;
  return meters / (a.durationSec / 60) / a.avgHr;
}

/** Sorties comparables pour suivre l'EF : endurance sur route, plat, 30 à 100 min */
export function isComparableEasy(a: Activity, type: SessionType | undefined): boolean {
  const dPlusPerKm = (a.elevGain ?? 0) / Math.max(0.1, a.distanceKm);
  return (
    (type === 'easy' || type === 'long' || type === 'recovery') &&
    a.kind === 'road' &&
    dPlusPerKm < 12 &&
    a.durationSec >= 30 * 60 &&
    a.durationSec <= 100 * 60 &&
    !!a.avgHr
  );
}

export interface EfPoint {
  activity: Activity;
  ef: number;
  baseline: number;
  /** Score z robuste (MAD) de l'écart à la référence */
  z: number;
}

/** EF des sorties comparables, avec une référence = médiane des 15 précédentes */
export function efSeries(acts: Activity[], types: Map<string, SessionType>): EfPoint[] {
  const pts = acts.filter((a) => isComparableEasy(a, types.get(a.id))).map((a) => ({ a, ef: efficiency(a)! }));
  const out: EfPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts.slice(Math.max(0, i - 15), i).map((p) => p.ef);
    if (prev.length < 5) continue;
    const sorted = [...prev].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    const mad = [...prev.map((x) => Math.abs(x - med))].sort((x, y) => x - y)[Math.floor(prev.length / 2)] || 0.01;
    out.push({ activity: pts[i].a, ef: pts[i].ef, baseline: med, z: (0.6745 * (pts[i].ef - med)) / mad });
  }
  return out;
}

/** Pente de Theil-Sen (variation par jour) : tendance robuste aux valeurs aberrantes */
export function theilSen(points: { x: number; y: number }[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (points[j].x !== points[i].x) slopes.push((points[j].y - points[i].y) / (points[j].x - points[i].x));
    }
  }
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  const m = slopes.length >> 1;
  return slopes.length % 2 ? slopes[m] : (slopes[m - 1] + slopes[m]) / 2;
}

// ---------------------------------------------------------------------------
// Chaleur (règle de Hadley : température + point de rosée en °F) et trail (km-effort ITRA)
// ---------------------------------------------------------------------------

const HADLEY: [number, number][] = [
  [100, 0], [110, 0.5], [120, 1], [130, 2], [140, 3], [150, 4.5], [160, 6], [170, 8], [180, 10], [200, 12],
];

/** Ralentissement attendu (%) dû à la chaleur et à l'humidité */
export function heatPenalty(tempC: number, dewC: number): number {
  const sum = (tempC * 9) / 5 + 32 + (dewC * 9) / 5 + 32;
  if (sum <= HADLEY[0][0]) return 0;
  for (let i = 1; i < HADLEY.length; i++) {
    const [x1, y1] = HADLEY[i];
    const [x0, y0] = HADLEY[i - 1];
    if (sum <= x1) return y0 + ((sum - x0) / (x1 - x0)) * (y1 - y0);
  }
  return HADLEY.at(-1)![1];
}

/** Allure (s/km) ramenée à des conditions idéales, comme le « rapport Enduraw » */
export function heatAdjustedPace(a: Activity): number | null {
  if (!a.weather) return null;
  const pace = a.durationSec / ((a.fit?.gapDistance ?? a.distanceKm * 1000) / 1000);
  return pace / (1 + heatPenalty(a.weather.temp, a.weather.dew) / 100);
}

/**
 * Km-effort : distance + D+ / 100 (ITRA) + D− / 300, pour ne pas invisibiliser la descente, grosse part d'un trail.
 * D− absent : on suppose une boucle (D− = D+).
 */
export function kmEffortOf(distanceKm: number, elevGain?: number | null, elevLoss?: number | null): number {
  const up = elevGain ?? 0;
  return distanceKm + up / 100 + (elevLoss ?? up) / 300;
}

export function kmEffort(a: Activity): number {
  return kmEffortOf(a.distanceKm, a.elevGain, a.elevLoss);
}

export const goalKmEffort = (g: Goal) => kmEffortOf(g.distanceKm, g.elevGain, g.elevLoss);

/** Index de polarisation (Treff et al. 2019) ; > 2 = polarisé */
export function polarizationIndex(z: number[]): number | null {
  const total = z.reduce((s, x) => s + x, 0);
  if (!total) return null;
  const [z1, z2, z3] = z.map((x) => x / total);
  if (z3 === 0) return null;
  return Math.log10((z1 / Math.max(z2, 0.01)) * z3 * 100);
}
