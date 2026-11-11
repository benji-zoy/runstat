/** Âge des données et verdicts « du jour » : une donnée ancienne ne doit pas passer pour actuelle. */

/** Au-delà de ce nombre de jours, une donnée « du jour » est atténuée et ne donne plus de conseil */
export const STALE_DAYS = 3;

const DAY_MS = 86_400_000;
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

export interface DataAge {
  /** Jours entiers entre la donnée et aujourd'hui (0 = aujourd'hui, jamais négatif) */
  days: number;
  /** Plus de STALE_DAYS jours : à atténuer, pas de conseil du jour */
  stale: boolean;
  /** « au 24 oct. » quand la donnée n'est ni d'aujourd'hui ni d'hier, sinon null */
  label: string | null;
}

/** Jours calendaires entre deux dates (heure locale ignorée) */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

export function dataAge(date: Date | null | undefined, today: Date): DataAge | null {
  if (!date) return null;
  const days = daysBetween(date, today);
  return { days, stale: days > STALE_DAYS, label: days > 1 ? `au ${shortFmt.format(date)}` : null };
}

export interface DayVerdictInput {
  /** Âge de la donnée qui porte le verdict (santé, sinon instantané) ; null = inconnu */
  age: DataAge | null;
  freshLabel: string;
  freshTone: 'good' | 'neutral' | 'warning' | 'critical';
  freshText: string;
  hrvTone?: string;
  rhrTone?: string;
  /** Préparation du jour (0-100) */
  readiness?: number | null;
  /** Fragments déjà formatés (« fraîcheur +20 (désentraînement) », « VFC basse »…) */
  parts: string[];
}

export interface DayVerdict {
  title: string;
  line: string;
  stale: boolean;
}

/** Préparation en dessous de laquelle on ne parle pas de « séance normale » */
export const LOW_READINESS = 50;

/**
 * Verdict du jour. Aucune phrase rassurante si un signal la contredit (VFC, FC de repos, surcharge, préparation basse,
 * désentraînement) ; aucun conseil si les données ont plus de STALE_DAYS jours.
 */
export function dayVerdict(i: DayVerdictInput): DayVerdict | null {
  if (!i.parts.length) return null;
  const summary = capitalize(i.parts.join(', '));
  if (i.age?.stale) {
    return {
      title: `Dernières données ${i.age.label ?? ''} : synchronise pour un conseil du jour`.replace('  ', ' '),
      line: `${summary}.`,
      stale: true,
    };
  }
  const bad = (t?: string) => t !== undefined && t !== 'good' && t !== 'neutral';
  const lowReady = typeof i.readiness === 'number' && i.readiness < LOW_READINESS;
  if (bad(i.hrvTone) || (i.rhrTone !== undefined && i.rhrTone !== 'good') || i.freshTone === 'critical' || lowReady) {
    return { title: 'Journée à prendre en douceur', line: `${summary}. Privilégie une sortie facile ou le repos.`, stale: false };
  }
  if (i.freshLabel === 'Désentraînement') {
    return { title: 'Tu as levé le pied : reprends progressivement', line: `${summary}. ${i.freshText}`, stale: false };
  }
  return {
    title: i.freshLabel === 'Frais' ? 'Tu es frais' : 'Rien ne s’oppose à une séance normale',
    line: `${summary}. ${i.freshText}`,
    stale: false,
  };
}

export interface AcwrReading {
  /** Ratio à aujourd'hui */
  ratio: number;
  /** Ratio au dernier jour de données (avant l'arrêt), pour comparer avec la source */
  atLastData: number;
  /** Jours sans charge depuis la dernière donnée */
  idleDays: number;
  /** Charge aiguë quasi nulle parce que les données s'arrêtent : le ratio ne mesure plus que l'arrêt */
  stale: boolean;
}

/**
 * Lecture du ratio aigu / chronique à partir de ses valeurs quotidiennes (`ratios`, la dernière = aujourd'hui) et de
 * la charge quotidienne. On garde le ratio du jour, mais on le déclare « ancien » dès que plus de STALE_DAYS jours
 * sans charge ont fait fondre la charge aiguë : il vaut alors 0,01 sans que ce soit un état d'entraînement.
 */
export function acwrReading(ratios: number[], daily: number[]): AcwrReading | null {
  if (!ratios.length) return null;
  let last = daily.length - 1;
  while (last >= 0 && !(daily[last] > 0)) last--;
  if (last < 0) return null;
  const idleDays = daily.length - 1 - last;
  return { ratio: ratios.at(-1)!, atLastData: ratios[last] ?? 0, idleDays, stale: idleDays > STALE_DAYS };
}

/**
 * Variation de l'indice entre les deux points d'une fenêtre : mêmes valeurs que celles affichées, arrondies avant la
 * soustraction (sinon « ±0 pts » à côté de « 38 → 32 »).
 */
export function indexTrend(indexes: number[], weeks: number): { from: number; to: number; diff: number; weeks: number } | null {
  if (indexes.length < weeks + 1) return null;
  const from = Math.round(indexes[indexes.length - 1 - weeks]);
  const to = Math.round(indexes.at(-1)!);
  return { from, to, diff: to - from, weeks };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
