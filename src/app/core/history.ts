/**
 * Historiques recalculés : ce que les modèles auraient prédit à une date passée, avec les seules données connues ce jour-là.
 * - Chrono estimé sur les distances de référence (5 km → marathon) : consensus des modèles de `roadModels`.
 * - Indice de confiance d'un objectif semaine après semaine (`evaluateGoal` rejoué à chaque date).
 * La prédiction de la montre (Coros) n'est qu'un instantané du jour : elle est exclue des dates passées.
 */
import { Activity, Athlete, Goal, Health } from './models';
import { SessionType } from './science';
import { GoalEvaluation, consensus, evaluateGoal, goalContext, roadModels } from './goals';
import { addDays, isoDay, parseDay } from './stats';

const DAY_MS = 86_400_000;

export const REFERENCE_DISTANCES = [
  { key: '5k', label: '5 km', km: 5 },
  { key: '10k', label: '10 km', km: 10 },
  { key: 'semi', label: 'Semi', km: 21.0975 },
  { key: 'marathon', label: 'Marathon', km: 42.195 },
] as const;
export type DistanceKey = (typeof REFERENCE_DISTANCES)[number]['key'];

export interface PredictionPoint {
  date: string;
  /** Consensus des modèles (s) par distance ; absent si aucun modèle ce jour-là */
  times: Partial<Record<DistanceKey, number>>;
}

/** Dates régulièrement espacées de `from` à `to` (inclus), au plus `max` points, une semaine d'écart au moins */
export function sampleDates(from: Date, to: Date, max = 60): Date[] {
  const days = Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const step = Math.max(7, Math.ceil(days / max));
  const out: Date[] = [];
  for (let d = 0; d <= days; d += step) out.unshift(addDays(to, -d));
  return out;
}

/** Chrono estimé sur chaque distance de référence à chaque date (consensus géométrique des modèles, hors montre) */
export function predictionHistory(
  acts: Activity[],
  types: Map<string, SessionType>,
  athlete: Athlete,
  dates: Date[],
): PredictionPoint[] {
  return dates.map((ref) => predictionPoint(acts, types, athlete, ref));
}

export function predictionPoint(acts: Activity[], types: Map<string, SessionType>, athlete: Athlete, ref: Date): PredictionPoint {
  // Une course ne se prédit pas elle-même : objectif fictif le lendemain, contexte arrêté à la date
  const probe: Goal = { id: 'probe', name: '', date: isoDay(addDays(ref, 1)), distanceKm: 10, kind: 'road' };
  const ctx = goalContext(probe, acts, types, athlete, ref, {}, null);
  const times: PredictionPoint['times'] = {};
  for (const d of REFERENCE_DISTANCES) {
    const c = consensus(roadModels({ ...probe, distanceKm: d.km }, ctx));
    if (c) times[d.key] = c.seconds;
  }
  return { date: isoDay(ref), times };
}

export interface ConfidencePoint {
  date: string;
  daysLeft: number;
  /** Indice affiché (0-100) : probabilité pour un chrono, préparation pour « finir » */
  index: number;
  predicted: number;
}

/**
 * Indice de confiance d'un objectif rejoué chaque semaine sur `weeks` semaines, jusqu'à aujourd'hui (ou la veille
 * pour une course passée). Le dernier point est l'évaluation affichée (`current`).
 */
export function confidenceHistory(
  current: GoalEvaluation,
  acts: Activity[],
  types: Map<string, SessionType>,
  athlete: Athlete,
  health: Health | null,
  today: Date,
  weeks = 26,
): ConfidencePoint[] {
  const points = confidenceDates(current.goal, today, weeks).map((ref) => confidencePoint(current.goal, ref, acts, types, athlete, health));
  return [...points.filter((p): p is ConfidencePoint => p !== null), currentPoint(current, today)];
}

/** Dates rejouées : chaque semaine pendant `weeks` semaines avant aujourd'hui (ou la veille d'une course passée) */
export function confidenceDates(goal: Goal, today: Date, weeks = 26): Date[] {
  const end = evalDay(goal, today);
  return Array.from({ length: weeks }, (_, i) => addDays(end, -7 * (weeks - i)));
}

/** L'indice tel qu'il aurait été calculé le jour `ref` */
export function confidencePoint(
  goal: Goal, ref: Date, acts: Activity[], types: Map<string, SessionType>, athlete: Athlete, health: Health | null,
): ConfidencePoint | null {
  const daysLeft = Math.round((parseDay(goal.date).getTime() - ref.getTime()) / DAY_MS);
  // La prévision météo n'existait pas encore à plus de 15 jours
  const g: Goal = daysLeft > 15 ? { ...goal, forecast: null } : goal;
  const e = evaluateGoal(g, goalContext(g, acts, types, athlete, ref, {}, health), ref, acts);
  return e ? { date: isoDay(ref), daysLeft, index: e.index, predicted: e.predicted } : null;
}

/** Dernier point : l'évaluation affichée */
export function currentPoint(current: GoalEvaluation, today: Date): ConfidencePoint {
  const end = evalDay(current.goal, today);
  return { date: isoDay(end), daysLeft: Math.round((parseDay(current.goal.date).getTime() - end.getTime()) / DAY_MS), index: current.index, predicted: current.predicted };
}

const evalDay = (goal: Goal, today: Date) => {
  const race = parseDay(goal.date);
  return race <= today ? addDays(race, -1) : today;
};
