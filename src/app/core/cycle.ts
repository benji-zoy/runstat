import { Activity, Cycle, CycleFocus, Goal } from './models';
import { LoadRates, cycleLastDay, cycleRelay, cycleSessions, toPlanned } from './plan';
import { SessionType, acwr, efficiency, isComparableEasy, references } from './science';
import { addDays, isoDay, parseDay, startOfWeek } from './stats';

/**
 * Cycles d'entraînement sans course (cycles.json) : un but, 4 à 16 semaines (comme un plan COROS), un test chronométré
 * facultatif la dernière semaine (objectif `cycle`), un suivi (séances faites, volume, charge, EF, VDOT) et un bilan.
 */

export interface FocusInfo {
  label: string;
  /** Ce que le but veut dire, en une ligne */
  hint: string;
  /** Durée conseillée (semaines) */
  weeks: number;
  /** Test de fin conseillé (km), null : sans test */
  testKm: number | null;
  /** Consigne donnée à l'IA */
  prompt: string;
}

export const FOCUS: Record<CycleFocus, FocusInfo> = {
  restart: {
    label: 'Reprendre',
    hint: 'Après une coupure ou une blessure : repartir doucement',
    weeks: 6,
    testKm: 5,
    prompt: 'But : reprendre après une coupure ou une blessure. Commence nettement sous mon volume habituel, augmente lentement, pas de séance de qualité les deux premières semaines, puis seulement des accélérations courtes ; surveille les gênes signalées.',
  },
  endurance: {
    label: 'Endurance',
    hint: 'Construire le foncier : plus de volume, surtout facile',
    weeks: 8,
    testKm: 10,
    prompt: 'But : construire l’endurance. Surtout du volume facile, une sortie longue qui s’allonge, +10 % par semaine au plus, une semaine plus légère toutes les 3 ou 4 ; une seule séance de qualité légère (tempo, côtes courtes).',
  },
  speed: {
    label: 'Vitesse',
    hint: 'Progresser sur 5 à 10 km : VMA et seuil',
    weeks: 8,
    testKm: 5,
    prompt: 'But : gagner en vitesse sur 5 à 10 km. Volume stable, deux séances de qualité par semaine (VMA, seuil), lignes droites, récupération soignée ; termine par un affûtage court avant le test.',
  },
  maintain: {
    label: 'Entretenir',
    hint: 'Intersaison : garder la forme sans s’user',
    weeks: 6,
    testKm: null,
    prompt: 'But : entretenir la forme pendant l’intersaison. Volume stable ou légèrement réduit, une séance de qualité légère par semaine, de la variété (terrain, fartlek), pas de bloc dur.',
  },
  trail: {
    label: 'Trail',
    hint: 'Se mettre au trail : dénivelé, côtes, terrain',
    weeks: 8,
    testKm: null,
    prompt: 'But : se mettre au trail. Du dénivelé progressif, des côtes (montées à pied et en courant), des descentes techniques prudentes, des sorties longues en nature au temps plutôt qu’à la distance, et du renforcement des chevilles et des quadriceps.',
  },
};

export const FOCUS_ORDER: CycleFocus[] = ['restart', 'endurance', 'speed', 'maintain', 'trail'];
export const TEST_DISTANCES = [3, 5, 10];

/** Test de fin de cycle (objectif rattaché par `cycle`) */
export const cycleTest = (c: Cycle, goals: Goal[]) => goals.find((g) => g.cycle === c.id) ?? null;

export type CycleStatus = 'upcoming' | 'active' | 'done';

export interface CycleState {
  status: CycleStatus;
  /** Dernier jour effectif : la veille du relais d'une course, sinon le dernier jour prévu */
  end: string;
  relay: { date: string; goal: Goal } | null;
  /** Semaine en cours (1…weeks), null hors du cycle */
  week: number | null;
}

export function cycleState(c: Cycle, goals: Goal[], today: Date): CycleState {
  const relay = cycleRelay(c, goals);
  const end = relay ? isoDay(addDays(parseDay(relay.date), -1)) : cycleLastDay(c);
  const t = isoDay(today);
  const status: CycleStatus = t < c.start ? 'upcoming' : t > end ? 'done' : 'active';
  const week = status === 'active' ? Math.floor((today.getTime() - parseDay(c.start).getTime()) / (7 * 86_400_000)) + 1 : null;
  return { status, end, relay, week };
}

export interface CycleWeek {
  start: string;
  plannedCount: number;
  plannedKm: number;
  doneCount: number;
  doneKm: number;
  /** Séances prévues de cette semaine faites (une sortie le même jour) */
  matched: number;
  /** Semaine à venir (pas encore jugée) */
  future: boolean;
}

export interface CycleTracking {
  weeks: CycleWeek[];
  /** Séances de course prévues jusqu'à hier, et faites (sortie le même jour) */
  plannedToDate: number;
  doneToDate: number;
  plannedKmToDate: number;
  doneKmToDate: number;
  /** Ratio charge aiguë / chronique aujourd'hui (ou à la fin du cycle) */
  acwr: number | null;
  /** EF (m/min par battement) des sorties faciles comparables : 4 semaines avant le cycle, puis les 4 dernières */
  ef: { before: number | null; now: number | null };
  /** VDOT de ta meilleure référence au début et maintenant */
  vdot: { before: number | null; now: number | null };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Suivi d'un cycle : prévu face à fait, semaine par semaine, charge, efficacité et niveau */
export function cycleTracking(c: Cycle, goals: Goal[], acts: Activity[], types: Map<string, SessionType>, rates: LoadRates, today: Date): CycleTracking {
  const { end } = cycleState(c, goals, today);
  const yesterday = isoDay(addDays(today, -1));
  const stop = end < yesterday ? end : yesterday;
  const sessions = cycleSessions(c, goals).filter((s) => s.kind !== 'strength' && s.date <= end);
  const runs = acts.filter((a) => a.date >= c.start && a.date <= end);
  const runDays = new Set(runs.map((a) => a.date));
  const weeks: CycleWeek[] = [];
  for (let w = startOfWeek(parseDay(c.start)); isoDay(w) <= end; w = addDays(w, 7)) {
    const from = isoDay(w);
    const to = isoDay(addDays(w, 6));
    const planned = sessions.filter((s) => s.date >= from && s.date <= to);
    const done = runs.filter((a) => a.date >= from && a.date <= to);
    weeks.push({
      start: from,
      plannedCount: planned.length,
      plannedKm: planned.reduce((sum, s) => sum + (toPlanned(s, rates).distanceKm ?? 0), 0),
      doneCount: done.length,
      doneKm: done.reduce((sum, a) => sum + a.distanceKm, 0),
      matched: planned.filter((s) => s.date <= stop && runDays.has(s.date)).length,
      future: from > isoDay(today),
    });
  }
  const past = sessions.filter((s) => s.date <= stop);
  const kmOf = (list: typeof sessions) => list.reduce((sum, s) => sum + (toPlanned(s, rates).distanceKm ?? 0), 0);

  // Charge : ratio aigu / chronique au dernier jour jugé
  const ref = parseDay(stop < c.start ? isoDay(today) : stop);
  const daily: number[] = [];
  const loads = new Map<string, number>();
  for (const a of acts) loads.set(a.date, (loads.get(a.date) ?? 0) + (a.trainingLoad ?? 0));
  for (let d = addDays(ref, -90); d <= ref; d = addDays(d, 1)) daily.push(loads.get(isoDay(d)) ?? 0);
  const ratio = daily.some((x) => x > 0) ? acwr(daily).at(-1)! : null;

  const efIn = (from: Date, to: Date) =>
    median(
      acts
        .filter((a) => a.date >= isoDay(from) && a.date <= isoDay(to) && isComparableEasy(a, types.get(a.id)))
        .map((a) => efficiency(a))
        .filter((x): x is number => x !== null),
    );
  const start = parseDay(c.start);
  const vdotAt = (d: Date) => references(acts.filter((a) => parseDay(a.date) <= d), types, d)[0]?.vdot ?? null;

  return {
    weeks,
    plannedToDate: past.length,
    doneToDate: past.filter((s) => runDays.has(s.date)).length,
    plannedKmToDate: kmOf(past),
    doneKmToDate: runs.filter((a) => a.date <= stop).reduce((sum, a) => sum + a.distanceKm, 0),
    acwr: ratio,
    ef: { before: efIn(addDays(start, -28), addDays(start, -1)), now: efIn(addDays(ref, -27), ref) },
    vdot: { before: vdotAt(addDays(start, -1)), now: vdotAt(ref) },
  };
}

/** Cycle en cours (ou à venir le plus proche) ; null s'il n'y en a pas */
export function currentCycle(cycles: Cycle[], goals: Goal[], today: Date): Cycle | null {
  const live = cycles
    .map((c) => ({ c, s: cycleState(c, goals, today) }))
    .filter((x) => x.s.status !== 'done')
    .sort((a, b) => a.c.start.localeCompare(b.c.start));
  return live.find((x) => x.s.status === 'active')?.c ?? live[0]?.c ?? null;
}

/** « Cycle Endurance · nov. 2026 » */
export function cycleName(focus: CycleFocus, start: string): string {
  const month = parseDay(start).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
  return `Cycle ${FOCUS[focus].label} · ${month}`;
}

/** Lundi qui suit (ou aujourd'hui si c'est lundi) : début conseillé d'un cycle */
export function nextMonday(today: Date): string {
  const d = (8 - today.getDay()) % 7;
  return isoDay(addDays(today, d));
}

/** Identifiant libre : cycle-<but>-<AAAA-MM-JJ>[-n] */
export function cycleId(focus: CycleFocus, start: string, taken: string[]): string {
  const base = `cycle-${focus}-${start}`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * Volume conseillé au plus fort d'un cycle, selon le but : reprise sous ton volume actuel, endurance +10 % par semaine
 * (une sur quatre allégée, 1,5 × au plus), vitesse, entretien et trail au volume actuel.
 */
export function cycleVolume(focus: CycleFocus, weekly: number, weeks: number): number {
  const base = Math.max(weekly, 10);
  if (focus === 'restart') return Math.max(10, weekly * 0.8);
  if (focus === 'endurance') return Math.min(base * 1.5, base * Math.pow(1.1, Math.ceil(weeks * 0.75) - 1));
  return base;
}
