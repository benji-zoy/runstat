/**
 * Ta courbe vitesse / pente : coût relatif de chaque pente (1 = plat) à effort égal, mesuré sur tes FIT.
 *
 * Base commune : en montée, le coût énergétique de Minetti (2002), adouci au-delà de 15 % (on marche, et un coût
 * uniforme surestime les pentes extrêmes) ; en descente, le GAP révisé de Strava (2017, millions de sorties) : le
 * gain plafonne vers −9 % (×0,88) et redevient nul vers −18 %, là où Minetti promettait de courir deux fois plus vite.
 * Puis correction personnelle par tranche de pente (`fit.terrain` des 12 derniers mois) : vitesse ramenée à la FC du
 * plat (vitesse ∝ FC − FC de repos), rapportée à ta vitesse sur le plat, et rapprochée de la base tant que le temps
 * passé dans la tranche est court (30 min pèsent autant que la base).
 *
 * Sert de « distance équivalent plat » pour comparer une course à tes sorties : sur un parcours roulant, le km-effort
 * (100 m D+ = 1 km, 300 m D− = 1 km) surestime nettement l'effort, il le sous-estime sur un parcours très raide.
 */
import { Activity, Athlete } from './models';
import { CourseInput, Segment, courseSegments } from './course';
import { isTrailRun } from './durability';
import { parseDay } from './stats';

const PRIOR: [number, number][] = [
  [-0.3, 1.35], [-0.2, 1.1], [-0.15, 1], [-0.09, 0.9], [-0.05, 0.93], [-0.02, 0.97], [0, 1],
  [0.02, 1.07], [0.05, 1.2], [0.08, 1.38], [0.11, 1.6], [0.15, 1.9], [0.2, 2.3], [0.3, 3.1],
];

function interp(pts: [number, number][], x: number): number {
  if (x <= pts[0][0]) {
    const [[x0, y0], [x1, y1]] = pts;
    return y0 + ((y1 - y0) / (x1 - x0)) * (x - x0);
  }
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  const [x0, y0] = pts[pts.length - 2], [x1, y1] = pts[pts.length - 1];
  return y1 + ((y1 - y0) / (x1 - x0)) * (x - x1);
}

/** Coût relatif d'une pente, base commune */
export const priorCost = (grade: number) => Math.max(0.7, interp(PRIOR, Math.max(-0.45, Math.min(0.45, grade))));

/** Secondes de données qui pèsent autant que la base commune */
const PRIOR_SEC = 1800;

export interface TerrainPoint {
  /** Pente moyenne de la tranche */
  grade: number;
  /** Coût personnel retenu (après rapprochement de la base) */
  cost: number;
  prior: number;
  sec: number;
}

export interface Terrain {
  trail: boolean;
  cost: (grade: number) => number;
  points: TerrainPoint[];
  /** Vitesse sur le plat (m/s) et FC moyenne correspondante, toutes sorties de la courbe */
  flatSpeed: number | null;
  flatHr: number | null;
  /** Vitesse sur le plat route / trail à FC égale (1,1 = 10 % plus lent sur les sentiers) */
  surface: number | null;
  /** Heures de données */
  hours: number;
}

type Bins = number[][];

function sumBins(acts: Activity[]): Bins {
  const s: Bins = Array.from({ length: 7 }, () => [0, 0, 0, 0, 0, 0, 0]);
  for (const a of acts) a.fit!.terrain!.forEach((b, i) => b.forEach((x, j) => (s[i][j] += x)));
  return s;
}

const FLAT = 3;

/** Vitesse d'une tranche ramenée à la FC `hrRef` (vitesse ∝ FC − FC de repos) */
function speedAt(b: number[], hrRef: number | null, hrRest: number): number {
  const v = b[1] / b[0];
  const hr = b[5] ? b[6] / b[5] : null;
  if (!hrRef || !hr || hr - hrRest < 20 || hrRef - hrRest < 20) return v;
  return (v * (hrRef - hrRest)) / (hr - hrRest);
}

export function personalTerrain(all: Activity[], ref: Date, athlete: Athlete, trail: boolean): Terrain {
  const since = ref.getTime() - 365 * 86_400_000;
  const recent = all.filter((a) => a.fit?.terrain?.length === 7 && parseDay(a.date).getTime() > since && parseDay(a.date) <= ref);
  const group = (t: boolean) => recent.filter((a) => isTrailRun(a) === t);
  let acts = group(trail);
  let bins = sumBins(acts);
  if (bins[FLAT][0] < 3600) {
    acts = recent;
    bins = sumBins(acts);
  }
  const flat = bins[FLAT];
  const rest = athlete.hrRest;
  const flatHr = flat[5] ? flat[6] / flat[5] : null;
  const flatSpeed = flat[0] >= 600 ? flat[1] / flat[0] : null;

  const corr: [number, number][] = [];
  const points: TerrainPoint[] = [];
  if (flatSpeed) {
    for (const b of bins) {
      if (b[0] < 300 || b[1] < 200) continue;
      const grade = (b[3] - b[4]) / b[1];
      const raw = flatSpeed / speedAt(b, flatHr, rest);
      const prior = priorCost(grade);
      const w = b[0] / (b[0] + PRIOR_SEC);
      const c = Math.exp(w * Math.log(raw / prior));
      corr.push([grade, c]);
      points.push({ grade, cost: prior * c, prior, sec: b[0] });
    }
  }
  corr.sort((a, b) => a[0] - b[0]);
  const correction = (g: number) => {
    if (!corr.length) return 1;
    if (g <= corr[0][0]) return corr[0][1];
    if (g >= corr[corr.length - 1][0]) return corr[corr.length - 1][1];
    return interp(corr, g);
  };

  // Surface : vitesse sur le plat des sorties route et trail, ramenées à la même FC
  let surface: number | null = null;
  const road = sumBins(group(false))[FLAT], tr = sumBins(group(true))[FLAT];
  if (road[0] >= 3600 && tr[0] >= 1800) {
    const hrRef = road[5] ? road[6] / road[5] : null;
    const ratio = speedAt(road, hrRef, rest) / speedAt(tr, hrRef, rest);
    const w = tr[0] / (tr[0] + 3 * 3600);
    surface = Math.min(1.3, Math.max(1, Math.exp(w * Math.log(ratio))));
  }
  return {
    trail,
    cost: (g) => priorCost(g) * correction(g),
    points,
    flatSpeed,
    flatHr,
    surface,
    hours: acts.reduce((s, a) => s + a.fit!.terrain!.reduce((t, b) => t + b[0], 0), 0) / 3600,
  };
}

/** Distance équivalent plat (km) d'une liste de tronçons */
export function segmentsEffortKm(segs: Segment[], cost: (g: number) => number): number {
  return segs.reduce((s, x) => s + (x.to - x.from) * cost(x.grade), 0);
}

export function courseEffortKm(c: CourseInput, cost: (g: number) => number): number {
  return segmentsEffortKm(courseSegments(c), cost);
}

/** Distance équivalent plat d'une sortie : ses tranches de pente (FIT), sinon son D+ et son D− */
export function activityEffortKm(a: Activity, cost: (g: number) => number): number {
  const t = a.fit?.terrain;
  const dist = t?.reduce((s, b) => s + b[1], 0) ?? 0;
  if (t && dist > 0.6 * a.distanceKm * 1000) {
    const eq = t.reduce((s, b) => s + (b[1] > 0 ? b[1] * cost((b[3] - b[4]) / b[1]) : 0), 0);
    return (eq / dist) * a.distanceKm;
  }
  return courseEffortKm({ distanceKm: a.distanceKm, elevGain: a.elevGain ?? 0, elevLoss: a.elevLoss ?? a.elevGain ?? 0, kind: isTrailRun(a) ? 'trail' : 'road' }, cost);
}
