/**
 * Barème FFA des courses sur route (classement des clubs, barème au 1er janvier 2010 publié sur athle.fr,
 * htmlid=125 pour les hommes, 122 pour les femmes) : 23 niveaux de IA à D7, toutes catégories d'âge confondues.
 * C'est le barème que MyDataRun reprend « du niveau départemental jusqu'au niveau international ».
 */
import { Activity } from './models';
import { parseDay } from './stats';

export const FFA_LEVELS = [
  'IA', 'IB', 'N1', 'N2', 'N3', 'N4', 'IR1', 'IR2', 'IR3', 'IR4',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
] as const;
export type FfaLevel = (typeof FFA_LEVELS)[number];

/** Points rapportés au club par niveau (même ordre que FFA_LEVELS) */
export const FFA_POINTS = [40, 35, 30, 28, 26, 24, 21, 20, 19, 18, 15, 14, 13, 12, 11, 10, 8, 7, 6, 5, 4, 3, 2];

/** Temps limites recopiés tels quels du barème (le temps doit être inférieur ou égal) */
const RAW: Record<'M' | 'F', Record<number, string[]>> = {
  M: {
    5000: ["13'10", "13'25", "13'45", "14'00", "14'20", "14'40", "15'00", "15'20", "15'40", "16'00", "16'20", "16'40", "17'00", "17'20", "17'40", "18'00", "18'20", "18'40", "19'10", "19'40", "20'10", "21'00", "22'00"],
    10000: ["27'50", "28'15", "29'00", "29'45", "30'30", "31'15", "32'00", "32'45", "33'30", "34'15", "35'00", "35'45", "36'30", "37'15", "38'00", "38'45", "39'30", "40'30", "41'30", "43'00", "45'00", "47'00", "50'00"],
    15000: ["43'30", "44'00", "44'30", "45'40", "46'50", "48'00", "49'10", "50'20", "51'30", "52'40", "53'50", "55'00", "56'10", "57'20", "58'30", "59'45", "1h01'00", "1h03'00", "1h05'00", "1h07'00", "1h11'00", "1h14'00", "1h18'00"],
    20000: ["58'30", "59'15", "1h01'00", "1h02'15", "1h03'30", "1h05'00", "1h07'00", "1h08'30", "1h10'00", "1h11'30", "1h13'00", "1h14'30", "1h16'00", "1h18'00", "1h19'30", "1h22'30", "1h25'30", "1h29'00", "1h32'00", "1h36'00", "1h40'00", "1h45'00", "1h50'00"],
    21097: ["1h01'30", "1h02'15", "1h04'00", "1h05'30", "1h07'00", "1h08'30", "1h10'30", "1h12'30", "1h14'00", "1h15'30", "1h17'30", "1h19'00", "1h20'30", "1h22'30", "1h24'00", "1h27'00", "1h30'00", "1h34'00", "1h37'00", "1h41'00", "1h45'00", "1h50'00", "1h55'00"],
    42195: ["2h10'00", "2h12'30", "2h15'00", "2h20'00", "2h24'00", "2h28'00", "2h32'00", "2h36'00", "2h40'00", "2h44'00", "2h48'00", "2h53'00", "2h58'00", "3h03'00", "3h08'00", "3h14'00", "3h20'00", "3h26'00", "3h34'00", "3h42'00", "3h50'00", "4h00'00", "4h10'00"],
  },
  F: {
    5000: ["15'10", "15'30", "16'30", "17'00", "17'20", "17'40", "18'00", "18'20", "18'40", "19'00", "19'20", "19'40", "20'00", "20'20", "20'40", "21'00", "21'30", "22'00", "22'45", "23'30", "24'00", "25'00", "26'00"],
    10000: ["31'40", "32'40", "34'00", "35'00", "36'00", "37'00", "38'00", "39'00", "40'00", "41'00", "42'00", "43'00", "44'00", "45'00", "46'00", "47'00", "48'00", "49'00", "50'00", "52'00", "54'00", "56'00", "1h00'00"],
    15000: ["50'00", "50'45", "52'30", "54'00", "55'30", "57'00", "58'30", "1h00'00", "1h01'30", "1h03'00", "1h04'30", "1h06'00", "1h07'30", "1h09'00", "1h10'30", "1h12'00", "1h14'00", "1h15'30", "1h17'00", "1h18'30", "1h20'00", "1h23'00", "1h26'00"],
    20000: ["1h06'40", "1h08'25", "1h11'00", "1h13'30", "1h16'00", "1h18'00", "1h20'30", "1h22'30", "1h24'00", "1h26'30", "1h28'00", "1h30'30", "1h32'30", "1h34'00", "1h35'30", "1h37'30", "1h40'00", "1h42'30", "1h45'00", "1h50'00", "1h55'00", "2h00'00", "2h05'00"],
    21097: ["1h10'00", "1h12'00", "1h14'30", "1h17'00", "1h19'30", "1h22'00", "1h24'30", "1h26'30", "1h28'30", "1h30'30", "1h32'30", "1h34'30", "1h36'30", "1h38'30", "1h40'30", "1h42'30", "1h45'00", "1h47'30", "1h50'00", "1h55'00", "2h00'00", "2h05'00", "2h10'00"],
    42195: ["2h29'00", "2h32'00", "2h40'00", "2h48'00", "2h56'00", "3h04'00", "3h12'00", "3h18'00", "3h24'00", "3h32'00", "3h38'00", "3h44'00", "3h50'00", "3h56'00", "4h02'00", "4h08'00", "4h14'00", "4h20'00", "4h26'00", "4h32'00", "4h40'00", "4h50'00", "5h00'00"],
  },
};

/** « 1h37'00 » → 5820 s */
export function parseFfaTime(s: string): number {
  const m = s.match(/^(?:(\d+)h)?(\d+)'(\d+)?$/);
  if (!m) throw new Error(`Temps FFA illisible : ${s}`);
  return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0);
}

const TABLES = Object.fromEntries(
  (['M', 'F'] as const).map((sex) => [sex, Object.fromEntries(Object.entries(RAW[sex]).map(([d, ts]) => [d, ts.map(parseFfaTime)]))]),
) as Record<'M' | 'F', Record<string, number[]>>;

/** Temps limites (s) d'une distance, de IA à D7 */
export function ffaLimits(sex: 'M' | 'F', distM: number): number[] | null {
  return TABLES[sex][distM] ?? null;
}

export const FFA_DISTANCES = [5000, 10000, 15000, 20000, 21097, 42195];
export const FFA_DISTANCE_LABELS: Record<number, string> = {
  5000: '5 km', 10000: '10 km', 15000: '15 km', 20000: '20 km', 21097: 'Semi-marathon', 42195: 'Marathon',
};

/** Distance du barème correspondant à une distance mesurée (± 4 %, comme `officialDistance`) */
export function ffaDistance(km: number): number | null {
  return FFA_DISTANCES.find((d) => Math.abs(km * 1000 - d) / d < 0.04) ?? null;
}

export interface FfaGrade {
  /** Niveau atteint (null : plus lent que D7) */
  level: FfaLevel | null;
  /** Échelon : International, National… */
  tier: string | null;
  points: number;
  /** Niveau suivant et temps à réaliser pour l'atteindre */
  next: FfaLevel | null;
  nextSec: number | null;
}

export function ffaTier(level: FfaLevel): string {
  return level.startsWith('I') && !level.startsWith('IR')
    ? 'International'
    : level.startsWith('N') ? 'National' : level.startsWith('IR') ? 'Interrégional' : level.startsWith('R') ? 'Régional' : 'Départemental';
}

export function ffaGrade(sex: 'M' | 'F', distM: number, sec: number): FfaGrade | null {
  const table = TABLES[sex][distM];
  if (!table) return null;
  const idx = table.findIndex((limit) => sec <= limit);
  const level = idx >= 0 ? FFA_LEVELS[idx] : null;
  const nextIdx = idx >= 0 ? idx - 1 : table.length - 1;
  return {
    level,
    tier: level ? ffaTier(level) : null,
    points: idx >= 0 ? FFA_POINTS[idx] : 0,
    next: nextIdx >= 0 ? FFA_LEVELS[nextIdx] : null,
    nextSec: nextIdx >= 0 ? table[nextIdx] : null,
  };
}

/** Rang du niveau (0 = IA) pour comparer deux niveaux ; plus lent que D7 = 23 */
export const levelRank = (l: FfaLevel | null) => (l ? FFA_LEVELS.indexOf(l) : FFA_LEVELS.length);

export interface RacePerformance {
  activity: Activity;
  distM: number;
  /** Temps retenu et sa provenance */
  sec: number;
  timeSource: 'officiel' | 'puce du bilan' | 'montre';
  grade: FfaGrade;
}

/**
 * Niveau FFA de chaque course sur route à une distance du barème. Temps : résultat officiel s'il a été récupéré,
 * sinon temps puce noté dans le bilan d'objectif, sinon durée de la montre.
 */
export function racePerformances(races: Activity[], sex: 'M' | 'F', chip: Map<string, number> = new Map()): RacePerformance[] {
  const out: RacePerformance[] = [];
  for (const a of races) {
    if (a.kind === 'trail') continue;
    const distM = ffaDistance(a.result?.distanceKm ?? a.distanceKm);
    if (!distM) continue;
    const official = a.result?.officialSec ?? null;
    const sec = official ?? chip.get(a.id) ?? a.durationSec;
    const grade = ffaGrade(sex, distM, sec);
    if (!grade) continue;
    out.push({ activity: a, distM, sec, timeSource: official ? 'officiel' : chip.has(a.id) ? 'puce du bilan' : 'montre', grade });
  }
  return out;
}

/**
 * Règle FFA : un niveau est acquis avec deux performances de ce niveau (si elles diffèrent, le plus bas compte).
 * Calculé ici sur les performances des 12 derniers mois.
 */
export function confirmedLevel(perfs: RacePerformance[], today: Date): FfaLevel | null {
  const since = today.getTime() - 365 * 86_400_000;
  const ranks = perfs
    .filter((p) => parseDay(p.activity.date).getTime() >= since)
    .map((p) => levelRank(p.grade.level))
    .sort((a, b) => a - b);
  return ranks.length >= 2 && ranks[1] < FFA_LEVELS.length ? FFA_LEVELS[ranks[1]] : null;
}
