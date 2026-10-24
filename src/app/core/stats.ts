import { Activity, Period, Summary } from './models';

const DAY_MS = 86_400_000;

/** "2026-10-06" -> Date locale à minuit */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Lundi de la semaine de d */
export function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7;
  return addDays(startOfDay(d), -day);
}

/** Même jour le mois/l'an d'avant, borné à la fin du mois (31 mars -> 28/29 février). */
function shiftMonths(d: Date, months: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

export function inRange(acts: Activity[], start: Date, end: Date): Activity[] {
  const s = isoDay(start);
  const e = isoDay(end);
  return acts.filter((a) => a.date >= s && a.date < e);
}

export function summarize(acts: Activity[]): Summary {
  let km = 0, sec = 0, elev = 0, elevKnown = 0, calories = 0, steps = 0, hrSec = 0, hrWeighted = 0;
  for (const a of acts) {
    km += a.distanceKm;
    sec += a.durationSec;
    calories += a.calories ?? 0;
    if (a.elevGain != null) {
      elev += a.elevGain;
      elevKnown++;
    }
    if (a.cadence) steps += (a.cadence * a.durationSec) / 60;
    if (a.avgHr) {
      hrSec += a.durationSec;
      hrWeighted += a.avgHr * a.durationSec;
    }
  }
  return {
    count: acts.length,
    km,
    sec,
    elev,
    elevKnown,
    calories,
    steps,
    avgPaceSec: km > 0 ? sec / km : null,
    avgHr: hrSec > 0 ? hrWeighted / hrSec : null,
  };
}

export type Granularity = 'week' | 'month' | 'year' | 'all';

const dShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dLong = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const mLong = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

/** Début de la période de granularité `g` contenant `d`. */
export function periodStart(g: Granularity, d: Date): Date {
  if (g === 'week') return startOfWeek(d);
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  return new Date(d.getFullYear(), 0, 1);
}

/** Décale une date d'ancrage de `n` périodes. */
export function shiftPeriod(g: Granularity, d: Date, n: number): Date {
  if (g === 'week') return addDays(startOfWeek(d), 7 * n);
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(d.getFullYear() + n, 0, 1);
}

/**
 * La période de granularité `g` contenant `anchor`. Une période en cours s'arrête à aujourd'hui
 * et se compare à la même portion de la période précédente ; une période passée se compare
 * à la précédente entière.
 */
export function periodFor(g: Granularity, anchor: Date, today: Date, first: Date): Period {
  const end = addDays(startOfDay(today), 1);
  if (g === 'all') {
    return {
      key: 'all',
      gran: 'all',
      label: `Depuis ${mLong.format(first)}`,
      phrase: `depuis ${mLong.format(first)}`,
      start: startOfDay(first),
      end,
      current: true,
      prev: null,
    };
  }
  const start = periodStart(g, anchor);
  const fullEnd = shiftPeriod(g, start, 1);
  // En cours si aujourd'hui est dans [start, fullEnd) ; le dernier jour compte encore
  const current = start < end && fullEnd >= end;
  const prevStart = shiftPeriod(g, start, -1);
  const lastDay = addDays(fullEnd, -1);

  let label: string;
  let phrase: string;
  let prevLabel: string;
  if (g === 'week') {
    label = `Semaine du ${dShort.format(start)} au ${dLong.format(lastDay)}`;
    phrase = current ? 'cette semaine' : `la semaine du ${dShort.format(start)} au ${dShort.format(lastDay)}`;
    prevLabel = current ? 'la semaine dernière à la même date' : 'la semaine précédente';
  } else if (g === 'month') {
    label = mLong.format(start).replace(/^./, (c) => c.toUpperCase());
    phrase = current ? 'depuis le début du mois' : `en ${mLong.format(start)}`;
    prevLabel = current ? 'le mois dernier à la même date' : mLong.format(prevStart);
  } else {
    label = String(start.getFullYear());
    phrase = current ? "depuis le début de l'année" : `en ${start.getFullYear()}`;
    prevLabel = current ? `${start.getFullYear() - 1} à la même date` : String(start.getFullYear() - 1);
  }

  const months = g === 'week' ? 0 : g === 'month' ? 1 : 12;
  const prevEnd = current ? (g === 'week' ? addDays(end, -7) : shiftMonths(end, -months)) : start;
  return {
    key: `${g}-${isoDay(start)}`,
    gran: g,
    label,
    phrase,
    start,
    end: current ? end : fullEnd,
    current,
    prev: prevStart >= periodStart(g, first) ? { start: prevStart, end: prevEnd, label: prevLabel } : null,
  };
}

export interface Bucket {
  start: Date;
  km: number;
  sec: number;
  count: number;
  load: number;
  loadKnown: number;
}

/** Volume par semaine (lundi -> dimanche) sur les `weeks` dernières semaines. */
export function weekly(acts: Activity[], today: Date, weeks: number): Bucket[] {
  const first = addDays(startOfWeek(today), -7 * (weeks - 1));
  const buckets: Bucket[] = Array.from({ length: weeks }, (_, i) => ({
    start: addDays(first, 7 * i),
    km: 0,
    sec: 0,
    count: 0,
    load: 0,
    loadKnown: 0,
  }));
  for (const a of acts) {
    // Arrondi en jours d'abord : les changements d'heure font varier un jour de ±1 h
    const i = Math.floor(Math.round((parseDay(a.date).getTime() - first.getTime()) / DAY_MS) / 7);
    if (i < 0 || i >= weeks) continue;
    const b = buckets[i];
    b.km += a.distanceKm;
    b.sec += a.durationSec;
    b.count++;
    if (a.trainingLoad != null) {
      b.load += a.trainingLoad;
      b.loadKnown++;
    }
  }
  return buckets;
}

/** Volume par mois calendaire sur les `months` derniers mois. */
export function monthly(acts: Activity[], today: Date, months: number): (Bucket & { hrSec: number; hrSum: number })[] {
  const first = new Date(today.getFullYear(), today.getMonth() - months + 1, 1);
  const buckets = Array.from({ length: months }, (_, i) => ({
    start: new Date(first.getFullYear(), first.getMonth() + i, 1),
    km: 0,
    sec: 0,
    count: 0,
    load: 0,
    loadKnown: 0,
    hrSec: 0,
    hrSum: 0,
  }));
  for (const a of acts) {
    const d = parseDay(a.date);
    const i = (d.getFullYear() - first.getFullYear()) * 12 + d.getMonth() - first.getMonth();
    if (i < 0 || i >= months) continue;
    const b = buckets[i];
    b.km += a.distanceKm;
    b.sec += a.durationSec;
    b.count++;
    if (a.avgHr) {
      b.hrSec += a.durationSec;
      b.hrSum += a.avgHr * a.durationSec;
    }
  }
  return buckets;
}

/** Position d'un jour dans une année bissextile (0 = 1er janvier, 365 = 31 décembre), pour aligner les années. */
function leapIndex(d: Date): number {
  return Math.round((new Date(2024, d.getMonth(), d.getDate()).getTime() - new Date(2024, 0, 1).getTime()) / DAY_MS);
}

/**
 * Kilomètres cumulés jour par jour pour chaque année, alignés sur un calendrier bissextile
 * (index 0 = 1er janvier). La série est vide avant la première sortie enregistrée et,
 * pour l'année en cours, après aujourd'hui.
 */
export function cumulativeByYear(acts: Activity[], today: Date): { year: number; values: (number | null)[] }[] {
  if (!acts.length) return [];
  const firstDay = parseDay(acts.reduce((min, a) => (a.date < min ? a.date : min), acts[0].date));
  const years = [...new Set(acts.map((a) => Number(a.date.slice(0, 4))))].sort();
  return years.map((year) => {
    const daily = new Array(366).fill(0);
    for (const a of acts) {
      if (a.date.startsWith(String(year))) daily[leapIndex(parseDay(a.date))] += a.distanceKm;
    }
    const from = year === firstDay.getFullYear() ? leapIndex(firstDay) : 0;
    const to = year === today.getFullYear() ? leapIndex(today) : 365;
    let total = 0;
    const values = daily.map((km, i) => (i < from || i > to ? null : (total += km)));
    return { year, values };
  });
}

/** Km par jour sur les `weeks` dernières semaines, en colonnes lundi -> dimanche. */
export function dailyGrid(acts: Activity[], today: Date, weeks: number): { date: Date; km: number; future: boolean }[][] {
  const first = addDays(startOfWeek(today), -7 * (weeks - 1));
  const byDay = new Map<string, number>();
  for (const a of acts) byDay.set(a.date, (byDay.get(a.date) ?? 0) + a.distanceKm);
  const t = startOfDay(today).getTime();
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(first, w * 7 + d);
      return { date, km: byDay.get(isoDay(date)) ?? 0, future: date.getTime() > t };
    }),
  );
}

/** Plus longue série de jours consécutifs avec au moins une sortie, et série en cours. */
export function streaks(acts: Activity[], today: Date): { longest: number; longestEnd: Date | null; current: number } {
  const days = [...new Set(acts.map((a) => a.date))].sort();
  let longest = 0, run = 0, longestEnd: Date | null = null;
  let prev: Date | null = null;
  for (const iso of days) {
    const d = parseDay(iso);
    run = prev && Math.round((d.getTime() - prev.getTime()) / DAY_MS) === 1 ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = d;
    }
    prev = d;
  }
  // La série en cours tolère qu'on n'ait pas encore couru aujourd'hui.
  const set = new Set(days);
  let current = 0;
  let cursor = startOfDay(today);
  if (!set.has(isoDay(cursor))) cursor = addDays(cursor, -1);
  while (set.has(isoDay(cursor))) {
    current++;
    cursor = addDays(cursor, -1);
  }
  return { longest, longestEnd, current };
}

export interface RecordItem {
  label: string;
  value: string;
  detail: string;
  activity?: Activity;
}

/** Meilleure allure moyenne parmi les sorties d'au moins `minKm`. */
export function fastestOver(acts: Activity[], minKm: number): Activity | null {
  let best: Activity | null = null;
  for (const a of acts) {
    if (a.distanceKm < minKm || a.kind === 'indoor') continue;
    if (!best || a.durationSec / a.distanceKm < best.durationSec / best.distanceKm) best = a;
  }
  return best;
}

export function maxBy<T>(items: T[], score: (t: T) => number | null | undefined): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s != null && s > bestScore) {
      best = it;
      bestScore = s;
    }
  }
  return best;
}

export interface PeriodBucket {
  label: string;
  /** Libellé long pour l'infobulle */
  title: string;
  start: Date;
  /** Granularité vers laquelle on descend au clic (null = pas de détail) */
  drill: Granularity | null;
  km: number;
  sec: number;
  count: number;
  elev: number;
}

const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const DAYS_SHORT = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const dayTitle = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Découpage d'une période en sous-périodes : années, mois ou jours. */
export function periodBuckets(acts: Activity[], p: Period, firstDay: Date): PeriodBucket[] {
  const make = (start: Date, label: string, title: string, drill: Granularity | null): PeriodBucket => ({
    label, title, start, drill, km: 0, sec: 0, count: 0, elev: 0,
  });
  let buckets: PeriodBucket[];
  let index: (a: Activity) => number;

  if (p.gran === 'all') {
    const y0 = firstDay.getFullYear();
    const n = p.end.getFullYear() - y0 + (p.end.getMonth() === 0 && p.end.getDate() === 1 ? 0 : 1);
    buckets = Array.from({ length: Math.max(1, n) }, (_, i) => make(new Date(y0 + i, 0, 1), String(y0 + i), String(y0 + i), 'year'));
    index = (a) => Number(a.date.slice(0, 4)) - y0;
  } else if (p.gran === 'year') {
    const y = p.start.getFullYear();
    buckets = MONTHS_SHORT.map((m, i) => {
      const d = new Date(y, i, 1);
      return make(d, m, new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(d), 'month');
    });
    index = (a) => Number(a.date.slice(5, 7)) - 1;
  } else {
    const days = p.gran === 'week' ? 7 : new Date(p.start.getFullYear(), p.start.getMonth() + 1, 0).getDate();
    buckets = Array.from({ length: days }, (_, i) => {
      const d = addDays(p.start, i);
      const label = p.gran === 'week' ? `${DAYS_SHORT[i]} ${d.getDate()}` : String(d.getDate());
      return make(d, label, dayTitle.format(d), p.gran === 'month' ? 'week' : null);
    });
    index = (a) => Math.round((parseDay(a.date).getTime() - p.start.getTime()) / DAY_MS);
  }
  for (const a of inRange(acts, buckets[0].start, p.gran === 'all' ? p.end : shiftPeriod(p.gran, p.start, 1))) {
    const b = buckets[index(a)];
    if (!b) continue;
    b.km += a.distanceKm;
    b.sec += a.durationSec;
    b.count++;
    b.elev += a.elevGain ?? 0;
  }
  return buckets;
}
