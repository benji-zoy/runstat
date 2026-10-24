/**
 * Runner Matrix (inspirée d'Enduraw) : profil du coureur sur six branches — Endurance, Montée, Descente, Vitesse,
 * Résilience, Physiologie.
 *
 * Chaque branche agrège des métriques relues sur une fenêtre glissante (meilleure valeur sur 120 jours pour une
 * performance, médiane pour un état). Le score est un rang par rapport à ton propre historique : la fenêtre actuelle
 * est comparée à toutes les fenêtres hebdomadaires passées (0 = ta période la plus faible, 100 = la meilleure).
 * Il te décrit par rapport à toi-même, pas à une population ; deux branches ne se comparent donc pas entre elles.
 *
 * Lecture absolue, à côté : pourcentage du niveau mondial (convention du classement par âge des vétérans : 60 % =
 * classe locale, 70 % régionale, 80 % nationale, 90 % mondiale), seulement là où un étalon fiable existe — vitesse et
 * endurance face à la courbe des records du monde, physiologie face au VDOT du record du monde du marathon.
 *
 * La grille durée × terrain (allure ajustée, D+ et D− par durée, fichiers FIT) donne le détail « durée par durée ».
 */
import { Activity, Athlete, Health } from './models';
import { SessionType, efficiency, isComparableEasy, theilSen, vdot, vo2maxFromHr } from './science';
import { Durability, durability } from './durability';
import { addDays, parseDay } from './stats';

export type BranchId = 'endurance' | 'montee' | 'descente' | 'vitesse' | 'resilience' | 'physio';

export const BRANCHES: { id: BranchId; label: string; icon: string; text: string; absolute: string }[] = [
  {
    id: 'endurance', label: 'Endurance', icon: '🛣️', text: 'Vitesse tenue sur 1 à 2 h et durée des plus longues sorties.',
    absolute: 'Allure tenue 1 h et 2 h face à la vitesse des records du monde sur la même durée.',
  },
  {
    id: 'montee', label: 'Montée', icon: '⛰️', text: 'D+ avalé en 20 min et en 1 h, et rendement en côte (vitesse ajustée / FC) face au plat.',
    absolute: 'Pas d’étalon fiable : la vitesse ascensionnelle dépend surtout de la pente du terrain (record du kilomètre vertical ≈ 2 080 m/h, mais sur une pente à 50 %).',
  },
  {
    id: 'descente', label: 'Descente', icon: '🪂', text: 'D− descendu en 20 min et en 1 h, et vitesse en descente face au plat à effort égal (Minetti).',
    absolute: 'Pas d’étalon fiable : la vitesse en descente dépend de la pente et de la technicité du terrain.',
  },
  {
    id: 'vitesse', label: 'Vitesse', icon: '⚡', text: 'Meilleure allure ajustée à la pente sur 5 min (≈ VMA) et 20 min (≈ seuil).',
    absolute: 'Allure sur 5 et 20 min face à la vitesse des records du monde sur la même durée.',
  },
  {
    id: 'resilience', label: 'Résilience', icon: '🔋', text: 'Durabilité des sorties ≥ 1 h : perte d’efficacité en fin de sortie, dérive cardiaque, découplage.',
    absolute: 'Pas d’échelle mondiale. Repère (Friel) : découplage < 5 % = bonne endurance aérobie, > 10 % = au-dessus du seuil aérobie.',
  },
  {
    id: 'physio', label: 'Physiologie', icon: '🫀', text: 'VO₂max estimée par la FC, efficacité aérobie, FC de repos et VFC nocturne.',
    absolute: 'VO₂max Coros (historique reconstitué par l’estimation FC recalée sur elle) face au VDOT du record du monde du marathon.',
  },
];

/**
 * Records du monde servant d'étalon (vérifiés en octobre 2026). Entre les deux, la vitesse suit une loi puissance
 * v = v₁ (t / t₁)^−b qui retrouve les records du 5 000 m, du 10 000 m et du semi à ± 2 %.
 */
export const WORLD_RECORDS = {
  M: [
    { dist: 1500, time: 206.0, label: '1 500 m : H. El Guerrouj, 3:26.00 (1998)' },
    { dist: 42195, time: 7170, label: 'marathon : S. Sawe, 1:59:30 (Londres 2026)' },
  ],
  F: [
    { dist: 1500, time: 228.68, label: '1 500 m : F. Kipyegon, 3:48.68 (2025)' },
    { dist: 42195, time: 7796, label: 'marathon : R. Chepngetich, 2:09:56 (2024)' },
  ],
} as const;

/** Vitesse (m/s) du niveau record du monde tenue pendant `durationSec` (valable de ~3 min à ~2 h) */
export function worldSpeed(sex: 'M' | 'F', durationSec: number): number {
  const [a, b] = WORLD_RECORDS[sex];
  const v1 = a.dist / a.time, v2 = b.dist / b.time;
  const k = Math.log(v1 / v2) / Math.log(b.time / a.time);
  return v1 * Math.pow(durationSec / a.time, -k);
}

/** VDOT du record du monde du marathon : étalon de la VO₂max */
export function worldVdot(sex: 'M' | 'F'): number {
  const m = WORLD_RECORDS[sex][1];
  return vdot(m.dist, m.time);
}

/** Classe correspondant à un pourcentage du niveau mondial (barème du classement par âge des vétérans) */
export function worldLevel(pct: number): string {
  return pct >= 90 ? 'classe mondiale' : pct >= 80 ? 'classe nationale' : pct >= 70 ? 'classe régionale' : pct >= 60 ? 'classe locale' : 'loisir';
}

/** Format d'affichage d'une valeur : vitesse en m/s affichée en allure, vitesse verticale m/h, etc. */
export type MetricUnit = 'pace' | 'vam' | 'hours' | 'pct' | 'bpmh' | 'ef' | 'vo2' | 'bpm' | 'ms' | 'ratio';

export interface Sample {
  /** Jour (ms, minuit local) */
  t: number;
  value: number;
  activity?: Activity;
}

export interface MetricDef {
  id: string;
  branch: BranchId;
  label: string;
  unit: MetricUnit;
  higherIsBetter: boolean;
  /** Meilleure valeur (performance) ou médiane (état) sur la fenêtre */
  agg: 'best' | 'median';
  windowDays: number;
  /** Nombre minimal d'échantillons dans la fenêtre */
  minSamples: number;
  samples: Sample[];
  /** Pente de chaleur appliquée (unité de la métrique par °C), si corrigée */
  heatSlope?: number | null;
  /** Lecture absolue : pourcentage du niveau mondial correspondant à une valeur */
  absolute?: (value: number) => number;
}

export interface MetricScore {
  def: MetricDef;
  /** Valeur de la fenêtre actuelle et de celle d'il y a six mois */
  now: number | null;
  then: number | null;
  /** Rang (0-100) dans l'historique */
  score: number | null;
  scoreThen: number | null;
  /** Échantillons dans la fenêtre actuelle, et sortie qui porte la meilleure valeur */
  n: number;
  source: Activity | null;
  /** Meilleure fenêtre de l'historique */
  best: number | null;
  /** Pourcentage du niveau mondial, aujourd'hui et il y a six mois */
  absNow: number | null;
  absThen: number | null;
}

export interface BranchScore {
  id: BranchId;
  label: string;
  icon: string;
  text: string;
  score: number | null;
  scoreThen: number | null;
  /** Lecture absolue : moyenne des pourcentages du niveau mondial de ses métriques (null sans étalon) */
  abs: number | null;
  absThen: number | null;
  absolute: string;
  metrics: MetricScore[];
  /** Solide : toutes les métriques ; partielle : une partie ; insuffisante : aucune */
  confidence: 'solide' | 'partielle' | 'insuffisante';
}

export interface MatrixCell {
  duration: number;
  /** Meilleure valeur des 120 derniers jours et de tout l'historique, rapport des deux */
  now: Sample | null;
  best: Sample | null;
  ratio: number | null;
  /** Plat, jusqu'à 2 h : pourcentage du niveau mondial de la valeur récente */
  world?: number | null;
}

export interface MatrixRow {
  id: 'plat' | 'montee' | 'descente';
  label: string;
  unit: MetricUnit;
  cells: MatrixCell[];
}

export interface RunnerMatrix {
  today: Date;
  then: Date;
  branches: BranchScore[];
  /** Évolution des scores de branche, semaine par semaine */
  history: { date: Date; scores: Record<BranchId, number | null> }[];
  grid: MatrixRow[];
  durations: number[];
}

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 120;
export const GRID_DURATIONS = [300, 1200, 3600, 7200, 10800];
/** Nombre minimal de fenêtres hebdomadaires dans l'historique pour classer une valeur */
const MIN_HISTORY = 8;
/** Six mois, en semaines entières pour tomber sur une date de l'historique */
const THEN_DAYS = 26 * 7;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const day = (a: Activity) => parseDay(a.date).getTime();
const outdoor = (a: Activity) => a.kind !== 'indoor';

// ---------------------------------------------------------------------------
// Échantillons
// ---------------------------------------------------------------------------

/**
 * Meilleure vitesse (m/s) ajustée à la pente sur `duration` s. Sans FIT, la vitesse moyenne d'une sortie au moins
 * aussi longue est une borne basse (la meilleure fenêtre va au moins aussi vite que la moyenne).
 */
export function speedSamples(acts: Activity[], duration: number): Sample[] {
  const out: Sample[] = [];
  for (const a of acts) {
    if (!outdoor(a) || a.durationSec < duration) continue;
    const fit = a.fit?.curveGap?.[duration];
    const v = fit ? fit / duration : (a.distanceKm * 1000) / a.durationSec;
    if (v > 0) out.push({ t: day(a), value: v, activity: a });
  }
  return out;
}

/** Meilleure vitesse verticale (m/h) en montée ou en descente sur `duration` s ; sans FIT, D+ (D−) moyen de la sortie */
export function verticalSamples(acts: Activity[], duration: number, dir: 'climb' | 'descent'): Sample[] {
  const out: Sample[] = [];
  for (const a of acts) {
    if (!outdoor(a) || a.durationSec < duration) continue;
    const fit = a.fit?.[dir]?.[duration];
    const total = dir === 'climb' ? a.elevGain : a.elevLoss;
    const v = fit != null ? (fit / duration) * 3600 : total != null ? (total / a.durationSec) * 3600 : null;
    if (v != null && v > 0) out.push({ t: day(a), value: v, activity: a });
  }
  return out;
}

/** Tranches de pente (index dans `terrain`) */
const STEEP_DOWN = [0, 1];
const FLAT = [3];
const STEEP_UP = [5, 6];

function sumBins(terrain: number[][], bins: number[]) {
  const s = [0, 0, 0, 0, 0, 0, 0];
  for (const b of bins) terrain[b]?.forEach((v, i) => (s[i] += v));
  return { sec: s[0], dist: s[1], gap: s[2], hrSec: s[5], hrSum: s[6] };
}

/**
 * Rendement en côte : efficacité (vitesse ajustée / FC) sur les pentes ≥ 8 % rapportée à celle du plat dans la
 * même sortie (≥ 5 min de côte, ≥ 10 min de plat). 1 = tu montes aussi efficacement que tu cours à plat.
 */
export function climbEfficiencySamples(acts: Activity[]): Sample[] {
  const out: Sample[] = [];
  for (const a of acts) {
    const t = a.fit?.terrain;
    if (!t) continue;
    const up = sumBins(t, STEEP_UP), flat = sumBins(t, FLAT);
    if (up.sec < 300 || flat.sec < 600 || up.hrSec < 0.8 * up.sec || flat.hrSec < 0.8 * flat.sec) continue;
    const ef = (x: typeof up) => x.gap / x.sec / (x.hrSum / x.hrSec);
    out.push({ t: day(a), value: ef(up) / ef(flat), activity: a });
  }
  return out;
}

/**
 * Descente : vitesse ajustée (Minetti) sur les pentes ≤ −8 % rapportée à celle du plat dans la même sortie
 * (≥ 3 min de descente). La FC n'a pas de sens en descente (effort musculaire excentrique), d'où la vitesse seule.
 */
export function descentEfficiencySamples(acts: Activity[]): Sample[] {
  const out: Sample[] = [];
  for (const a of acts) {
    const t = a.fit?.terrain;
    if (!t) continue;
    const down = sumBins(t, STEEP_DOWN), flat = sumBins(t, FLAT);
    if (down.sec < 180 || flat.sec < 600) continue;
    out.push({ t: day(a), value: down.gap / down.sec / (flat.gap / flat.sec), activity: a });
  }
  return out;
}

/** Température de référence de la correction de chaleur (°C) */
export const REF_TEMP = 12;

/**
 * Corrige la chaleur : pente personnelle (Theil-Sen) de la métrique selon la température de la sortie, puis chaque
 * valeur est ramenée à 12 °C. Sans assez de sorties avec météo (15), les valeurs restent brutes.
 */
export function heatAdjusted(samples: Sample[]): { samples: Sample[]; slope: number | null } {
  const pts = samples.filter((s) => s.activity?.weather).map((s) => ({ x: s.activity!.weather!.temp, y: s.value }));
  if (pts.length < 15) return { samples, slope: null };
  const slope = theilSen(pts);
  return {
    slope,
    samples: samples.map((s) => (s.activity?.weather ? { ...s, value: s.value - slope * (s.activity.weather.temp - REF_TEMP) } : s)),
  };
}

function healthSamples(h: Health | null, key: 'rhr' | 'hrv'): Sample[] {
  if (!h) return [];
  return Object.entries(h.days)
    .filter(([, d]) => d[key] != null && d[key]! > 0)
    .map(([date, d]) => ({ t: parseDay(date).getTime(), value: d[key]! }));
}

export interface MatrixInput {
  acts: Activity[];
  athlete: Athlete;
  types: Map<string, SessionType>;
  health: Health | null;
  today: Date;
  /** VO₂max Coros actuelle : étalonne l'estimation par la FC pour la lecture absolue */
  corosVo2max?: number | null;
}

/** Définition des métriques de chaque branche */
export function matrixMetrics({ acts, athlete, types, health, today, corosVo2max }: MatrixInput): MetricDef[] {
  const perf = { agg: 'best' as const, windowDays: WINDOW_DAYS, minSamples: 1, higherIsBetter: true };
  const world = (d: number) => (v: number) => (v / worldSpeed(athlete.sex, d)) * 100;
  const vo2 = heatAdjusted(
    acts
      .map((a) => ({ a, v: vo2maxFromHr(a, athlete) }))
      .filter((x): x is { a: Activity; v: number } => x.v !== null)
      .map(({ a, v }) => ({ t: day(a), value: v, activity: a })),
  );
  // Étalonnage : l'estimation FC des 42 derniers jours ramenée à la VO₂max Coros du jour
  const recentVo2 = vo2.samples.filter((s) => s.t > today.getTime() - 42 * DAY_MS && s.t <= today.getTime()).map((s) => s.value);
  const vo2Calib = corosVo2max && recentVo2.length >= 3 ? corosVo2max / median(recentVo2) : null;
  const steady = acts.filter((a) => !['interval', 'tempo'].includes(types.get(a.id) ?? ''));
  const durs = steady.map(durability).filter((d): d is Durability => d !== null && d.steady);
  const map = <T>(xs: T[], f: (x: T) => Sample | null) => xs.map(f).filter((s): s is Sample => s !== null);
  const heat = (xs: Sample[]) => {
    const h = heatAdjusted(xs);
    return { samples: h.samples, heatSlope: h.slope };
  };
  return [
    { id: 'v60', branch: 'endurance', label: 'Allure ajustée tenue 1 h', unit: 'pace', ...perf, samples: speedSamples(acts, 3600), absolute: world(3600) },
    { id: 'v120', branch: 'endurance', label: 'Allure ajustée tenue 2 h', unit: 'pace', ...perf, samples: speedSamples(acts, 7200), absolute: world(7200) },
    {
      id: 'longest', branch: 'endurance', label: 'Plus longue sortie', unit: 'hours', ...perf,
      samples: acts.filter(outdoor).map((a) => ({ t: day(a), value: a.durationSec / 3600, activity: a })),
    },
    { id: 'up20', branch: 'montee', label: 'D+ en 20 min', unit: 'vam', ...perf, samples: verticalSamples(acts, 1200, 'climb') },
    { id: 'up60', branch: 'montee', label: 'D+ en 1 h', unit: 'vam', ...perf, samples: verticalSamples(acts, 3600, 'climb') },
    {
      id: 'upEff', branch: 'montee', label: 'Rendement en côte ≥ 8 % / plat', unit: 'ratio', higherIsBetter: true,
      agg: 'median', windowDays: WINDOW_DAYS, minSamples: 2, samples: climbEfficiencySamples(acts),
    },
    { id: 'down20', branch: 'descente', label: 'D− en 20 min', unit: 'vam', ...perf, samples: verticalSamples(acts, 1200, 'descent') },
    { id: 'down60', branch: 'descente', label: 'D− en 1 h', unit: 'vam', ...perf, samples: verticalSamples(acts, 3600, 'descent') },
    {
      id: 'downEff', branch: 'descente', label: 'Vitesse ajustée en descente ≤ −8 % / plat', unit: 'ratio', higherIsBetter: true,
      agg: 'median', windowDays: WINDOW_DAYS, minSamples: 2, samples: descentEfficiencySamples(acts),
    },
    { id: 'v5', branch: 'vitesse', label: 'Allure ajustée sur 5 min', unit: 'pace', ...perf, samples: speedSamples(acts, 300), absolute: world(300) },
    { id: 'v20', branch: 'vitesse', label: 'Allure ajustée sur 20 min', unit: 'pace', ...perf, samples: speedSamples(acts, 1200), absolute: world(1200) },
    {
      id: 'efLoss', branch: 'resilience', label: 'Perte d’efficacité en fin de sortie', unit: 'pct', higherIsBetter: false,
      agg: 'median', windowDays: WINDOW_DAYS, minSamples: 2,
      ...heat(durs.map((d) => ({ t: day(d.activity), value: d.efLoss, activity: d.activity }))),
    },
    {
      id: 'hrDrift', branch: 'resilience', label: 'Dérive cardiaque à allure égale', unit: 'bpmh', higherIsBetter: false,
      agg: 'median', windowDays: WINDOW_DAYS, minSamples: 2,
      ...heat(map(durs, (d) => (d.hrDrift === null ? null : { t: day(d.activity), value: d.hrDrift, activity: d.activity }))),
    },
    {
      id: 'decoupling', branch: 'resilience', label: 'Découplage Pa:HR des sorties faciles', unit: 'pct', higherIsBetter: false,
      agg: 'median', windowDays: 90, minSamples: 3,
      ...heat(
        map(acts, (a) =>
          a.fit?.decoupling != null && ['easy', 'long', 'recovery'].includes(types.get(a.id) ?? '')
            ? { t: day(a), value: a.fit.decoupling, activity: a }
            : null,
        ),
      ),
    },
    {
      id: 'vo2', branch: 'physio', label: 'VO₂max estimée (FC)', unit: 'vo2', higherIsBetter: true,
      agg: 'median', windowDays: 42, minSamples: 3,
      samples: vo2.samples,
      heatSlope: vo2.slope,
      absolute: vo2Calib ? (v: number) => ((v * vo2Calib) / worldVdot(athlete.sex)) * 100 : undefined,
    },
    {
      id: 'ef', branch: 'physio', label: 'Efficacité aérobie (EF)', unit: 'ef', higherIsBetter: true,
      agg: 'median', windowDays: 42, minSamples: 3,
      ...heat(map(acts, (a) => (isComparableEasy(a, types.get(a.id)) ? { t: day(a), value: efficiency(a)!, activity: a } : null))),
    },
    {
      id: 'rhr', branch: 'physio', label: 'FC de repos', unit: 'bpm', higherIsBetter: false,
      agg: 'median', windowDays: 28, minSamples: 7, samples: healthSamples(health, 'rhr'),
    },
    {
      id: 'hrv', branch: 'physio', label: 'VFC nocturne', unit: 'ms', higherIsBetter: true,
      agg: 'median', windowDays: 28, minSamples: 7, samples: healthSamples(health, 'hrv'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Fenêtres et rangs
// ---------------------------------------------------------------------------

/** Valeur d'une métrique sur la fenêtre qui se termine le jour `end` (inclus), avec la sortie qui la porte */
export function windowValue(def: MetricDef, end: number): { value: number; n: number; source: Sample | null } | null {
  const start = end - def.windowDays * DAY_MS;
  const win = def.samples.filter((s) => s.t > start && s.t <= end);
  if (win.length < def.minSamples) return null;
  if (def.agg === 'median') return { value: median(win.map((s) => s.value)), n: win.length, source: null };
  const best = win.reduce((b, s) => ((def.higherIsBetter ? s.value > b.value : s.value < b.value) ? s : b));
  return { value: best.value, n: win.length, source: best };
}

/**
 * Rang (0-100) de `value`, qui fait partie de `history` : 0 = la moins bonne fenêtre, 100 = la meilleure,
 * les égalités se partageant le rang moyen.
 */
export function percentile(value: number, history: number[], higherIsBetter: boolean): number {
  let worse = 0, equal = 0;
  for (const h of history) {
    const d = higherIsBetter ? value - h : h - value;
    if (Math.abs(d) < 1e-9) equal++;
    else if (d > 0) worse++;
  }
  if (history.length < 2) return 50;
  return ((worse + Math.max(0, equal - 1) / 2) / (history.length - 1)) * 100;
}

/** Dates de l'historique : chaque semaine en remontant depuis aujourd'hui, tant que la première sortie est couverte */
function historyDates(acts: Activity[], today: Date): Date[] {
  if (!acts.length) return [];
  const first = Math.min(...acts.map(day));
  const out: Date[] = [];
  // On attend un mois de données avant la première fenêtre
  for (let d = today; d.getTime() >= first + 28 * DAY_MS; d = addDays(d, -7)) out.unshift(d);
  return out;
}

export function runnerMatrix(input: MatrixInput): RunnerMatrix {
  const { acts, today } = input;
  const defs = matrixMetrics(input);
  const dates = historyDates(acts, today);
  const then = addDays(today, -THEN_DAYS);

  // Valeurs de chaque métrique à chaque date, puis rangs dans la série
  const series = defs.map((def) => dates.map((d) => windowValue(def, d.getTime())?.value ?? null));
  const ranks = defs.map((def, i) => {
    const hist = series[i].filter((v): v is number => v !== null);
    return series[i].map((v) => (v === null || hist.length < MIN_HISTORY ? null : percentile(v, hist, def.higherIsBetter)));
  });
  const idxToday = dates.length - 1;
  const idxThen = dates.findIndex((d) => d.getTime() === then.getTime());

  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  const branches: BranchScore[] = BRANCHES.map((b) => {
    const idx = defs.map((d, i) => (d.branch === b.id ? i : -1)).filter((i) => i >= 0);
    const metrics: MetricScore[] = idx.map((i) => {
      const def = defs[i];
      const now = idxToday >= 0 ? windowValue(def, dates[idxToday].getTime()) : null;
      const hist = series[i].filter((v): v is number => v !== null);
      return {
        def,
        now: now?.value ?? null,
        then: idxThen >= 0 ? series[i][idxThen] : null,
        score: idxToday >= 0 ? ranks[i][idxToday] : null,
        scoreThen: idxThen >= 0 ? ranks[i][idxThen] : null,
        n: now?.n ?? 0,
        source: now?.source?.activity ?? null,
        best: hist.length ? (def.higherIsBetter ? Math.max(...hist) : Math.min(...hist)) : null,
        absNow: def.absolute && now ? def.absolute(now.value) : null,
        absThen: def.absolute && idxThen >= 0 && series[i][idxThen] !== null ? def.absolute(series[i][idxThen]!) : null,
      };
    });
    const scored = metrics.filter((m) => m.score !== null).length;
    return {
      ...b,
      score: mean(metrics.map((m) => m.score)),
      scoreThen: mean(metrics.map((m) => m.scoreThen)),
      abs: mean(metrics.map((m) => m.absNow)),
      absThen: mean(metrics.map((m) => m.absThen)),
      metrics,
      confidence: scored === 0 ? 'insuffisante' : scored === metrics.length ? 'solide' : 'partielle',
    };
  });

  const history = dates.map((date, k) => {
    const scores = {} as Record<BranchId, number | null>;
    for (const b of BRANCHES) scores[b.id] = mean(defs.map((d, i) => (d.branch === b.id ? ranks[i][k] : null)));
    return { date, scores };
  });

  return { today, then, branches, history, grid: matrixGrid(acts, today, input.athlete.sex), durations: GRID_DURATIONS };
}

// ---------------------------------------------------------------------------
// Grille durée × terrain
// ---------------------------------------------------------------------------

function bestOf(samples: Sample[]): Sample | null {
  return samples.reduce<Sample | null>((b, s) => (!b || s.value > b.value ? s : b), null);
}

/**
 * Pour chaque durée, meilleure valeur des 120 derniers jours face au record personnel. Fichiers FIT seulement : la
 * borne basse des sorties sans FIT n'a pas de sens pour un record.
 */
export function matrixGrid(acts: Activity[], today: Date, sex: 'M' | 'F' = 'M'): MatrixRow[] {
  const fit = acts.filter((a) => a.fit);
  const end = today.getTime();
  const start = end - WINDOW_DAYS * DAY_MS;
  const row = (id: MatrixRow['id'], label: string, unit: MetricUnit, f: (d: number) => Sample[]): MatrixRow => ({
    id, label, unit,
    cells: GRID_DURATIONS.map((duration) => {
      const all = f(duration).filter((s) => s.t <= end);
      const best = bestOf(all);
      const now = bestOf(all.filter((s) => s.t > start));
      const world = id === 'plat' && now && duration <= 7200 ? (now.value / worldSpeed(sex, duration)) * 100 : null;
      return { duration, now, best, ratio: now && best ? now.value / best.value : null, world };
    }),
  });
  const fitOnly = (xs: Sample[], key: 'curveGap' | 'climb' | 'descent', d: number) =>
    xs.filter((s) => s.activity?.fit?.[key]?.[d] != null);
  return [
    row('plat', 'Plat · allure ajustée', 'pace', (d) => fitOnly(speedSamples(fit, d), 'curveGap', d)),
    row('montee', 'Montée · D+', 'vam', (d) => fitOnly(verticalSamples(fit, d, 'climb'), 'climb', d)),
    row('descente', 'Descente · D−', 'vam', (d) => fitOnly(verticalSamples(fit, d, 'descent'), 'descent', d)),
  ];
}
