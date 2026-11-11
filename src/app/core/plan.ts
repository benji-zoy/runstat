import { Activity, Goal, PlanKind, PlanSession, PlannedCalendar, PlannedSession } from './models';
import { SessionType } from './science';
import { addDays, isoDay, parseDay, startOfWeek } from './stats';

/**
 * Plan d'entraînement importé (rendu par une IA, voir src/engine/plan/plan.ts) et calendrier COROS réunis : c'est ce que
 * l'indice de confiance projette jusqu'au jour J et ce qu'affiche « Séance du jour ». Le calendrier COROS est prioritaire :
 * une semaine qui a au moins une séance COROS ne prend que celles-là ; les autres semaines prennent le plan importé.
 */

export interface LoadRates {
  /** Charge par minute (échelle de trainingLoad) */
  easy: number;
  quality: number;
  race: number;
  /** Allure facile habituelle (s/km), pour une séance donnée en distance */
  easyPace: number;
}

const EASY: SessionType[] = ['easy', 'recovery', 'long', 'trail'];
const QUALITY: SessionType[] = ['interval', 'tempo'];

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Charge par minute mesurée sur tes 120 derniers jours, par nature de séance (sinon ordres de grandeur) */
export function loadRates(acts: Activity[], types: Map<string, SessionType>, ref: Date): LoadRates {
  const since = isoDay(addDays(ref, -120));
  const recent = acts.filter((a) => a.date >= since && a.date <= isoDay(ref) && a.durationSec > 600);
  const rate = (ts: SessionType[]) =>
    median(recent.filter((a) => ts.includes(types.get(a.id) ?? 'easy') && (a.trainingLoad ?? 0) > 0).map((a) => a.trainingLoad! / (a.durationSec / 60)));
  const pace = median(recent.filter((a) => EASY.includes(types.get(a.id) ?? 'easy') && a.distanceKm > 2).map((a) => a.durationSec / a.distanceKm));
  const easy = rate(EASY) ?? 1;
  return { easy, quality: rate(QUALITY) ?? easy * 1.5, race: rate(['race']) ?? easy * 1.8, easyPace: pace ?? 360 };
}

const RATE: Record<PlanKind, keyof Omit<LoadRates, 'easyPace'> | null> = { easy: 'easy', long: 'easy', quality: 'quality', race: 'race', strength: null, other: 'easy' };

/** Durée prévue (s) : celle du plan, sinon la distance à ton allure facile */
export function sessionSeconds(s: PlanSession, rates: LoadRates): number | null {
  if (s.durationMin) return s.durationMin * 60;
  if (s.distanceKm) return s.distanceKm * (s.kind === 'quality' || s.kind === 'race' ? rates.easyPace * 0.85 : rates.easyPace);
  return null;
}

/** Séance du plan importé au format du calendrier (charge estimée) */
export function toPlanned(s: PlanSession, rates: LoadRates): PlannedSession {
  const sec = sessionSeconds(s, rates);
  const key = RATE[s.kind];
  return {
    date: s.date,
    name: s.name,
    distanceKm: s.distanceKm ?? (s.durationMin && key ? Math.round(((s.durationMin * 60) / rates.easyPace) * 10) / 10 : null),
    durationSec: sec !== null ? Math.round(sec) : null,
    load: key && sec !== null ? Math.round((rates[key] * sec) / 60) : 0,
    imported: true,
    kind: s.kind,
    ...(s.steps ? { steps: s.steps } : {}),
    ...(s.phase ? { phase: s.phase } : {}),
  };
}

const weekKey = (date: string) => isoDay(startOfWeek(parseDay(date)));

/** Le calendrier COROS est utilisable (synchronisé depuis moins de 14 jours) */
export const corosFresh = (planned: PlannedCalendar | null | undefined, ref: Date) =>
  !!planned?.sessions && (ref.getTime() - new Date(planned.fetchedAt).getTime()) / 86_400_000 <= 14;

/**
 * Calendrier + plan importé : semaine par semaine, COROS d'abord. `strength` : garder le renfo (affichage ; l'indice ne
 * le compte pas). Null si ni l'un ni l'autre.
 */
export function mergeCalendars(
  planned: PlannedCalendar | null | undefined,
  imported: PlanSession[],
  rates: LoadRates,
  ref: Date,
  { strength = false } = {},
): PlannedCalendar | null {
  const coros = corosFresh(planned, ref) ? planned! : null;
  const own = imported.filter((s) => strength || s.kind !== 'strength');
  if (!own.length) return coros;
  const corosWeeks = new Set((coros?.sessions ?? []).map((s) => weekKey(s.date)));
  const kept = own.filter((s) => !corosWeeks.has(weekKey(s.date))).map((s) => toPlanned(s, rates));
  const sessions = [...(coros?.sessions ?? []), ...kept].sort((a, b) => a.date.localeCompare(b.date));
  const dates = sessions.map((s) => s.date);
  return {
    source: coros ? 'coros' : 'import',
    // Le plan importé ne se périme pas : la fraîcheur est celle du jour
    fetchedAt: coros && !kept.length ? coros.fetchedAt : ref.toISOString(),
    from: [coros?.from, dates[0]].filter(Boolean).sort()[0] as string,
    to: [coros?.to, dates.at(-1)].filter(Boolean).sort().at(-1) as string,
    sessions,
  };
}

/** Plan importé qui vaut pour un objectif : le sien, sinon celui de l'objectif principal qu'il prépare */
export function planOf(goal: Goal, goals: Goal[]): PlanSession[] {
  if (goal.plan?.sessions.length) return goal.plan.sessions;
  const main = goal.parent ? goals.find((g) => g.id === goal.parent) : null;
  return main?.plan?.sessions ?? [];
}

/** Calendrier projeté pour un objectif (indice de confiance) */
export function goalPlanned(goal: Goal, goals: Goal[], planned: PlannedCalendar | null | undefined, rates: LoadRates, ref: Date): PlannedCalendar | null {
  return mergeCalendars(planned, planOf(goal, goals), rates, ref);
}

/** Toutes les séances prévues (calendrier COROS + plans des objectifs à venir), renfo compris : « Séance du jour » */
export function upcomingPlanned(goals: Goal[], planned: PlannedCalendar | null | undefined, rates: LoadRates, ref: Date): PlannedSession[] {
  const today = isoDay(ref);
  const seen = new Set<string>();
  const imported: PlanSession[] = [];
  for (const g of [...goals].filter((g) => g.date >= today).sort((a, b) => a.date.localeCompare(b.date))) {
    for (const s of g.plan?.sessions ?? []) {
      const k = `${s.date}|${s.name}`;
      if (!seen.has(k)) (seen.add(k), imported.push(s));
    }
  }
  return mergeCalendars(planned, imported, rates, ref, { strength: true })?.sessions ?? [];
}

/** Semaines d'un plan (lundi), avec volume et nombre de séances, pour la liste de la fiche */
export interface PlanWeek {
  start: string;
  phase: string | null;
  km: number;
  minutes: number;
  sessions: PlanSession[];
}

export function planWeeks(sessions: PlanSession[], rates: LoadRates): PlanWeek[] {
  const map = new Map<string, PlanWeek>();
  for (const s of sessions) {
    const k = weekKey(s.date);
    const w = map.get(k) ?? { start: k, phase: null, km: 0, minutes: 0, sessions: [] };
    w.sessions.push(s);
    const p = toPlanned(s, rates);
    w.km += s.kind === 'strength' ? 0 : (p.distanceKm ?? 0);
    w.minutes += (p.durationSec ?? 0) / 60;
    w.phase ??= s.phase ?? null;
    map.set(k, w);
  }
  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export const PLAN_KIND_LABELS: Record<PlanKind, string> = {
  easy: 'Facile',
  quality: 'Qualité',
  long: 'Sortie longue',
  race: 'Course',
  strength: 'Renfo',
  other: 'Autre',
};

// ---------------------------------------------------------------------------
// Conseils de l'assistant « Préparer mon plan »
// ---------------------------------------------------------------------------

export interface VolumeBand {
  min: number;
  /** null : « et plus » */
  max: number | null;
}

/** Volume moyen des 6 dernières semaines (km/semaine) */
export function currentWeekly(acts: Activity[], ref: Date): number {
  const since = isoDay(addDays(ref, -42));
  return acts.filter((a) => a.date > since && a.date <= isoDay(ref)).reduce((s, a) => s + a.distanceKm, 0) / 6;
}

/**
 * Volume conseillé au plus fort du plan : le repère de l'indice de préparation (1,7 × la distance sur route, 25 à 80 km ;
 * 0,75 × la distance en trail, 100 km au plus), sans dépasser +10 % par semaine depuis ton volume actuel jusqu'à l'affûtage.
 */
export function recommendedVolume(goal: Goal, weekly: number, ref: Date): number {
  const target = goal.kind === 'trail' ? Math.min(100, 0.75 * goal.distanceKm) : Math.min(80, Math.max(25, 1.7 * goal.distanceKm));
  const taper = goal.kind === 'trail' || goal.distanceKm > 30 ? 14 : 10;
  const weeks = Math.max(0, Math.floor(((parseDay(goal.date).getTime() - ref.getTime()) / 86_400_000 - taper) / 7));
  const reachable = Math.max(weekly, 15) * Math.pow(1.1, weeks);
  return Math.max(Math.min(target, reachable), Math.min(weekly, target * 1.3));
}

/** Tranches de 20 km jusqu'au-delà du conseil et de ton volume actuel ; la dernière est « et plus » */
export function volumeBands(recommended: number, weekly: number): VolumeBand[] {
  const top = Math.min(160, Math.max(80, Math.ceil((Math.max(recommended, weekly) * 1.25) / 20) * 20));
  const out: VolumeBand[] = [];
  for (let min = 0; min < top; min += 20) out.push({ min, max: min + 20 });
  out.push({ min: top, max: null });
  return out;
}

export const bandOf = (bands: VolumeBand[], km: number) => bands.findIndex((b) => km >= b.min && (b.max === null || km < b.max));

/** Séances de course par semaine conseillées pour un volume au plus fort (km/semaine) */
export function recommendedSessions(peakKm: number): number {
  if (peakKm < 20) return 3;
  if (peakKm < 40) return 4;
  if (peakKm < 70) return 5;
  if (peakKm < 100) return 6;
  return 7;
}

/** Mode ambitieux conseillé : chrono visé à moins d'une chance sur deux */
export const ambitiousAdvised = (probability: number | null) => probability !== null && probability < 0.5;
