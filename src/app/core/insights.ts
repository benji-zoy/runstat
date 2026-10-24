import { Activity } from './models';
import { addDays, isoDay, parseDay, startOfDay, startOfWeek } from './stats';
import { haversineKm } from './equivalences';

const DAY_MS = 86_400_000;

export const paceOf = (a: Activity) => a.durationSec / a.distanceKm;

/** Heure locale de départ (0-23), ou null si inconnue */
export function startHour(a: Activity): number | null {
  return a.start ? new Date(a.start * 1000).getHours() : null;
}

/** 0 = lundi … 6 = dimanche */
export function weekday(a: Activity): number {
  return (parseDay(a.date).getDay() + 6) % 7;
}

export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

// ---------------------------------------------------------------------------
// Habitudes
// ---------------------------------------------------------------------------

/** Grille jour de la semaine × heure : nombre de sorties */
export function punchcard(acts: Activity[]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const a of acts) {
    const h = startHour(a);
    if (h !== null) grid[weekday(a)][h]++;
  }
  return grid;
}

export function weekdayStats(acts: Activity[]): { day: string; count: number; km: number }[] {
  const out = WEEKDAYS.map((day) => ({ day, count: 0, km: 0 }));
  for (const a of acts) {
    const w = out[weekday(a)];
    w.count++;
    w.km += a.distanceKm;
  }
  return out;
}

export const DAYTIMES = [
  { key: 'aube', label: 'Aube', icon: '🌅', range: '5 h – 8 h', from: 5, to: 8 },
  { key: 'matin', label: 'Matin', icon: '☀️', range: '8 h – 12 h', from: 8, to: 12 },
  { key: 'midi', label: 'Midi', icon: '🥪', range: '12 h – 14 h', from: 12, to: 14 },
  { key: 'aprem', label: 'Après-midi', icon: '🌤️', range: '14 h – 18 h', from: 14, to: 18 },
  { key: 'soir', label: 'Soirée', icon: '🌆', range: '18 h – 22 h', from: 18, to: 22 },
  { key: 'nuit', label: 'Nuit', icon: '🌙', range: '22 h – 5 h', from: 22, to: 29 },
];

export function daytimeStats(acts: Activity[]) {
  const out = DAYTIMES.map((d) => ({ ...d, count: 0, km: 0 }));
  for (const a of acts) {
    const h = startHour(a);
    if (h === null) continue;
    const hh = h < 5 ? h + 24 : h;
    const slot = out.find((d) => hh >= d.from && hh < d.to);
    if (slot) {
      slot.count++;
      slot.km += a.distanceKm;
    }
  }
  return out;
}

/** Histogramme générique : `edges` = bornes inférieures croissantes */
export function histogram(values: number[], edges: number[]): number[] {
  const counts = new Array(edges.length).fill(0);
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    if (v >= edges[0]) counts[i]++;
  }
  return counts;
}

export interface Place {
  lat: number;
  lon: number;
  count: number;
  km: number;
  first: string;
  last: string;
  names: string[];
}

/** Regroupe les points de départ à moins de `radiusKm` les uns des autres. */
export function startPlaces(acts: Activity[], radiusKm = 1): Place[] {
  const places: Place[] = [];
  for (const a of acts) {
    if (a.lat == null || a.lon == null) continue;
    const p = places.find((p) => haversineKm([p.lat, p.lon], [a.lat!, a.lon!]) < radiusKm);
    if (p) {
      p.count++;
      p.km += a.distanceKm;
      p.last = a.date;
      if (a.name && !p.names.includes(a.name) && p.names.length < 3) p.names.push(a.name);
    } else {
      places.push({ lat: a.lat, lon: a.lon, count: 1, km: a.distanceKm, first: a.date, last: a.date, names: a.name ? [a.name] : [] });
    }
  }
  return places.sort((a, b) => b.count - a.count);
}

/** Petit « profil type » façon récap annuel */
export function runnerProfile(acts: Activity[]): { title: string; traits: string[] } {
  if (!acts.length) return { title: 'Coureur en devenir', traits: [] };
  const dt = daytimeStats(acts).sort((a, b) => b.count - a.count)[0];
  const wd = weekdayStats(acts).sort((a, b) => b.count - a.count)[0];
  const trail = acts.filter((a) => a.kind === 'trail').length / acts.length;
  const avgKm = acts.reduce((s, a) => s + a.distanceKm, 0) / acts.length;
  const moment: Record<string, string> = {
    aube: 'lève-tôt',
    matin: 'du matin',
    midi: 'de la pause déj',
    aprem: "de l'après-midi",
    soir: 'du soir',
    nuit: 'noctambule',
  };
  const when: Record<string, string> = {
    aube: "à l'aube",
    matin: 'le matin',
    midi: 'à midi',
    aprem: "l'après-midi",
    soir: 'en soirée',
    nuit: 'la nuit',
  };
  const kind = trail > 0.25 ? 'Traileur' : avgKm >= 12 ? 'Coureur de fond' : 'Coureur';
  return {
    title: `${kind} ${moment[dt.key]}`,
    traits: [
      `${wd.day} est ton jour préféré (${wd.count} sorties)`,
      `${dt.icon} ${Math.round((dt.count / acts.length) * 100)} % de tes sorties partent ${when[dt.key]}`,
      `${avgKm.toFixed(1).replace('.', ',')} km par sortie en moyenne`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Régularité
// ---------------------------------------------------------------------------

/**
 * Nombre d'Eddington adapté à la course : le plus grand E tel qu'on a couru
 * au moins E km sur au moins E jours différents.
 */
export function eddington(acts: Activity[]): { e: number; nextNeeded: number } {
  const byDay = new Map<string, number>();
  for (const a of acts) byDay.set(a.date, (byDay.get(a.date) ?? 0) + a.distanceKm);
  const days = [...byDay.values()].sort((a, b) => b - a);
  let e = 0;
  while (e < days.length && days[e] >= e + 1) e++;
  const atLeastNext = days.filter((d) => d >= e + 1).length;
  return { e, nextNeeded: e + 1 - atLeastNext };
}

/** Séries de semaines (lundi → dimanche) avec au moins une sortie */
export function weekStreaks(acts: Activity[], today: Date): { longest: number; current: number } {
  const weeks = new Set(acts.map((a) => isoDay(startOfWeek(parseDay(a.date)))));
  const sorted = [...weeks].sort();
  let longest = 0, run = 0, prev: Date | null = null;
  for (const iso of sorted) {
    const d = parseDay(iso);
    run = prev && Math.round((d.getTime() - prev.getTime()) / DAY_MS) === 7 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  let cursor = startOfWeek(today);
  if (!weeks.has(isoDay(cursor))) cursor = addDays(cursor, -7);
  while (weeks.has(isoDay(cursor))) {
    current++;
    cursor = addDays(cursor, -7);
  }
  return { longest, current };
}

/** Nombre de jours avec au moins une sortie */
export function activeDays(acts: Activity[]): number {
  return new Set(acts.map((a) => a.date)).size;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecordCategory {
  key: string;
  icon: string;
  label: string;
  /** Plus grand = meilleur */
  score: (a: Activity) => number | null;
  format: (a: Activity) => string;
}

// ---------------------------------------------------------------------------
// Meilleurs efforts : meilleur temps sur une distance, n'importe où dans une sortie (façon Runalyze)
// ---------------------------------------------------------------------------

/** Distances suivies (clés des analyses FIT de scripts/build-fit.mjs) */
export const EFFORT_DISTANCES: { key: string; m: number; label: string }[] = [
  { key: '400', m: 400, label: '400 m' },
  { key: '800', m: 800, label: '800 m' },
  { key: '1000', m: 1000, label: '1 km' },
  { key: '1609', m: 1609, label: '1 mile' },
  { key: '3000', m: 3000, label: '3 km' },
  { key: '5000', m: 5000, label: '5 km' },
  { key: '10000', m: 10000, label: '10 km' },
  { key: '15000', m: 15000, label: '15 km' },
  { key: '21097', m: 21097.5, label: 'Semi' },
  { key: '30000', m: 30000, label: '30 km' },
  { key: '42195', m: 42195, label: 'Marathon' },
];

export interface Effort {
  time: number;
  /** segment : meilleur passage FIT dans une sortie plus longue ; sortie : la sortie entière (FIT) ;
   *  coros : meilleur km fourni par Coros ; moyenne : allure moyenne d'une sortie à peine plus longue (sans FIT) */
  source: 'segment' | 'sortie' | 'coros' | 'moyenne';
}

/** Meilleur temps sur `e` dans une sortie (hors tapis) : segment FIT, sinon meilleur km Coros ou allure moyenne */
export function effortIn(a: Activity, e: { key: string; m: number }): Effort | null {
  if (a.kind === 'indoor') return null;
  const dist = a.distanceKm * 1000;
  if (a.fit) {
    const t = a.fit.efforts[e.key];
    return t ? { time: t, source: dist > e.m * 1.05 ? 'segment' : 'sortie' } : null;
  }
  if (e.m === 1000 && a.bestKmSec) return { time: a.bestKmSec, source: 'coros' };
  // Sans FIT, seule une sortie de la distance (jusqu'à +5 %) donne un temps fiable : son allure moyenne
  if (e.m >= 3000 && dist >= e.m && dist <= e.m * 1.05) return { time: (a.durationSec * e.m) / dist, source: 'moyenne' };
  return null;
}

/** Les N meilleurs efforts sur une distance, une seule fois par sortie */
export function topEfforts(acts: Activity[], e: { key: string; m: number }, n: number): (Effort & { activity: Activity })[] {
  return acts
    .map((a) => ({ activity: a, effort: effortIn(a, e) }))
    .filter((x): x is { activity: Activity; effort: Effort } => x.effort !== null)
    .sort((x, y) => x.effort.time - y.effort.time)
    .slice(0, n)
    .map((x) => ({ ...x.effort, activity: x.activity }));
}

/** Les N meilleures sorties selon un score (null = non éligible) */
export function topN(acts: Activity[], score: (a: Activity) => number | null, n: number): Activity[] {
  return acts
    .map((a) => ({ a, s: score(a) }))
    .filter((x): x is { a: Activity; s: number } => x.s !== null && isFinite(x.s))
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.a);
}

// ---------------------------------------------------------------------------
// « Notables » façon Smashrun : la sortie est la meilleure depuis combien de temps ?
// ---------------------------------------------------------------------------

const WINDOWS: [number, string][] = [
  [Infinity, 'de tous les temps'],
  [365, "depuis 1 an"],
  [182, 'depuis 6 mois'],
  [91, 'depuis 3 mois'],
  [30, 'depuis 1 mois'],
];

const NOTABLE_METRICS: { label: string; score: (a: Activity) => number | null }[] = [
  { label: 'Plus longue sortie', score: (a) => a.distanceKm },
  { label: 'Plus long effort', score: (a) => a.durationSec },
  { label: 'Plus gros D+', score: (a) => a.elevGain ?? null },
  { label: 'Allure la plus rapide (≥ 3 km)', score: (a) => (a.distanceKm >= 3 && a.kind !== 'indoor' ? -paceOf(a) : null) },
  { label: 'Kilomètre le plus rapide', score: (a) => (a.bestKmSec ? -a.bestKmSec : null) },
  { label: 'Plus grosse charge', score: (a) => a.trainingLoad ?? null },
  { label: 'Cadence la plus élevée', score: (a) => a.cadence ?? null },
];

export function notables(target: Activity, acts: Activity[]): string[] {
  const t = parseDay(target.date).getTime();
  const before = acts.filter((a) => a !== target && parseDay(a.date).getTime() <= t);
  const out: string[] = [];
  for (const m of NOTABLE_METRICS) {
    const s = m.score(target);
    if (s === null) continue;
    for (const [days, label] of WINDOWS) {
      const from = t - days * DAY_MS;
      const beaten = before.some((a) => parseDay(a.date).getTime() >= from && (m.score(a) ?? -Infinity) >= s);
      if (!beaten && before.some((a) => parseDay(a.date).getTime() < t - 20 * DAY_MS)) {
        out.push(`${m.label} ${label}`);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection & forme
// ---------------------------------------------------------------------------

/** Projection de fin d'année : rythme de l'année en cours, pondéré par les 30 derniers jours. */
export function yearProjection(acts: Activity[], today: Date): { projected: number; done: number; daysLeft: number } {
  const y = today.getFullYear();
  const yearStart = new Date(y, 0, 1);
  const yearEnd = new Date(y + 1, 0, 1);
  const t = startOfDay(today);
  const elapsed = Math.max(1, Math.round((t.getTime() - yearStart.getTime()) / DAY_MS) + 1);
  const daysLeft = Math.round((yearEnd.getTime() - t.getTime()) / DAY_MS) - 1;
  const yearActs = acts.filter((a) => a.date.startsWith(String(y)));
  const done = yearActs.reduce((s, a) => s + a.distanceKm, 0);
  const last30 = acts.filter((a) => parseDay(a.date) > addDays(t, -30)).reduce((s, a) => s + a.distanceKm, 0) / 30;
  const rate = 0.5 * (done / elapsed) + 0.5 * last30;
  return { projected: done + rate * daysLeft, done, daysLeft };
}

export interface PmcDay {
  date: Date;
  load: number;
  /** Forme de fond (moyenne exponentielle 42 j) */
  ctl: number;
  /** Fatigue (moyenne exponentielle 7 j) */
  atl: number;
  /** Fraîcheur = forme − fatigue (de la veille) */
  tsb: number;
}

/** Courbe forme / fatigue / fraîcheur (modèle de Banister) à partir de la charge de chaque sortie. */
export function pmc(acts: Activity[], today: Date): PmcDay[] {
  if (!acts.length) return [];
  const loads = new Map<string, number>();
  for (const a of acts) loads.set(a.date, (loads.get(a.date) ?? 0) + (a.trainingLoad ?? 0));
  const out: PmcDay[] = [];
  let ctl = 0, atl = 0;
  const kCtl = 1 - Math.exp(-1 / 42);
  const kAtl = 1 - Math.exp(-1 / 7);
  for (let d = parseDay(acts[0].date); d <= today; d = addDays(d, 1)) {
    const load = loads.get(isoDay(d)) ?? 0;
    const tsb = ctl - atl;
    ctl += (load - ctl) * kCtl;
    atl += (load - atl) * kAtl;
    out.push({ date: d, load, ctl, atl, tsb });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Premières fois & jalons
// ---------------------------------------------------------------------------

export interface Milestone {
  date: string;
  icon: string;
  label: string;
}

export function milestones(acts: Activity[]): Milestone[] {
  const out: Milestone[] = [];
  if (!acts.length) return out;
  out.push({ date: acts[0].date, icon: '🎬', label: 'Première sortie enregistrée' });

  const firstOver = (km: number, icon: string, label: string) => {
    const a = acts.find((x) => x.distanceKm >= km);
    if (a) out.push({ date: a.date, icon, label });
  };
  firstOver(10, '🔟', 'Premier 10 km');
  firstOver(21.0975, '🥈', 'Premier semi-marathon (distance)');
  firstOver(30, '💪', 'Première sortie de 30 km');
  firstOver(42.195, '🏅', 'Premier marathon (distance)');

  const firstTrail = acts.find((a) => a.kind === 'trail');
  if (firstTrail) out.push({ date: firstTrail.date, icon: '⛰️', label: 'Premier trail' });

  let km = 0;
  const kmSteps = [100, 500, 1000, 2000, 3000, 4000, 5000, 7500, 10000];
  let i = 0;
  let count = 0;
  const countSteps = [100, 250, 500, 750, 1000];
  let j = 0;
  let elev = 0;
  let everest = 1;
  for (const a of acts) {
    km += a.distanceKm;
    count++;
    elev += a.elevGain ?? 0;
    while (i < kmSteps.length && km >= kmSteps[i]) {
      out.push({ date: a.date, icon: '📏', label: `${kmSteps[i].toLocaleString('fr-FR')} km au compteur` });
      i++;
    }
    while (j < countSteps.length && count >= countSteps[j]) {
      out.push({ date: a.date, icon: '🔢', label: `${countSteps[j]}e sortie` });
      j++;
    }
    while (elev >= everest * 8849) {
      out.push({ date: a.date, icon: '🏔️', label: everest === 1 ? 'Un Everest de D+ cumulé' : `${everest} Everest de D+ cumulés` });
      everest++;
    }
  }

  const months = new Map<string, number>();
  for (const a of acts) {
    const m = a.date.slice(0, 7);
    const before = months.get(m) ?? 0;
    const after = before + a.distanceKm;
    months.set(m, after);
    if (before < 100 && after >= 100 && !out.some((o) => o.label === 'Premier mois à 100 km')) {
      out.push({ date: a.date, icon: '📆', label: 'Premier mois à 100 km' });
    }
    if (before < 200 && after >= 200 && !out.some((o) => o.label === 'Premier mois à 200 km')) {
      out.push({ date: a.date, icon: '📆', label: 'Premier mois à 200 km' });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface Freshness {
  tone: 'good' | 'neutral' | 'warning' | 'critical';
  label: string;
  text: string;
}

/** Lecture de la fraîcheur (forme − fatigue), avec les seuils usuels du modèle de Banister */
export function freshnessState(tsb: number): Freshness {
  if (tsb > 15) return { tone: 'warning', label: 'Désentraînement', text: 'Très reposé : la forme commence à baisser.' };
  if (tsb > 5) return { tone: 'good', label: 'Frais', text: 'Idéal pour une course ou un test.' };
  if (tsb > -10) return { tone: 'neutral', label: 'Neutre', text: 'Équilibre entre charge et récupération.' };
  if (tsb > -30) return { tone: 'good', label: 'Productif', text: "Fatigue d'entraînement qui fait progresser." };
  return { tone: 'critical', label: 'Surcharge', text: 'Fatigue élevée : pense à récupérer.' };
}
