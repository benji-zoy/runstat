/**
 * Indice de confiance pour les objectifs à venir (data-raw/goals.json), avec une méthode par catégorie :
 *
 * - Route (jusqu'au marathon) : consensus des modèles (VDOT, Riegel perso, course de référence projetée, vitesse
 *   critique, Tanda et Vickers au marathon), corrigé du profil du parcours (GPX, sinon D+ annoncé).
 * - Trail : tes trails extrapolés en distance « équivalent plat » (ta courbe vitesse / pente, core/terrain.ts), pondérés
 *   par fraîcheur, proximité et ressemblance du terrain ; et ton niveau route actuel × ton coefficient trail.
 * - Ultra (≥ 60 km-effort ou > 45 km) : les mêmes, plus une simulation tronçon par tronçon (core/course.ts) à ta FC
 *   d'endurance, avec l'usure mesurée sur tes sorties longues et les arrêts aux ravitaillements.
 *
 * Puis ajustements du jour J (fraîcheur, récupération, météo, nuit simulée sur le profil, préparation) ; incertitude
 * log-normale = dispersion des modèles + variabilité d'un jour de course (2 % sur 5 km à 4 % au marathon, 6 % en
 * trail, 8 % en ultra) + extrapolation au-delà de ta plus longue sortie → probabilité de passer sous le chrono visé.
 * Objectif « finir » : indice de préparation pondéré (volume, sortie la plus longue, D+, expérience, nuit, durabilité,
 * régularité, récupération), aujourd'hui et projeté si tu suis la progression conseillée.
 */
import { Activity, Athlete, Goal, Health } from './models';
import {
  CriticalSpeed, ExponentEstimate, Reference, SessionType, bestEfforts, criticalSpeed, heatPenalty, kmEffort, goalKmEffort,
  officialDistance, personalExponentFromRaces, references, riegel, tanda, tandaPace, timeForVdot, vickers, efficiency, isComparableEasy,
  wallAnalysis,
} from './science';
import { clock } from './format';
import { RacePlan, racePlan } from './race-plan';
import { pmc } from './insights';
import { Durability, durability, isTrailRun, kmLaps } from './durability';
import { Segment, Waypoint, courseSegments, courseWaypoints, fitTimeline, nightWindow, simulate } from './course';
import { Terrain, activityEffortKm, personalTerrain, segmentsEffortKm } from './terrain';
import { baselineSeries, hrvStatus, rhrStatus, sleepDebt } from './health';
import { addDays, isoDay, parseDay } from './stats';

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/**
 * Exposant de Riegel appliqué à la distance équivalent plat pour extrapoler un trail : la courbe des meilleures
 * vitesses en trail (≈ 21 km-effort/h sur 40 km-effort, 19 sur la SaintéLyon, 15,5 sur l'UTMB) donne ≈ 1,10
 */
export const TRAIL_EXPONENT = 1.1;

export type RaceCategory = 'road' | 'trail' | 'ultra';

/** Km-effort à partir duquel une course est traitée comme un ultra */
const ULTRA_KE = 60;

export function raceCategory(goal: Goal): RaceCategory {
  return goalKmEffort(goal) >= ULTRA_KE || goal.distanceKm > 45 ? 'ultra' : goal.kind;
}

/** Variabilité d'un jour de course à l'autre (écart-type relatif) : 2 % sur 5 km à 4 % au marathon, 6 % en trail, 8 % en ultra */
export function daySd(cat: RaceCategory, distanceKm: number): number {
  if (cat === 'ultra') return 0.08;
  if (cat === 'trail') return 0.06;
  return 0.02 + 0.02 * Math.max(0, Math.min(1, Math.log(distanceKm / 5) / Math.log(42.195 / 5)));
}

export interface GoalContext {
  /** Sorties antérieures à l'objectif */
  acts: Activity[];
  types: Map<string, SessionType>;
  athlete: Athlete;
  /** Date d'évaluation : aujourd'hui, ou la veille pour un objectif passé */
  ref: Date;
  refs: Reference[];
  exponent: ExponentEstimate | null;
  cs: CriticalSpeed | null;
  /** Prédictions Coros (uniquement pour un objectif à venir : c'est un instantané du jour) */
  coros: Record<string, string | null>;
  health: Health | null;
  /** Ta courbe vitesse / pente (trail pour un trail, route pour la route) */
  terrain: Terrain;
}

export function goalContext(
  goal: Goal,
  all: Activity[],
  types: Map<string, SessionType>,
  athlete: Athlete,
  today: Date,
  coros: Record<string, string | null>,
  health: Health | null,
): GoalContext {
  const race = parseDay(goal.date);
  const past = race <= today;
  const ref = past ? addDays(race, -1) : today;
  const acts = all.filter((a) => parseDay(a.date) <= ref);
  return {
    acts,
    types,
    athlete,
    ref,
    refs: references(acts, types, ref),
    exponent: personalExponentFromRaces(acts, types, athlete, ref),
    cs: criticalSpeed([...bestEfforts(acts, ref, 112).entries()].map(([dist, e]) => ({ dist, time: e.time }))),
    coros: past ? {} : coros,
    health,
    terrain: personalTerrain(acts, ref, athlete, goal.kind === 'trail'),
  };
}

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

/** Fonction de répartition de la loi normale (Abramowitz & Stegun 7.1.26) */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface Model {
  label: string;
  seconds: number;
  weight: number;
  note: string;
}

/** Moyenne géométrique pondérée et dispersion (écart-type des logarithmes) */
export function consensus(models: Model[]): { seconds: number; spread: number } | null {
  const w = models.reduce((s, m) => s + m.weight, 0);
  if (!w) return null;
  const mean = models.reduce((s, m) => s + Math.log(m.seconds) * m.weight, 0) / w;
  const variance = models.reduce((s, m) => s + m.weight * (Math.log(m.seconds) - mean) ** 2, 0) / w;
  return { seconds: Math.exp(mean), spread: Math.sqrt(variance) };
}

/** Probabilité de passer sous `target` si le temps suit une loi log-normale centrée sur `median` */
export function chance(target: number, median: number, sigma: number): number {
  return normalCdf(Math.log(target / median) / sigma);
}

// ---------------------------------------------------------------------------
// Modèles de prédiction
// ---------------------------------------------------------------------------

const COROS_KEYS: Record<number, string> = { 5000: '5K', 10000: '10K', 21097.5: 'Semi', 42195: 'Marathon' };
const toSec = (s: string | null | undefined) => (s ? s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : null);

/** Fraction de la vitesse critique tenable sur une distance : (d − D′)/CS jusqu'au 10 km, puis 92 % au semi et 85 % au marathon */
export function csTime(cs: CriticalSpeed, distM: number): number {
  if (distM <= 10000) return (distM - cs.dPrime) / cs.cs;
  const f = Math.min(0.99, Math.max(0.8, 0.85 + (0.07 * Math.log(42195 / distM)) / Math.log(2)));
  return distM / (f * cs.cs);
}

// ---------------------------------------------------------------------------
// Courses de référence : les courses déjà faites sur la même distance (trail : km-effort le plus proche)
// ---------------------------------------------------------------------------

export interface RaceReference {
  activity: Activity;
  ageDays: number;
  /** Distance officielle (m) ; pour un trail, la distance GPS */
  dist: number;
  /** Allure moyenne sur la distance officielle (s/km) ; trail : s par km équivalent plat */
  pace: number;
  /** Trail : distance équivalent plat (km) avec ta courbe de pente */
  effortKm: number | null;
  hrPct: number | null;
  /** Allure 2e moitié − 1re moitié (s/km) : négatif = fini plus vite */
  splitDiff: number | null;
  /** Écart de la montre : distance GPS / distance officielle − 1 */
  gpsDrift: number;
  /** Pénalité de chaleur de ce jour-là (%) */
  heatPct: number;
}

/** Dénivelé moyen par km (moyenne du D+ et du D−), 5 m/km au moins */
const elevDensity = (km: number, gain?: number | null, loss?: number | null) =>
  Math.max(5, ((gain ?? 0) + (loss ?? gain ?? 0)) / 2 / Math.max(0.1, km));

/** Ressemblance du terrain (1 = même dénivelé par km ; 0,5 pour deux fois plus raide) */
const terrainSimilarity = (a: Activity, goal: Goal) =>
  Math.exp(-Math.abs(Math.log(elevDensity(a.distanceKm, a.elevGain, a.elevLoss) / elevDensity(goal.distanceKm, goal.elevGain, goal.elevLoss))));

export function raceReferences(goal: Goal, ctx: GoalContext): RaceReference[] {
  const d = officialDistance(goal.distanceKm);
  const trail = goal.kind === 'trail';
  const eqGoal = trail ? segmentsEffortKm(courseSegments(goal), ctx.terrain.cost) : 0;
  const eq = (a: Activity) => activityEffortKm(a, ctx.terrain.cost);
  const age = (a: Activity) => daysBetween(parseDay(a.date), ctx.ref);
  const races = ctx.acts.filter((a) => ctx.types.get(a.id) === 'race' && age(a) <= 730 && (trail ? isTrail(a) : !isTrail(a)));
  const closeness = (a: Activity) => Math.abs(Math.log(eqGoal / eq(a))) - Math.log(terrainSimilarity(a, goal));
  const picked = trail
    ? races.sort((a, b) => closeness(a) - closeness(b)).slice(0, 3)
    : races.filter((a) => officialDistance(a.distanceKm) === d).sort((a, b) => b.date.localeCompare(a.date));
  return picked.map((a) => {
    const dist = trail ? a.distanceKm * 1000 : officialDistance(a.distanceKm);
    const effortKm = trail ? eq(a) : null;
    const s = a.splits ?? [];
    const half = s.length >> 1;
    const avg = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
    return {
      activity: a,
      ageDays: age(a),
      dist,
      pace: a.durationSec / (effortKm ?? dist / 1000),
      effortKm,
      hrPct: a.avgHr ? a.avgHr / ctx.athlete.hrMax : null,
      splitDiff: half >= 2 ? avg(s.slice(half, 2 * half)) - avg(s.slice(0, half)) : null,
      gpsDrift: trail ? 0 : (a.distanceKm * 1000) / dist - 1,
      heatPct: a.weather ? heatPenalty(a.weather.temp, a.weather.dew) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Progression depuis la course de référence
// ---------------------------------------------------------------------------

export interface ProgressionRow {
  label: string;
  before: string;
  now: string;
  /** Multiplicateur de temps (< 1 = plus rapide) ; null = contexte, non chiffré */
  factor: number | null;
  note: string;
}

export interface Progression {
  reference: Activity;
  /** Temps de référence sans la chaleur du jour */
  neutral: number;
  rows: ProgressionRow[];
  /** Multiplicateur de temps retenu (plafonné à ±10 %) */
  factor: number;
  projected: number;
}

const pct = (x: number) => `${x > 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;

/**
 * Le niveau du jour de la course de référence sert de base ; on le projette à aujourd'hui en comparant les 8 semaines
 * d'entraînement qui l'ont précédée aux 8 dernières :
 * - volume → effet du kilométrage hebdomadaire dans le modèle de Tanda (2011) ;
 * - forme → l'allure moyenne d'entraînement (l'autre terme de Tanda, qui reflète aussi les séances de qualité) et
 *   l'efficacité aérobie (vitesse / FC en endurance, moitié du gain comme le VDOT actualisé). Les deux mesurent le même
 *   progrès (on court plus vite à l'entraînement parce qu'on est plus efficace) : on prend leur moyenne géométrique.
 * Temps projeté = base × effet volume × effet forme, plafonné à ±10 %.
 */
export function progressionSince(ref: RaceReference, ctx: GoalContext): Progression {
  const a = ref.activity;
  const raceDay = parseDay(a.date);
  const neutral = a.durationSec / (1 + ref.heatPct / 100);
  const rows: ProgressionRow[] = [];
  let volume = 1;
  const fitness: number[] = [];

  const before = tanda(ctx.acts, addDays(raceDay, -1));
  const now = tanda(ctx.acts, ctx.ref);
  if (before && now) {
    const fVol = tandaPace(now.kmPerWeek, before.paceSec) / tandaPace(before.kmPerWeek, before.paceSec);
    const fPace = tandaPace(now.kmPerWeek, now.paceSec) / tandaPace(now.kmPerWeek, before.paceSec);
    rows.push({ label: 'Volume', before: `${fr(before.kmPerWeek)} km/sem`, now: `${fr(now.kmPerWeek)} km/sem`, factor: fVol, note: 'moyenne sur 8 semaines' });
    rows.push({ label: 'Allure moyenne d\'entraînement', before: `${paceStr(before.paceSec)} /km`, now: `${paceStr(now.paceSec)} /km`, factor: fPace, note: 'hors trail : reflète les séances de qualité' });
    volume = fVol;
    fitness.push(fPace);
  }
  const ef = efProgress(ctx, addDays(raceDay, -1));
  if (ef) {
    const fEf = 1 / (1 + ef.gain / 2);
    rows.push({ label: 'Efficacité aérobie', before: ef.before.toFixed(2).replace('.', ','), now: ef.now.toFixed(2).replace('.', ','), factor: fEf, note: `vitesse / FC en endurance, ${pct(ef.gain)} (moitié retenue)` });
    fitness.push(fEf);
  }
  // Contexte : séances de qualité et sorties longues, déjà reflétées par l'allure moyenne et le volume
  const count = (end: Date, test: (x: Activity) => boolean) =>
    ctx.acts.filter((x) => parseDay(x.date) > addDays(end, -56) && parseDay(x.date) <= end && test(x)).length;
  const quality = (x: Activity) => ['interval', 'tempo'].includes(ctx.types.get(x.id) ?? '');
  const long = (x: Activity) => x.durationSec >= 90 * 60 && !isTrail(x);
  rows.push({ label: 'Séances de qualité', before: `${count(addDays(raceDay, -1), quality)}`, now: `${count(ctx.ref, quality)}`, factor: null, note: 'fractionné et tempo, 8 semaines' });
  rows.push({ label: 'Sorties longues (≥ 1 h 30)', before: `${count(addDays(raceDay, -1), long)}`, now: `${count(ctx.ref, long)}`, factor: null, note: 'route, 8 semaines' });

  const form = fitness.length ? Math.exp(fitness.reduce((t, f) => t + Math.log(f), 0) / fitness.length) : 1;
  const raw = volume * form;
  const factor = Math.max(0.9, Math.min(1.1, raw));
  return { reference: a, neutral, rows, factor, projected: neutral * factor };
}

export function roadModels(goal: Goal, ctx: GoalContext): Model[] {
  const d = officialDistance(goal.distanceKm);
  const out: Model[] = [];
  const coros = toSec(ctx.coros[COROS_KEYS[d]]);
  if (coros) out.push({ label: 'Coros', seconds: coros, weight: 1, note: 'prédiction de la montre' });
  // Course de référence : la dernière course sur la même distance, ramenée à des conditions neutres puis projetée
  // au jour de l'évaluation avec l'entraînement fait depuis. Poids 1,5 : c'est le modèle le plus spécifique.
  const same = raceReferences(goal, ctx)[0];
  if (same) {
    const a = same.activity;
    const p = progressionSince(same, ctx);
    const date = parseDay(a.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    out.push({
      label: `Référence : ${a.name}`,
      seconds: p.projected,
      weight: same.ageDays <= 400 ? 1.5 : 1,
      note: `${clock(a.durationSec)} le ${date}${same.heatPct > 0.05 ? ` (${clock(p.neutral)} sans la chaleur)` : ''}, `
        + `projeté avec l'entraînement depuis : ${pct(p.factor - 1)}`,
    });
  }
  // Meilleure performance des 12 derniers mois : les meilleurs efforts FIT viennent souvent de l'entraînement
  // (sous-maximaux), ils ne l'emportent que s'ils battent les courses
  const recent = ctx.refs.find((r) => daysBetween(parseDay(r.date), ctx.ref) <= 365) ?? ctx.refs[0];
  if (recent) {
    out.push({ label: 'VDOT de Daniels', seconds: timeForVdot(recent.vdot, d), weight: 1, note: `d'après ${recent.label}` });
    const k = ctx.exponent?.k;
    if (k && d > recent.dist * 1.2) {
      out.push({ label: 'Riegel pondéré', seconds: riegel(recent.time, recent.dist, d, k), weight: 1, note: `exposant perso ${k.toFixed(2).replace('.', ',')}` });
    }
  }
  // Référence actualisée : la moitié du gain d'efficacité aérobie (EF) depuis la référence, plafonnée à ±5 %
  const progress = recent ? efProgress(ctx, parseDay(recent.date)) : null;
  if (recent && progress) {
    const gain = Math.max(-0.05, Math.min(0.05, progress.gain / 2));
    out.push({
      label: 'VDOT actualisé (EF)',
      seconds: timeForVdot(recent.vdot, d) / (1 + gain),
      weight: 1,
      note: `efficacité ${progress.gain >= 0 ? '+' : '−'}${Math.abs(Math.round(progress.gain * 100))} % depuis ${recent.label} (moitié retenue)`,
    });
  }
  // Poids réduit : sans effort maximal récent de 2 à 25 min, la vitesse critique est sous-estimée
  if (ctx.cs && d <= 42195) {
    out.push({ label: 'Vitesse critique', seconds: csTime(ctx.cs, d), weight: 0.5, note: 'meilleurs efforts de 2 à 25 min (16 sem.), souvent sous-maximaux' });
  }
  if (d === 42195) {
    const t = tanda(ctx.acts, ctx.ref);
    if (t) out.push({ label: 'Tanda', seconds: t.seconds, weight: 1, note: 'volume et allure des 8 dernières semaines' });
    if (t && recent) out.push({ label: 'Vickers', seconds: vickers(recent.time, recent.dist, t.kmPerWeek), weight: 1, note: 'perf. de référence + volume' });
  }
  return out;
}

/** Gain d'efficacité (vitesse / FC sur les sorties d'endurance comparables) entre les 6 semaines avant `since` et les 6 dernières */
export function efProgress(ctx: GoalContext, since: Date): { gain: number; before: number; now: number } | null {
  if (daysBetween(since, ctx.ref) < 28) return null;
  const median = (from: Date, to: Date) => {
    const xs = ctx.acts
      .filter((a) => parseDay(a.date) > from && parseDay(a.date) <= to && isComparableEasy(a, ctx.types.get(a.id)))
      .map((a) => efficiency(a)!)
      .sort((x, y) => x - y);
    return xs.length >= 5 ? xs[Math.floor(xs.length / 2)] : null;
  };
  const before = median(addDays(since, -42), since);
  const now = median(addDays(ctx.ref, -42), ctx.ref);
  return before && now ? { gain: now / before - 1, before, now } : null;
}

const isTrail = isTrailRun;

/** Part du temps perdue à l'arrêt (ravitaillements) sur un ultra */
const ULTRA_STOPS = 0.05;

const ageLabel = (days: number) => (days < 60 ? `il y a ${days} j` : `il y a ${Math.round(days / 30.4)} mois`);
const isRaceLike = (a: Activity, ctx: GoalContext) => ctx.types.get(a.id) === 'race' || /trail (des|de|du)/i.test(a.name);
const notQuality = (a: Activity, ctx: GoalContext) => !['interval', 'tempo'].includes(ctx.types.get(a.id) ?? '');

/** Usure : perte d'efficacité par heure (médiane des sorties régulières de ≥ 1 h 30 sur 16 semaines), 1,5 à 4 %/h */
export function fadeEstimate(ctx: GoalContext): { perHour: number; measured: boolean } {
  const lossPerHour = ctx.acts
    .filter((a) => daysBetween(parseDay(a.date), ctx.ref) <= 112 && notQuality(a, ctx))
    .map(durability)
    .filter((d): d is Durability => d !== null && d.steady && d.hours >= 1.5)
    .map((d) => d.efLoss / d.hours)
    .sort((x, y) => x - y);
  return lossPerHour.length >= 2
    ? { perHour: Math.min(0.04, Math.max(0.015, lossPerHour[lossPerHour.length >> 1] / 100)), measured: true }
    : { perHour: 0.025, measured: false };
}

/** Facteur de temps lié au progrès d'efficacité depuis une sortie (moitié du gain, ±5 % au plus) */
function formSince(ctx: GoalContext, date: string): { factor: number; gain: number } | null {
  const p = efProgress(ctx, parseDay(date));
  if (!p) return null;
  const gain = Math.max(-0.05, Math.min(0.05, p.gain / 2));
  return { factor: 1 / (1 + gain), gain: p.gain };
}

/**
 * Ultra : simulation tronçon par tronçon. Vitesse sur le plat que tu tiens à la FC d'ultra (seuil LT1, sinon 80 % de la
 * FC max) sur tes tours plats des sorties longues récentes, ralentie sur les sentiers (ton écart route / trail à FC égale,
 * au prorata du dénivelé du parcours), puis chaque tronçon au coût de sa pente (ta courbe), avec l'usure par heure de tes
 * sorties ≥ 1 h 30, et 5 % du temps aux ravitaillements. Pas besoin d'avoir couru la durée de la course : seules comptent
 * les sorties à cette FC (≥ 1 h cumulée entre la 10e et la 90e minute).
 */
export function ultraModel(goal: Goal, ctx: GoalContext, segs: Segment[] = courseSegments(goal)): Model | null {
  if (raceCategory(goal) !== 'ultra') return null;
  const hrTarget = ctx.athlete.lt1Hr ?? 0.8 * ctx.athlete.hrMax;
  const surface = ctx.terrain.surface ?? 1.08;
  const recent = ctx.acts.filter((a) => daysBetween(parseDay(a.date), ctx.ref) <= 84 && a.durationSec >= 5400 && notQuality(a, ctx));
  const laps = recent.flatMap((a) =>
    kmLaps(a)
      .filter((l) => Math.abs(l.hr - hrTarget) <= 6 && l.start >= 600 && l.start < 5400)
      .map((l) => ({ ...l, trail: isTrail(a) })));
  // Tours plats : vitesse réelle, ramenée à la route pour les sorties trail ; sinon allure ajustée de tous les tours
  const flat = laps.filter((l) => (l.up + l.down) / l.d <= 0.012);
  const flatSec = flat.reduce((s, l) => s + l.t, 0);
  const use = flatSec >= 3600 ? flat : laps;
  const sampleSec = use.reduce((s, l) => s + l.t, 0);
  if (sampleSec < 3600) return null;
  const v0 = use.reduce((s, l) => s + (flatSec >= 3600 ? l.d / l.t : 1000 / l.gap) * (l.trail ? surface : 1) * l.t, 0) / sampleSec;
  const t0 = use.reduce((s, l) => s + (l.start + l.t / 2) * l.t, 0) / sampleSec / 3600;
  // Part de sentier : nulle sous 10 m/km de dénivelé, complète au-delà de 40
  const trailShare = (km: number, gain?: number | null, loss?: number | null) =>
    Math.max(0, Math.min(1, (elevDensity(km, gain, loss) - 10) / 30));
  const share = goal.kind === 'trail' ? trailShare(goal.distanceKm, goal.elevGain, goal.elevLoss) : 0;
  const speed = v0 / Math.pow(surface, share);
  const fade = fadeEstimate(ctx);
  const sim = { cost: ctx.terrain.cost, fadePerHour: fade.perHour, fadeFromH: t0 };
  const moving = simulate(segs, { ...sim, speed }).total;

  // Recalage sur tes trails de plus de 2 h de l'année : la même simulation les aurait-elle prédits ? (à forme égale,
  // pondéré comme les références ; rapproché de 1 tant qu'il y en a peu, ±10 % au plus)
  const calib = ctx.acts
    .filter((a) => isTrail(a) && a.durationSec >= 7200 && daysBetween(parseDay(a.date), ctx.ref) <= 365)
    .map((a) => {
      const own = courseSegments({ distanceKm: a.distanceKm, elevGain: a.elevGain ?? 0, elevLoss: a.elevLoss ?? a.elevGain ?? 0, kind: 'trail' });
      const predicted = simulate(own, { ...sim, speed: v0 / Math.pow(surface, trailShare(a.distanceKm, a.elevGain, a.elevLoss)) }).total
        * (1 + ULTRA_STOPS * Math.min(1, a.durationSec / 36000));
      const age = daysBetween(parseDay(a.date), ctx.ref);
      return {
        name: a.name,
        ratio: (a.durationSec * (formSince(ctx, a.date)?.factor ?? 1)) / predicted,
        weight: Math.exp(-age / 180) * terrainSimilarity(a, goal) * (isRaceLike(a, ctx) ? 1 : 0.4),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);
  const cw = calib.reduce((s, x) => s + x.weight, 0);
  const calibFactor = cw
    ? Math.min(1.1, Math.max(0.9, Math.exp((calib.reduce((s, x) => s + x.weight * Math.log(x.ratio), 0) / cw) * (calib.length / (calib.length + 1)))))
    : 1;
  const eq = segmentsEffortKm(segs, ctx.terrain.cost);
  return {
    label: 'Simulation à FC d\'ultra',
    seconds: moving * (1 + ULTRA_STOPS) * calibFactor,
    weight: sampleSec >= 7200 ? 1.5 : 0.8,
    note: `${fr(speed * 3.6, 1)} km/h sur le plat à ${Math.round(hrTarget)} bpm (${hm(sampleSec)} de tours ${flatSec >= 3600 ? 'plats' : 'ajustés'} en sortie longue`
      + `${share > 0 && surface > 1.005 ? `, −${fr((Math.pow(surface, share) - 1) * 100)} % pour les sentiers` : ''}), ${fr(eq)} km équivalent plat, `
      + `−${fr(fade.perHour * 100, 1)} %/h d'usure${fade.measured ? '' : ' (valeur type)'}, +${Math.round(ULTRA_STOPS * 100)} % d'arrêts`
      + `${Math.abs(calibFactor - 1) >= 0.005 ? `, recalé de ${pct(calibFactor - 1)} sur ${calib.map((x) => x.name).slice(0, 3).join(', ')}` : ''}`,
  };
}

/**
 * Trail et ultra : chaque trail récent extrapolé à la distance équivalent plat de l'objectif (Riegel, k = 1,10), corrigé
 * du progrès d'efficacité depuis, pondéré par sa fraîcheur, sa proximité, la ressemblance du terrain (dénivelé par km)
 * et le fait d'être une course ; puis ton niveau route actuel (VDOT) × ton coefficient trail mesuré sur ces sorties.
 */
export function trailModels(goal: Goal, ctx: GoalContext): Model[] {
  const segs = courseSegments(goal);
  const eqGoal = segmentsEffortKm(segs, ctx.terrain.cost);
  const ultra = ultraModel(goal, ctx, segs);
  const candidatesWithin = (maxAge: number, only: (a: Activity) => boolean) => ctx.acts
    .filter((a) => isTrail(a) && kmEffort(a) >= 15 && daysBetween(parseDay(a.date), ctx.ref) <= maxAge && only(a))
    .map((a) => {
      const age = daysBetween(parseDay(a.date), ctx.ref);
      const eq = activityEffortKm(a, ctx.terrain.cost);
      const form = formSince(ctx, a.date);
      const sim = terrainSimilarity(a, goal);
      return {
        activity: a,
        eq,
        label: a.name,
        seconds: a.durationSec * Math.pow(eqGoal / eq, TRAIL_EXPONENT) * (form?.factor ?? 1),
        weight: Math.exp(-age / 180) * Math.exp(-Math.abs(Math.log(eqGoal / eq))) * sim * (isRaceLike(a, ctx) ? 1 : 0.4),
        note: `${fr(a.distanceKm, 1)} km, ${a.elevGain ?? 0} m D+ en ${hm(a.durationSec)} (${shortYear(parseDay(a.date))}, ${ageLabel(age)}) : `
          + `${fr(eq, 1)} km équivalent plat${sim < 0.7 ? `, terrain ${elevDensity(a.distanceKm, a.elevGain, a.elevLoss) > elevDensity(goal.distanceKm, goal.elevGain, goal.elevLoss) ? 'plus raide' : 'plus roulant'}` : ''}`
          + `${form && Math.abs(form.gain) >= 0.01 ? `, efficacité ${form.gain > 0 ? '+' : '−'}${fr(Math.abs(form.gain) * 100)} % depuis (moitié retenue)` : ''}`,
      };
    })
    .sort((a, b) => b.weight - a.weight);
  let candidates = candidatesWithin(365, () => true);
  // Rien de récent : les courses de 1 à 2 ans, au poids très réduit (elles ne servent qu'à borner)
  if (!candidates.length && !ultra) candidates = candidatesWithin(730, (a) => isRaceLike(a, ctx)).map((m) => ({ ...m, weight: m.weight * 0.5 }));
  const out: Model[] = candidates.slice(0, 4).map(({ label, seconds, weight, note }) => ({ label, seconds, weight, note }));

  // Niveau route actuel × coefficient trail : rapport entre tes trails et ce que ton VDOT donnerait sur le plat
  const recent = ctx.refs.find((r) => daysBetween(parseDay(r.date), ctx.ref) <= 365);
  if (recent && candidates.length) {
    const flatTime = (km: number) => km * 1000 <= 42195
      ? timeForVdot(recent.vdot, km * 1000)
      : timeForVdot(recent.vdot, 42195) * Math.pow((km * 1000) / 42195, TRAIL_EXPONENT);
    const used = candidates.slice(0, 6);
    const w = used.reduce((s, c) => s + c.weight, 0);
    const ratio = Math.exp(used.reduce((s, c) => s + c.weight * Math.log(c.activity.durationSec / flatTime(c.eq)), 0) / w);
    out.push({
      label: 'Niveau route × coefficient trail',
      seconds: flatTime(eqGoal) * ratio,
      weight: 1,
      note: `${clock(flatTime(eqGoal))} sur ${fr(eqGoal)} km de plat d'après ${recent.label} (VDOT ${fr(recent.vdot, 1)}), `
        + `× ${fr(ratio, 2)} : ce que tes ${used.length} trails les plus proches t'ont coûté de plus que le plat`,
    });
  }
  if (ultra) out.push(ultra);
  if (out.length) return out;
  // Pas de trail récent : extrapolation depuis la route, majorée de 25 % pour le terrain
  const best = ctx.refs[0];
  return best
    ? [{ label: 'Depuis la route', seconds: riegel(best.time, best.dist, eqGoal * 1000, TRAIL_EXPONENT) * 1.25, weight: 1, note: `${best.label}, ${fr(eqGoal)} km équivalent plat, +25 % pour le terrain (${ageLabel(daysBetween(parseDay(best.date), ctx.ref))})` }]
    : [];
}

// ---------------------------------------------------------------------------
// Ajustements du jour J
// ---------------------------------------------------------------------------

export interface Adjustment {
  label: string;
  /** Effet sur le temps, en % (positif = plus lent) */
  pct: number;
  note: string;
}

/** Fraîcheur (TSB) projetée au matin de la course si la charge redescend à `taper` × la forme de fond */
export function projectedTsb(acts: Activity[], ref: Date, race: Date, taper = 0.5): { now: number; race: number } | null {
  const days = pmc(acts, ref);
  const last = days.at(-1);
  if (!last) return null;
  const kCtl = 1 - Math.exp(-1 / 42), kAtl = 1 - Math.exp(-1 / 7);
  let ctl = last.ctl, atl = last.atl;
  const load = taper * last.ctl;
  for (let d = addDays(ref, 1); d < race; d = addDays(d, 1)) {
    ctl += (load - ctl) * kCtl;
    atl += (load - atl) * kAtl;
  }
  return { now: last.ctl - last.atl, race: ctl - atl };
}

/** Zone de fraîcheur optimale +5 à +25 ; en dessous on court fatigué, au-dessus on perd du rythme */
export function freshnessPct(tsb: number): number {
  if (tsb < 5) return Math.min(3, (5 - tsb) * 0.1);
  if (tsb > 25) return Math.min(1.5, (tsb - 25) * 0.05);
  return 0;
}

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}`;

function adjustments(goal: Goal, ctx: GoalContext, daysLeft: number, course: CourseModel, base: number): Adjustment[] {
  const out: Adjustment[] = [];
  const race = parseDay(goal.date);
  if (daysLeft <= 21) {
    const tsb = projectedTsb(ctx.acts, ctx.ref, race);
    if (tsb) {
      out.push({
        label: 'Fraîcheur',
        pct: freshnessPct(tsb.race),
        note: daysLeft > 0
          ? `fraîcheur ${signed(tsb.now)} aujourd'hui, ≈ ${signed(tsb.race)} le jour J si tu réduis à la moitié de ta charge habituelle (idéal : +5 à +25)`
          : `fraîcheur ${signed(tsb.now)} la veille (idéal : +5 à +25)`,
      });
    }
  }
  // Récupération : seulement si les données santé sont fraîches (≤ 4 jours) et la course proche
  const h = ctx.health;
  if (h && daysLeft <= 10) {
    const lastDay = Object.keys(h.days).filter((d) => d <= isoDay(ctx.ref) && h.days[d].hrv).at(-1);
    if (lastDay && daysBetween(parseDay(lastDay), ctx.ref) <= 4) {
      const day = parseDay(lastDay);
      const hrv = hrvStatus(baselineSeries(h, 'hrv', day, day)[0]);
      const rhr = rhrStatus(baselineSeries(h, 'rhr', day, day)[0]);
      const pct = (hrv?.tone === 'critical' ? 1.5 : hrv?.tone === 'warning' ? 0.7 : 0) + (rhr?.tone === 'critical' ? 1 : rhr?.tone === 'warning' ? 0.5 : 0);
      out.push({ label: 'Récupération', pct, note: `VFC ${hrv?.label.toLowerCase() ?? 'inconnue'}, FC de repos ${rhr?.label ?? '?'} (au ${day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })})` });
    }
  }
  if (goal.forecast) {
    const f = goal.forecast;
    out.push({
      label: 'Météo',
      pct: heatPenalty(f.temp, f.dew),
      note: `prévision : ${Math.round(f.temp)} °C, rosée ${Math.round(f.dew)} °C, vent ${Math.round(f.wind)} km/h (règle de Hadley)`,
    });
  }
  // Route : le profil (GPX, sinon D+ annoncé) coûte face au plat de tes références
  if (goal.kind === 'road' && course.category !== 'ultra' && (course.gpx || (goal.elevGain ?? 0) > 0)) {
    const pct = (course.effortKm / goal.distanceKm - 1) * 100;
    if (Math.abs(pct) >= 0.1) {
      out.push({ label: 'Profil du parcours', pct, note: `${fr(course.effortKm, 1)} km équivalent plat pour ${fr(goal.distanceKm, 1)} km avec ta courbe de pente en côte${course.gpx ? ' (tracé GPX)' : ' (D+ réparti uniformément)'}` });
    }
  }
  // Nuit : simulée sur le profil, de la fin du crépuscule à l'aube (frontale), plus le creux de 2 h à 6 h
  if (goal.kind === 'trail' && course.night && course.startMin !== null) {
    const opts = { cost: course.cost, fadePerHour: course.fadePerHour, fadeFromH: course.fadeFromH };
    const day = fitTimeline(course.segments, base, opts);
    const night = simulate(course.segments, { ...opts, speed: day.speed, startMin: course.startMin, night: course.night }).total;
    const pct = (night / day.total - 1) * 100;
    if (pct >= 0.1) {
      const hours = nightHours(course.startMin, night, course.night);
      out.push({
        label: 'Nuit',
        pct,
        note: `≈ ${hm(hours * 3600)} à la frontale (nuit de ${clockMin(course.night.dusk)} à ${clockMin(course.night.dawn)}) : +3 % sur les parties roulantes, +8 % en descente raide, +2 % de 2 h à 6 h (ordres de grandeur)`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Préparation
// ---------------------------------------------------------------------------

export interface ReadinessItem {
  label: string;
  value: string;
  target: string;
  /** 0 à 1 */
  score: number;
  /** Score atteignable d'ici le début de l'affûtage en suivant le conseil */
  projected: number;
  weight: number;
  advice: string | null;
}

const fr = (x: number, digits = 0) => x.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const hm = (sec: number) => {
  const min = Math.round(sec / 60);
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const shortYear = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function readiness(goal: Goal, ctx: GoalContext, baseSec: number, daysLeft: number): ReadinessItem[] {
  const race = parseDay(goal.date);
  const age = (a: Activity) => daysBetween(parseDay(a.date), ctx.ref);
  const window = (days: number) => ctx.acts.filter((a) => age(a) >= 0 && age(a) < days);
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  // L'affûtage commence 2 semaines avant (10 jours pour un 10 km / semi) : c'est la date limite des conseils
  const taperDays = goal.kind === 'trail' || goal.distanceKm > 30 ? 14 : 10;
  const deadline = addDays(race, -taperDays);
  const weeksLeft = Math.max(0, Math.floor(daysBetween(ctx.ref, deadline) / 7));
  const items: ReadinessItem[] = [];

  const weekly = window(42).reduce((s, a) => s + a.distanceKm, 0) / 6;
  const volTarget = goal.kind === 'trail' ? Math.min(100, 0.75 * goal.distanceKm) : Math.min(80, Math.max(25, 1.7 * goal.distanceKm));
  const reachable = weekly * Math.pow(1.1, weeksLeft);
  items.push({
    label: 'Volume',
    value: `${fr(weekly)} km/sem`,
    target: `${fr(volTarget)} km/sem`,
    score: clamp(weekly / volTarget),
    projected: clamp(Math.max(weekly, Math.min(volTarget, reachable)) / volTarget),
    weight: goal.kind === 'trail' ? 20 : 25,
    advice: weekly >= volTarget || !weeksLeft ? null
      : reachable >= volTarget ? `Monter vers ${fr(volTarget)} km/sem d'ici le ${shortDate(deadline)}, sans dépasser +10 % par semaine.`
      : `+10 %/sem au maximum : vise ${fr(reachable)} km/sem d'ici le ${shortDate(deadline)}.`,
  });

  if (goal.kind === 'trail') {
    const longest = window(112).reduce((m, a) => Math.max(m, a.durationSec), 0);
    const target = Math.min(6 * 3600, 0.45 * baseSec);
    items.push({
      label: 'Sortie la plus longue',
      value: hm(longest),
      target: hm(target),
      score: clamp(longest / target),
      projected: weeksLeft >= 2 ? 1 : clamp(longest / target),
      weight: 25,
      advice: longest >= target ? null : `Une sortie d'au moins ${hm(target)} (idéalement de nuit, avec le sac et la frontale) avant le ${shortDate(addDays(deadline, -7))}.`,
    });
    const elev = window(42).reduce((s, a) => s + (a.elevGain ?? 0), 0) / 6;
    const elevTarget = 0.4 * (goal.elevGain ?? 0);
    if (elevTarget > 0) {
      items.push({
        label: 'D+ hebdomadaire',
        value: `${fr(elev)} m/sem`,
        target: `${fr(elevTarget)} m/sem`,
        score: clamp(elev / elevTarget),
        projected: weeksLeft >= 3 ? 1 : clamp(elev / elevTarget),
        weight: 20,
        advice: elev >= elevTarget ? null : `Ajoute du dénivelé : côtes en semaine, trail le week-end, ≈ ${fr(elevTarget)} m/sem (et de la descente pour les quadriceps).`,
      });
    }
    const ke = goalKmEffort(goal);
    const best = ctx.acts.reduce<Activity | null>((m, a) => (!m || kmEffort(a) > kmEffort(m) ? a : m), null);
    const ratio = best ? kmEffort(best) / ke : 0;
    items.push({
      label: 'Expérience',
      value: best ? `${fr(kmEffort(best))} km-effort` : '–',
      target: `${fr(0.75 * ke)}`,
      score: clamp(ratio / 0.75),
      projected: clamp(ratio / 0.75),
      weight: 15,
      advice: ratio >= 0.75 ? null : `Ton plus gros effort (${best?.name}) ne fait que ${Math.round(ratio * 100)} % de la course : pars plus lentement que tu ne le penses, la gestion (allure, ravitaillement) comptera double.`,
    });
    const night = window(112).filter((a) => a.start && (new Date(a.start * 1000).getHours() >= 20 || new Date(a.start * 1000).getHours() < 5)).length;
    items.push({
      label: 'Sorties de nuit',
      value: `${night} (16 sem.)`,
      target: '2',
      score: night >= 2 ? 1 : night === 1 ? 0.6 : 0.2,
      projected: weeksLeft >= 1 ? 1 : night >= 2 ? 1 : night === 1 ? 0.6 : 0.2,
      weight: 5,
      advice: night >= 2 ? null : 'Une ou deux sorties à la frontale pour régler l\'éclairage et la vigilance.',
    });
  } else {
    const longest = window(56).reduce((m, a) => Math.max(m, a.distanceKm), 0);
    const target = Math.min(32, 0.9 * goal.distanceKm);
    items.push({
      label: 'Sortie la plus longue',
      value: `${fr(longest, 1)} km`,
      target: `${fr(target)} km`,
      score: clamp(longest / target),
      projected: weeksLeft >= 1 ? 1 : clamp(longest / target),
      weight: 25,
      advice: longest >= target ? null : `Une sortie de ${fr(target)} km avant le ${shortDate(deadline)}.`,
    });
    if (goal.targetSec) {
      const pace = goal.targetSec / goal.distanceKm;
      const km = window(42).reduce((s, a) => s + (a.splits ?? []).filter((x) => x <= pace * 1.02).length, 0);
      const target = Math.min(25, goal.distanceKm);
      items.push({
        label: 'Km à l\'allure cible (6 sem.)',
        value: `${km} km`,
        target: `${fr(target)} km`,
        score: clamp(km / target),
        projected: weeksLeft >= 2 ? 1 : clamp(km / target),
        weight: 25,
        advice: km >= target ? null : weeksLeft >= 1 ? `Des blocs à l'allure cible (ex. 3 × 3 km) pour l'ancrer avant le ${shortDate(deadline)}.` : null,
      });
    }
  }

  // Durabilité (dès que la course dépasse 75 min) : perte d'efficacité médiane des 5 dernières sorties régulières
  // comparables sur 16 semaines : trail pour un trail, route pour la route, d'une durée proche de celle de la course
  if (baseSec >= 75 * 60) {
    const comparable = (minHours: number) =>
      window(112)
        .filter((a) => !['interval', 'tempo'].includes(ctx.types.get(a.id) ?? ''))
        .map(durability)
        .filter((d): d is Durability => d !== null && d.steady && d.trail === (goal.kind === 'trail') && d.hours >= minHours);
    let runs = comparable(Math.max(1.25, (0.8 * baseSec) / 3600));
    if (runs.length < 2) runs = comparable(1.25);
    runs = runs.slice(-5);
    if (runs.length) {
      // La dérive cardiaque croît avec la durée : la perte tolérée est proportionnelle à celle de chaque sortie
      // (2,5 %/h), on ne juge que l'excédent. Sur un ultra, on ne s'entraîne jamais à la durée de la course :
      // la mesure sur des sorties de 3 h dit peu de chose sur 10 h, son poids est donc réduit.
      const TOL_PER_HOUR = 2.5;
      const ultra = baseSec > 5 * 3600;
      const loss = [...runs.map((r) => r.efLoss)].sort((x, y) => x - y)[runs.length >> 1];
      const excess = [...runs.map((r) => r.efLoss - TOL_PER_HOUR * r.hours)].sort((x, y) => x - y)[runs.length >> 1];
      const score = clamp((10 - excess) / 10);
      const longest = Math.max(...runs.map((r) => r.hours));
      items.push({
        label: `Durabilité ${goal.kind === 'trail' ? 'trail' : 'route'}`,
        value: `${loss > 0 ? '−' : '+'}${fr(Math.abs(loss), 1)} % (${runs.length} sorties)`,
        target: `≤ ${fr(TOL_PER_HOUR, 1)} % par heure`,
        score,
        projected: weeksLeft >= 3 ? clamp(score + 0.3) : score,
        weight: ultra ? 6 : goal.kind === 'trail' ? 15 : 10,
        advice: excess <= 0
          ? null
          : ultra
            ? `Ton efficacité baisse de ${fr(loss)} % en fin de sortie longue, un peu plus que la dérive normale : ravitaille-toi dès la première heure et enchaîne deux longues sorties sur un week-end plutôt que d'en allonger une seule.`
            : `Ton efficacité baisse de ${fr(loss)} % en fin de sortie longue${goal.kind === 'trail' ? ' en trail' : ''}, plus que la dérive normale pour cette durée : allonge progressivement les sorties en endurance fondamentale, ravitaille-toi dès la première heure, et finis certaines sorties par 20 min à allure course.`,
      });
      if (baseSec > longest * 3600 * 1.3) {
        const note = `Durabilité mesurée jusqu'à ${hm(longest * 3600)} seulement, pour une course d'environ ${hm(baseSec)} : au-delà, c'est une extrapolation.`;
        const it = items.at(-1)!;
        it.advice = it.advice ? `${it.advice} ${note}` : note;
        it.score = Math.min(it.score, 0.99);
      }
    }
  }

  // Régularité : semaines (glissantes) avec au moins 3 sorties sur les 8 dernières
  let regular = 0;
  for (let w = 0; w < 8; w++) {
    const n = ctx.acts.filter((a) => age(a) >= w * 7 && age(a) < (w + 1) * 7).length;
    if (n >= 3) regular++;
  }
  items.push({
    label: 'Régularité',
    value: `${regular} sem. sur 8`,
    target: '7 sem. à 3 sorties',
    score: clamp(regular / 7),
    projected: clamp(regular / 7),
    weight: goal.kind === 'trail' ? 10 : 15,
    advice: null,
  });

  // Récupération (si les données santé sont récentes)
  const h = ctx.health;
  const lastDay = h ? Object.keys(h.days).filter((d) => d <= isoDay(ctx.ref) && (h.days[d].hrv || h.days[d].sleepMin)).at(-1) : undefined;
  if (h && lastDay && daysBetween(parseDay(lastDay), ctx.ref) <= 7) {
    const day = parseDay(lastDay);
    const hrv = hrvStatus(baselineSeries(h, 'hrv', day, day)[0]);
    const rhr = rhrStatus(baselineSeries(h, 'rhr', day, day)[0]);
    const sleep = sleepDebt(h, day);
    const toneScore = (t?: string) => (t === 'critical' ? 0.2 : t === 'warning' ? 0.6 : 1);
    const sleepScore = sleep ? clamp(sleep.avg / 420) : 1;
    const score = (toneScore(hrv?.tone) + toneScore(rhr?.tone) + sleepScore) / 3;
    items.push({
      label: 'Récupération',
      value: `VFC ${hrv?.label.toLowerCase() ?? '?'}, ${sleep ? hm(sleep.avg * 60) : '?'}`,
      target: 'base, 7 h',
      score,
      projected: score,
      weight: goal.kind === 'trail' ? 5 : 10,
      advice: sleepScore < 0.95 ? 'Le sommeil des derniers jours est court : priorité aux nuits de 7 h et plus d\'ici la course.' : null,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Évaluation complète
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'neutral' | 'warning' | 'serious';

/** Lecture d'une probabilité : sous 10 %, ce n'est plus ambitieux mais hors de portée */
export function chanceVerdict(p: number): { label: string; tone: Tone } {
  return p >= 0.75 ? { label: 'Très probable', tone: 'good' }
    : p >= 0.5 ? { label: 'Probable', tone: 'good' }
    : p >= 0.25 ? { label: 'Jouable', tone: 'warning' }
    : p >= 0.1 ? { label: 'Ambitieux', tone: 'warning' }
    : { label: 'Hors de portée', tone: 'serious' };
}

/** Parcours de l'objectif tel que le voient les modèles : tronçons, coût des pentes, usure, nuit */
export interface CourseModel {
  category: RaceCategory;
  segments: Segment[];
  waypoints: Waypoint[];
  /** Tracé GPX importé (sinon profil synthétique) */
  gpx: boolean;
  cost: (grade: number) => number;
  terrain: Terrain;
  /** Distance équivalent plat (km) avec ta courbe de pente */
  effortKm: number;
  /** Usure par heure (0 sur route : le plan d'allure est régulier) */
  fadePerHour: number;
  fadeFromH: number;
  /** Part du temps aux ravitaillements */
  stopShare: number;
  /** Heure de départ (minutes) et nuit civile du jour de la course */
  startMin: number | null;
  night: { dusk: number; dawn: number } | null;
}

export const METHODS: Record<RaceCategory, string> = {
  road: 'Route : consensus de modèles calés sur tes courses et tes meilleurs efforts (VDOT, Riegel avec ton exposant, '
    + 'dernière course sur la distance projetée avec l\'entraînement depuis, vitesse critique ; Tanda et Vickers au marathon), '
    + 'corrigé du profil du parcours.',
  trail: 'Trail : tes trails récents extrapolés en distance équivalent plat (ta courbe vitesse / pente), pondérés par '
    + 'fraîcheur, proximité et ressemblance du terrain, et ton niveau route actuel multiplié par ton coefficient trail.',
  ultra: 'Ultra : les modèles du trail, plus une simulation tronçon par tronçon à ta FC d\'endurance avec ton usure par '
    + 'heure, les sentiers et les ravitaillements ; incertitude élargie (8 % d\'un jour à l\'autre, plus l\'extrapolation '
    + 'au-delà de ta plus longue sortie).',
};

export function courseModel(goal: Goal, ctx: GoalContext): CourseModel {
  const category = raceCategory(goal);
  const segments = courseSegments(goal);
  const fade = goal.kind === 'trail' || category === 'ultra' ? fadeEstimate(ctx).perHour : 0;
  const startMin = goal.startTime ? Number(goal.startTime.slice(0, 2)) * 60 + Number(goal.startTime.slice(3, 5)) : null;
  return {
    category,
    segments,
    waypoints: courseWaypoints(goal),
    gpx: !!goal.course,
    cost: ctx.terrain.cost,
    terrain: ctx.terrain,
    effortKm: segmentsEffortKm(segments, ctx.terrain.cost),
    fadePerHour: fade,
    fadeFromH: 1,
    stopShare: category === 'ultra' ? ULTRA_STOPS : 0,
    startMin,
    night: startMin !== null ? nightWindow(goal.date, goal.lat ?? 45, goal.lon ?? 3) : null,
  };
}

/** Heures passées de nuit entre le départ et l'arrivée */
function nightHours(startMin: number, total: number, w: { dusk: number; dawn: number }): number {
  let n = 0;
  for (let t = 0; t < total; t += 300) {
    const m = (((startMin + t / 60) % 1440) + 1440) % 1440;
    if (m >= w.dusk || m < w.dawn) n += Math.min(300, total - t);
  }
  return n / 3600;
}

const clockMin = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

export interface GoalEvaluation {
  goal: Goal;
  daysLeft: number;
  ke: number;
  models: Model[];
  /** Consensus brut des modèles */
  base: number;
  adjustments: Adjustment[];
  /** Temps le plus probable, ajustements compris */
  predicted: number;
  sigma: number;
  /** Intervalle à 80 % */
  low: number;
  high: number;
  /** Probabilité (0-1) de passer sous le chrono visé */
  probability: number | null;
  /** Probabilité de passer sous le chrono ambitieux de la fourchette */
  stretchProbability: number | null;
  /** Écart-type relatif retenu, et ses parts : modèles, jour de course, extrapolation */
  uncertainty: { models: number; day: number; extrapolation: number };
  category: RaceCategory;
  method: string;
  /** Distance équivalent plat (km) avec ta courbe de pente */
  effortKm: number;
  course: CourseModel;
  readiness: ReadinessItem[];
  readinessScore: number;
  readinessProjected: number;
  /** Indice affiché (0-100) : probabilité pour un chrono, préparation pour « finir » */
  index: number;
  verdict: { label: string; tone: Tone };
  advice: string[];
  /** Courses déjà faites sur la distance (trail : les plus proches en distance équivalent plat et en terrain) */
  raceRefs: RaceReference[];
  /** Projection de la dernière course sur la distance jusqu'à aujourd'hui (route) */
  progression: Progression | null;
  /** Stratégie de course : allure, cardio, ravitaillement, veille, échauffement, conditions */
  plan: RacePlan;
  result: Activity | null;
}

/** `all` : toutes les sorties, pour retrouver le résultat d'un objectif passé */
export function evaluateGoal(goal: Goal, ctx: GoalContext, today: Date, all: Activity[]): GoalEvaluation | null {
  const race = parseDay(goal.date);
  const daysLeft = daysBetween(today, race);
  const ke = goalKmEffort(goal);
  const course = courseModel(goal, ctx);
  const models = goal.kind === 'trail' ? trailModels(goal, ctx) : roadModels(goal, ctx);
  const ultraRoad = goal.kind === 'road' && course.category === 'ultra' ? ultraModel(goal, ctx, course.segments) : null;
  if (ultraRoad) models.push(ultraRoad);
  const c = consensus(models);
  if (!c) return null;

  const items = readiness(goal, ctx, c.seconds, Math.max(0, daysLeft));
  const wSum = items.reduce((s, i) => s + i.weight, 0);
  const readinessScore = items.reduce((s, i) => s + i.score * i.weight, 0) / wSum;
  const readinessProjected = items.reduce((s, i) => s + i.projected * i.weight, 0) / wSum;

  const adj = adjustments(goal, ctx, Math.max(0, daysLeft), course, c.seconds);
  // Préparation spécifique : jusqu'à +3 % si les fondations (volume, sortie longue, allure) sont incomplètes
  const prepScore = daysLeft > 21 ? readinessProjected : readinessScore;
  if (prepScore < 0.8) {
    adj.push({ label: 'Préparation', pct: (3 * (0.8 - prepScore)) / 0.8, note: `indice de préparation ${Math.round(prepScore * 100)}/100${daysLeft > 21 ? ' (projeté)' : ''}` });
  }
  const factor = adj.reduce((f, a) => f * (1 + a.pct / 100), 1);
  const predicted = c.seconds * factor;
  // Extrapolation : au-delà de ta plus longue sortie de l'année, +4 % d'écart-type par facteur e de durée (ultra)
  const longest = ctx.acts.filter((a) => daysBetween(parseDay(a.date), ctx.ref) <= 365).reduce((m, a) => Math.max(m, a.durationSec), 0);
  const uncertainty = {
    models: c.spread,
    day: daySd(course.category, goal.distanceKm),
    extrapolation: course.category === 'ultra' && longest > 0 ? 0.04 * Math.max(0, Math.log(predicted / longest)) : 0,
  };
  const sigma = Math.hypot(uncertainty.models, uncertainty.day, uncertainty.extrapolation);
  const probability = goal.targetSec ? chance(goal.targetSec, predicted, sigma) : null;
  const stretchProbability = goal.stretchSec ? chance(goal.stretchSec, predicted, sigma) : null;
  const index = Math.round(100 * (probability ?? readinessScore));

  const verdict: GoalEvaluation['verdict'] = probability !== null
    ? chanceVerdict(probability)
    : index >= 80 ? { label: 'Prêt', tone: 'good' }
      : index >= 60 ? { label: 'En bonne voie', tone: 'good' }
      : index >= 40 ? { label: 'À consolider', tone: 'warning' }
      : { label: 'Insuffisant', tone: 'serious' };

  const advice: string[] = [];
  if (goal.targetSec) {
    const pace = goal.targetSec / goal.distanceKm;
    if (ctx.cs && goal.distanceKm > 15 && 1000 / pace / ctx.cs.cs > 0.94) {
      advice.push(`Ta vitesse critique mesurée (${paceStr(1000 / ctx.cs.cs)} /km) est à peine plus lente que l'allure visée : soit elle est sous-estimée faute d'effort maximal récent de 3 à 20 min, soit l'objectif frôle ton seuil actuel. Dans les deux cas, pas d'excès d'optimisme sur les 5 premiers km.`);
    }
    if (probability !== null && probability < 0.4) {
      advice.push(goal.kind === 'trail'
        ? `Plan B réaliste : ${hm(Math.ceil(predicted / 600) * 600)}. Pars sur ce rythme : en ultra, le temps se gagne dans la seconde moitié en ralentissant moins que les autres, pas au départ.`
        : `Plan B réaliste : ${hm(Math.ceil(predicted / 60) * 60).replace(' h ', ':')} (${paceStr(predicted / goal.distanceKm)} /km). Tu peux partir sur ce rythme et décider au 10e km.`);
    } else if (probability !== null && goal.kind === 'road') {
      advice.push(`Allure cible ${paceStr(pace)} /km : les 3 premiers km 2 à 3 s plus lents, puis régulier ; le dernier tiers dira s'il reste de la marge.`);
    }
  }
  const lastMarathon = [...ctx.acts].reverse().find((a) => a.distanceKm >= 40 && wallAnalysis(a)?.wall);
  if (lastMarathon && (goal.distanceKm >= 30 || goal.kind === 'trail')) {
    advice.push(`Ton marathon s'est terminé au mur : vise 60 à 90 g de glucides par heure dès la première heure, et teste ton ravitaillement sur les sorties longues.`);
  }
  for (const i of items) if (i.advice && i.score < 1) advice.push(i.advice);

  const raceRefs = raceReferences(goal, ctx);
  return {
    goal, daysLeft, ke, models, base: c.seconds, adjustments: adj, predicted, sigma,
    low: predicted * Math.exp(-1.2816 * sigma), high: predicted * Math.exp(1.2816 * sigma),
    probability, stretchProbability, uncertainty, category: course.category, method: METHODS[course.category],
    effortKm: course.effortKm, course, readiness: items, readinessScore, readinessProjected, index, verdict, advice, raceRefs,
    progression: goal.kind === 'road' && raceRefs.length ? progressionSince(raceRefs[0], ctx) : null,
    plan: racePlan({ goal, daysLeft, ke, predicted, probability, raceRefs, athlete: ctx.athlete, acts: ctx.acts, course }),
    result: race <= today ? goalResult(goal, all) : null,
  };
}

/** Sortie correspondant à un objectif passé (même jour ou lendemain, distance à ±15 %) */
export function goalResult(goal: Goal, acts: Activity[]): Activity | null {
  const race = parseDay(goal.date);
  return acts.find((a) => {
    const d = daysBetween(race, parseDay(a.date));
    return d >= -1 && d <= 1 && Math.abs(a.distanceKm - goal.distanceKm) / goal.distanceKm < 0.15;
  }) ?? null;
}

function paceStr(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}
