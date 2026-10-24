import { Activity } from './models';
import { addDays, isoDay, parseDay, startOfWeek } from './stats';
import { eddington, startHour, startPlaces } from './insights';
import { C } from '../ui/palette';

// ---------------------------------------------------------------------------
// Niveaux par distance cumulée (inspirés des niveaux Nike Run Club)
// ---------------------------------------------------------------------------

export interface Level {
  name: string;
  min: number;
  color: string;
}

export const LEVELS: Level[] = [
  { name: 'Jaune', min: 0, color: '#f5d300' },
  { name: 'Orange', min: 50, color: '#ff8a00' },
  { name: 'Vert', min: 250, color: '#2fbf4a' },
  { name: 'Bleu', min: 1000, color: C.s1 },
  { name: 'Violet', min: 2500, color: '#9b6bff' },
  { name: 'Noir', min: 5000, color: '#f2f2f2' },
  { name: 'Volt', min: 15000, color: '#d4ff3a' },
];

export function levelFor(km: number): { level: Level; next: Level | null; progress: number } {
  let i = 0;
  while (i + 1 < LEVELS.length && km >= LEVELS[i + 1].min) i++;
  const level = LEVELS[i];
  const next = LEVELS[i + 1] ?? null;
  const progress = next ? (km - level.min) / (next.min - level.min) : 1;
  return { level, next, progress };
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export interface BadgeResult {
  /** Date (YYYY-MM-DD) à laquelle le badge a été obtenu */
  earned: string | null;
  /** Nombre de fois obtenu (badges répétables) */
  times?: number;
  /** Avancement 0..1 si pas encore obtenu */
  progress: number;
  /** Texte d'avancement : « 7 / 10 sorties » */
  hint: string;
}

export interface Badge {
  id: string;
  family: string;
  icon: string;
  name: string;
  description: string;
  eval: (acts: Activity[]) => BadgeResult;
}

/** Badge obtenu quand une valeur cumulée atteint un seuil (sorties triées par date) */
function cumulative(target: number, value: (a: Activity) => number, unit: (n: number) => string) {
  return (acts: Activity[]): BadgeResult => {
    let total = 0;
    for (const a of acts) {
      total += value(a);
      if (total >= target) return { earned: a.date, progress: 1, hint: '' };
    }
    return { earned: null, progress: total / target, hint: `${unit(total)} / ${unit(target)}` };
  };
}

/** Badge obtenu à la N-ième sortie qui satisfait un critère */
function countOf(target: number, pred: (a: Activity) => boolean, noun = 'sorties') {
  return (acts: Activity[]): BadgeResult => {
    let n = 0;
    for (const a of acts) {
      if (pred(a) && ++n >= target) return { earned: a.date, progress: 1, hint: '', times: Math.floor(acts.filter(pred).length / target) };
    }
    return { earned: null, progress: n / target, hint: `${n} / ${target} ${noun}` };
  };
}

/** Badge « une sortie au moins égale à » avec le meilleur résultat comme avancement */
function single(target: number, value: (a: Activity) => number | null, unit: (n: number) => string) {
  return (acts: Activity[]): BadgeResult => {
    let best = 0;
    let times = 0;
    let earned: string | null = null;
    for (const a of acts) {
      const v = value(a) ?? 0;
      best = Math.max(best, v);
      if (v >= target) {
        times++;
        earned ??= a.date;
      }
    }
    return earned
      ? { earned, times, progress: 1, hint: '' }
      : { earned: null, progress: best / target, hint: `Meilleur : ${unit(best)} / ${unit(target)}` };
  };
}

/** Totaux par clé de regroupement (semaine, mois…) ; badge à la première clé qui atteint le seuil */
function bucketed(target: number, key: (a: Activity) => string, value: (a: Activity) => number, unit: (n: number) => string) {
  return (acts: Activity[]): BadgeResult => {
    const totals = new Map<string, number>();
    let earned: string | null = null;
    let best = 0;
    for (const a of acts) {
      const k = key(a);
      const t = (totals.get(k) ?? 0) + value(a);
      totals.set(k, t);
      best = Math.max(best, t);
      if (t >= target && !earned) earned = a.date;
    }
    const times = [...totals.values()].filter((t) => t >= target).length;
    return earned
      ? { earned, times, progress: 1, hint: '' }
      : { earned: null, progress: best / target, hint: `Meilleur : ${unit(best)} / ${unit(target)}` };
  };
}

/** Plus longue série de jours consécutifs, avec la date où la série atteint `target` */
function dayStreak(target: number) {
  return (acts: Activity[]): BadgeResult => {
    const days = [...new Set(acts.map((a) => a.date))].sort();
    let run = 0, best = 0, prev: string | null = null;
    for (const d of days) {
      run = prev && isoDay(addDays(parseDay(prev), 1)) === d ? run + 1 : 1;
      best = Math.max(best, run);
      if (run >= target) return { earned: d, progress: 1, hint: '' };
      prev = d;
    }
    return { earned: null, progress: best / target, hint: `Record : ${best} / ${target} jours` };
  };
}

function weekStreak(target: number) {
  return (acts: Activity[]): BadgeResult => {
    const weeks = [...new Set(acts.map((a) => isoDay(startOfWeek(parseDay(a.date)))))].sort();
    let run = 0, best = 0, prev: string | null = null;
    for (const w of weeks) {
      run = prev && isoDay(addDays(parseDay(prev), 7)) === w ? run + 1 : 1;
      best = Math.max(best, run);
      if (run >= target) return { earned: isoDay(addDays(parseDay(w), 6)), progress: 1, hint: '' };
      prev = w;
    }
    return { earned: null, progress: best / target, hint: `Record : ${best} / ${target} semaines` };
  };
}

/** Le total mensuel augmente `target` mois de suite */
function monthlyStairs(target: number, value: (acts: Activity[]) => number, label: string) {
  return (acts: Activity[]): BadgeResult => {
    const byMonth = new Map<string, Activity[]>();
    for (const a of acts) {
      const k = a.date.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k)!.push(a);
    }
    const months = [...byMonth.keys()].sort();
    let run = 0, best = 0, prevVal = -Infinity, prevKey: string | null = null;
    for (const m of months) {
      const v = value(byMonth.get(m)!);
      const consecutive = prevKey !== null && nextMonth(prevKey) === m;
      run = consecutive && v > prevVal ? run + 1 : 0;
      best = Math.max(best, run);
      if (run >= target) return { earned: byMonth.get(m)!.at(-1)!.date, progress: 1, hint: '' };
      prevVal = v;
      prevKey = m;
    }
    return { earned: null, progress: best / target, hint: `Record : ${best} / ${target} mois de hausse ${label}` };
  };
}

function nextMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Une sortie un jour précis de l'année (MM-DD) */
function onDay(mmdd: string[]) {
  return (acts: Activity[]): BadgeResult => {
    const hits = acts.filter((a) => mmdd.includes(a.date.slice(5)));
    return hits.length
      ? { earned: hits[0].date, times: new Set(hits.map((a) => a.date)).size, progress: 1, hint: '' }
      : { earned: null, progress: 0, hint: 'Rendez-vous le jour J' };
  };
}

const km = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} km`;
const m = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} m`;
const h = (n: number) => `${Math.floor(n / 3600).toLocaleString('fr-FR')} h`;
const weekKey = (a: Activity) => isoDay(startOfWeek(parseDay(a.date)));
const monthKey = (a: Activity) => a.date.slice(0, 7);
const hourIn = (from: number, to: number) => (a: Activity) => {
  const hr = startHour(a);
  return hr !== null && hr >= from && hr < to;
};

export const BADGES: Badge[] = [
  // Distance d'une sortie
  { id: 'd5', family: 'Distance', icon: '🥉', name: '5 km', description: 'Courir 5 km d\'une traite', eval: single(5, (a) => a.distanceKm, km) },
  { id: 'd10', family: 'Distance', icon: '🔟', name: '10 km', description: 'Courir 10 km d\'une traite', eval: single(10, (a) => a.distanceKm, km) },
  { id: 'd21', family: 'Distance', icon: '🥈', name: 'Semi', description: 'Courir 21,1 km d\'une traite', eval: single(21.0975, (a) => a.distanceKm, km) },
  { id: 'd30', family: 'Distance', icon: '💪', name: '30 km', description: 'Courir 30 km d\'une traite', eval: single(30, (a) => a.distanceKm, km) },
  { id: 'd42', family: 'Distance', icon: '🏅', name: 'Marathon', description: 'Courir 42,195 km d\'une traite', eval: single(42.195, (a) => a.distanceKm, km) },
  { id: 'd50', family: 'Distance', icon: '🦄', name: 'Ultra', description: 'Courir 50 km d\'une traite', eval: single(50, (a) => a.distanceKm, km) },

  // Cumul
  { id: 'c500', family: 'Cumul', icon: '🛣️', name: '500 km', description: '500 km au total', eval: cumulative(500, (a) => a.distanceKm, km) },
  { id: 'c1000', family: 'Cumul', icon: '🇫🇷', name: 'La France', description: '1 000 km au total, la longueur de la France', eval: cumulative(1000, (a) => a.distanceKm, km) },
  { id: 'c2500', family: 'Cumul', icon: '🌊', name: 'Le Danube', description: '2 500 km au total', eval: cumulative(2500, (a) => a.distanceKm, km) },
  { id: 'c5000', family: 'Cumul', icon: '🧱', name: '5 000 km', description: '5 000 km au total', eval: cumulative(5000, (a) => a.distanceKm, km) },
  { id: 'c10000', family: 'Cumul', icon: '🌍', name: 'Un quart de Terre', description: '10 000 km au total', eval: cumulative(10000, (a) => a.distanceKm, km) },
  { id: 't24', family: 'Cumul', icon: '🕛', name: 'Une journée', description: '24 h de course cumulées', eval: cumulative(24 * 3600, (a) => a.durationSec, h) },
  { id: 't168', family: 'Cumul', icon: '📅', name: 'Une semaine', description: '168 h de course cumulées', eval: cumulative(168 * 3600, (a) => a.durationSec, h) },
  { id: 't750', family: 'Cumul', icon: '🗓️', name: 'Un mois', description: '750 h de course cumulées', eval: cumulative(750 * 3600, (a) => a.durationSec, h) },

  // Volume
  { id: 'w30', family: 'Volume', icon: '📈', name: 'Semaine solide', description: '30 km dans une semaine', eval: bucketed(30, weekKey, (a) => a.distanceKm, km) },
  { id: 'w50', family: 'Volume', icon: '🚀', name: 'Grosse semaine', description: '50 km dans une semaine', eval: bucketed(50, weekKey, (a) => a.distanceKm, km) },
  { id: 'w80', family: 'Volume', icon: '🔥', name: 'Semaine de folie', description: '80 km dans une semaine', eval: bucketed(80, weekKey, (a) => a.distanceKm, km) },
  { id: 'm100', family: 'Volume', icon: '💯', name: 'Mois à 100', description: '100 km dans un mois', eval: bucketed(100, monthKey, (a) => a.distanceKm, km) },
  { id: 'm200', family: 'Volume', icon: '⚡', name: 'Mois à 200', description: '200 km dans un mois', eval: bucketed(200, monthKey, (a) => a.distanceKm, km) },
  { id: 'm300', family: 'Volume', icon: '🌋', name: 'Mois à 300', description: '300 km dans un mois', eval: bucketed(300, monthKey, (a) => a.distanceKm, km) },

  // Régularité
  { id: 's5', family: 'Régularité', icon: '🔗', name: '5 d\'affilée', description: '5 jours de course consécutifs', eval: dayStreak(5) },
  { id: 's10', family: 'Régularité', icon: '⛓️', name: '10 d\'affilée', description: '10 jours de course consécutifs', eval: dayStreak(10) },
  { id: 's21', family: 'Régularité', icon: '🧠', name: 'Une habitude', description: '21 jours consécutifs, le temps d\'ancrer une habitude', eval: dayStreak(21) },
  { id: 'ws12', family: 'Régularité', icon: '📆', name: 'Un trimestre', description: '12 semaines de suite avec au moins une sortie', eval: weekStreak(12) },
  { id: 'ws26', family: 'Régularité', icon: '🗓️', name: 'Un semestre', description: '26 semaines de suite avec au moins une sortie', eval: weekStreak(26) },
  { id: 'ws52', family: 'Régularité', icon: '🏆', name: 'Une année pleine', description: '52 semaines de suite avec au moins une sortie', eval: weekStreak(52) },
  { id: 'stairs', family: 'Régularité', icon: '🪜', name: 'Escalier', description: 'Distance mensuelle en hausse 4 mois de suite', eval: monthlyStairs(4, (as) => as.reduce((s, a) => s + a.distanceKm, 0), 'de distance') },
  { id: 'further', family: 'Régularité', icon: '🔭', name: 'Toujours plus loin', description: 'Plus longue sortie du mois en hausse 4 mois de suite', eval: monthlyStairs(4, (as) => Math.max(...as.map((a) => a.distanceKm)), 'de la plus longue sortie') },

  // Moments
  { id: 'early', family: 'Moments', icon: '🐓', name: 'Lève-tôt', description: '10 sorties parties avant 7 h', eval: countOf(10, hourIn(0, 7)) },
  { id: 'night', family: 'Moments', icon: '🦉', name: 'Oiseau de nuit', description: '10 sorties parties après 21 h', eval: countOf(10, hourIn(21, 24)) },
  { id: 'lunch', family: 'Moments', icon: '🥪', name: 'Pause déj', description: '10 sorties parties entre 12 h et 14 h', eval: countOf(10, hourIn(12, 14)) },
  { id: 'sunday', family: 'Moments', icon: '⛪', name: 'Messe du dimanche', description: '50 sorties le dimanche', eval: countOf(50, (a) => parseDay(a.date).getDay() === 0) },
  { id: 'double', family: 'Moments', icon: '✌️', name: 'Double ration', description: 'Deux sorties le même jour', eval: (acts) => {
      const seen = new Set<string>();
      const hit = acts.find((a) => (seen.has(a.date) ? true : (seen.add(a.date), false)));
      return hit ? { earned: hit.date, progress: 1, hint: '' } : { earned: null, progress: 0, hint: 'Pas encore' };
    } },
  { id: 'ny', family: 'Moments', icon: '🎆', name: 'Bonne résolution', description: 'Courir le 1er janvier', eval: onDay(['01-01']) },
  { id: 'nye', family: 'Moments', icon: '🥂', name: 'Saint-Sylvestre', description: 'Courir le 31 décembre', eval: onDay(['12-31']) },
  { id: 'summer', family: 'Moments', icon: '🌞', name: 'Solstice d\'été', description: 'Courir le 21 juin', eval: onDay(['06-21']) },
  { id: 'xmas', family: 'Moments', icon: '🎄', name: 'Footing de Noël', description: 'Courir le 25 décembre', eval: onDay(['12-25']) },

  // Dénivelé
  { id: 'e330', family: 'Dénivelé', icon: '🗼', name: 'Tour Eiffel', description: '330 m de D+ en une sortie', eval: single(330, (a) => a.elevGain ?? null, m) },
  { id: 'e828', family: 'Dénivelé', icon: '🏙️', name: 'Burj Khalifa', description: '828 m de D+ en une sortie', eval: single(828, (a) => a.elevGain ?? null, m) },
  { id: 'e1500', family: 'Dénivelé', icon: '🧗', name: 'Grimpeur', description: '1 500 m de D+ en une sortie', eval: single(1500, (a) => a.elevGain ?? null, m) },
  { id: 'emb', family: 'Dénivelé', icon: '🏔️', name: 'Mont Blanc du mois', description: '4 806 m de D+ dans un mois', eval: bucketed(4806, monthKey, (a) => a.elevGain ?? 0, m) },
  { id: 'eev', family: 'Dénivelé', icon: '🏔️', name: 'Everest cumulé', description: '8 849 m de D+ au total', eval: cumulative(8849, (a) => a.elevGain ?? 0, m) },
  { id: 'eev5', family: 'Dénivelé', icon: '🚡', name: '5 Everest', description: '44 245 m de D+ au total', eval: cumulative(44245, (a) => a.elevGain ?? 0, m) },

  // Vitesse & intensité
  { id: 'km4', family: 'Vitesse', icon: '🚀', name: 'Sub 4', description: 'Un kilomètre en moins de 4:00', eval: single(1, (a) => (a.bestKmSec ? 240 / a.bestKmSec : null), (n) => (n ? `${Math.floor(240 / n / 60)}:${String(Math.round((240 / n) % 60)).padStart(2, '0')}` : '–')) },
  { id: 'p10', family: 'Vitesse', icon: '💨', name: '10 km sub 5', description: 'Une sortie de 10 km ou plus sous 5:00 /km', eval: single(1, (a) => (a.distanceKm >= 10 ? 300 / (a.durationSec / a.distanceKm) : null), (n) => (n ? `${Math.floor(300 / n / 60)}:${String(Math.round((300 / n) % 60)).padStart(2, '0')} /km` : '–')) },
  { id: 'ana', family: 'Vitesse', icon: '🫀', name: 'Dans le rouge', description: 'Une séance avec un TE anaérobie de 4 ou plus', eval: single(4, (a) => a.anaerobicTE ?? null, (n) => n.toFixed(1)) },
  { id: 'load300', family: 'Vitesse', icon: '🏋️', name: 'Grosse charge', description: 'Une sortie avec une charge d\'entraînement de 300 ou plus', eval: single(300, (a) => a.trainingLoad ?? null, (n) => String(Math.round(n))) },

  // Exploration
  { id: 'places10', family: 'Exploration', icon: '🧭', name: 'Explorateur', description: '10 lieux de départ différents (à plus de 1 km)', eval: (acts) => {
      const n = startPlaces(acts).length;
      if (n < 10) return { earned: null, progress: n / 10, hint: `${n} / 10 lieux` };
      const sorted = startPlaces(acts).sort((a, b) => a.first.localeCompare(b.first));
      return { earned: sorted[9].first, progress: 1, hint: '' };
    } },
  { id: 'trail10', family: 'Exploration', icon: '🌲', name: 'Traileur', description: '10 sorties trail', eval: countOf(10, (a) => a.kind === 'trail') },
  { id: 'edd30', family: 'Exploration', icon: '📐', name: 'Eddington 30', description: '30 jours différents à 30 km ou plus', eval: (acts) => {
      const { e } = eddington(acts);
      const days = new Map<string, number>();
      for (const a of acts) days.set(a.date, (days.get(a.date) ?? 0) + a.distanceKm);
      const n = [...days.values()].filter((d) => d >= 30).length;
      if (e >= 30) {
        let count = 0;
        const d30 = [...days.entries()].sort().find(([, v]) => v >= 30 && ++count >= 30);
        return { earned: d30?.[0] ?? null, progress: 1, hint: '' };
      }
      return { earned: null, progress: n / 30, hint: `${n} / 30 jours à 30 km` };
    } },
];
