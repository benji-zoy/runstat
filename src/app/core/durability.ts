/**
 * Durabilité : capacité à garder son efficacité quand la durée s'allonge (Maunder et al. 2021, Jones 2024).
 * Calculée sur les tours au km (FIT ou tours Coros), avec l'allure ajustée à la pente pour comparer route et trail :
 * - perte d'efficacité (vitesse ajustée / FC) entre le premier et le dernier tiers ;
 * - dérive cardiaque à allure égale (régression FC ~ vitesse + temps) ;
 * - début de la dégradation (efficacité glissante durablement sous 95 % de la référence) ;
 * - en trail : vitesse ascensionnelle et vitesse en descente, début contre fin.
 */
import { Activity } from './models';
import { parseDay } from './stats';
import { theilSen } from './science';

export interface KmLap {
  d: number;
  t: number;
  hr: number;
  up: number;
  down: number;
  /** Allure ajustée à la pente (s/km) */
  gap: number;
  pw: number;
  cad: number;
  /** Temps écoulé au début du tour (s) */
  start: number;
  /** Efficacité : vitesse ajustée (m/min) / FC */
  ef: number;
}

const DAY_MS = 86_400_000;
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Tours exploitables : ≥ 300 m, FC présente, sans les arrêts (ravitaillement, attente : allure ajustée > 2,2 × la médiane) */
export function kmLaps(a: Activity): KmLap[] {
  if (!a.km?.length) return [];
  let start = 0;
  const all = a.km.map(([d, t, hr, up, down, gap, pw, cad]) => {
    const lap = { d, t, hr, up, down, gap, pw, cad, start, ef: gap > 0 && hr > 0 ? 60000 / gap / hr : 0 };
    start += t;
    return lap;
  });
  const gapMed = median(all.filter((l) => l.gap > 0).map((l) => l.gap));
  return all.filter((l) => l.d >= 300 && l.hr > 0 && l.gap > 0 && l.gap <= 2.2 * gapMed);
}

export const isTrailRun = (a: Activity) => a.kind === 'trail' || (a.elevGain ?? 0) / Math.max(0.1, a.distanceKm) > 25;

export interface Durability {
  activity: Activity;
  trail: boolean;
  /** Durée (h) */
  hours: number;
  /** Perte d'efficacité dernier tiers / premier tiers (%, positif = dégradation) */
  efLoss: number;
  /** Ralentissement de l'allure ajustée (%) */
  paceFade: number;
  /** Dérive de FC à allure égale (bpm par heure) */
  hrDrift: number | null;
  /** Début de la dégradation (s écoulées), null si l'efficacité tient */
  onset: number | null;
  /** Vitesse ascensionnelle (m/h) sur les km qui montent (≥ 5 %), première puis seconde moitié */
  climb: [number, number] | null;
  /** Vitesse en descente (km/h) sur les km qui descendent (≥ 5 %), première puis seconde moitié */
  descent: [number, number] | null;
  /** Cadence moyenne (pas/min) premier puis dernier tiers */
  cadence: [number, number] | null;
  /** Efficacité relative (1 = référence) sur 3 km glissants, par temps écoulé (s) */
  profile: { t: number; rel: number }[];
  /** Allure régulière : une fin nettement plus rapide (progressif, fin à allure course) fausse la comparaison */
  steady: boolean;
}

/** Moyenne pondérée par le temps d'une grandeur sur des tours */
const tw = (laps: KmLap[], f: (l: KmLap) => number) => {
  const T = laps.reduce((s, l) => s + l.t, 0);
  return T ? laps.reduce((s, l) => s + f(l) * l.t, 0) / T : NaN;
};

/** Régression FC = a + b·vitesse + c·temps (moindres carrés à 2 variables) → c en bpm/h */
export function hrDrift(laps: KmLap[]): number | null {
  if (laps.length < 6) return null;
  const xs = laps.map((l) => [1000 / l.gap, (l.start + l.t / 2) / 3600]);
  const ys = laps.map((l) => l.hr);
  const n = xs.length;
  const m = (k: number) => xs.reduce((s, x) => s + x[k], 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  const [m0, m1] = [m(0), m(1)];
  let s00 = 0, s01 = 0, s11 = 0, s0y = 0, s1y = 0;
  xs.forEach(([v, t], i) => {
    const a = v - m0, b = t - m1, y = ys[i] - my;
    s00 += a * a; s01 += a * b; s11 += b * b; s0y += a * y; s1y += b * y;
  });
  if (s11 < 1e-12) return null;
  // Allure parfaitement constante : simple régression de la FC sur le temps
  if (s00 < 1e-9) return s1y / s11;
  const det = s00 * s11 - s01 * s01;
  if (Math.abs(det) < 1e-12) return null;
  return (s00 * s1y - s01 * s0y) / det;
}

/** Analyse de durabilité d'une sortie (≥ 60 min et ≥ 8 tours exploitables) */
export function durability(a: Activity): Durability | null {
  if (a.durationSec < 3600 || a.kind === 'indoor') return null;
  const laps = kmLaps(a);
  if (laps.length < 8) return null;
  const total = laps.at(-1)!.start + laps.at(-1)!.t;
  // Premier tiers sans les 10 premières minutes (échauffement), dernier tiers
  const first = laps.filter((l) => l.start + l.t / 2 >= 600 && l.start + l.t / 2 < total / 3);
  const last = laps.filter((l) => l.start + l.t / 2 >= (2 * total) / 3);
  if (first.length < 2 || last.length < 2) return null;
  const ref = tw(first, (l) => l.ef);
  const efLast = tw(last, (l) => l.ef);

  // Efficacité glissante sur 3 km
  const profile = laps.map((l, i) => {
    const win = laps.slice(Math.max(0, i - 1), i + 2);
    return { t: l.start + l.t / 2, rel: tw(win, (x) => x.ef) / ref };
  });
  let onset: number | null = null;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].t < total / 3 || profile[i].rel >= 0.95) continue;
    if (profile.slice(i + 1, i + 3).every((p) => p.rel < 0.97)) {
      onset = laps[i].start;
      break;
    }
  }

  const half = (sel: KmLap[], f: (ls: KmLap[]) => number): [number, number] | null => {
    const mid = total / 2;
    const h1 = sel.filter((l) => l.start + l.t / 2 < mid);
    const h2 = sel.filter((l) => l.start + l.t / 2 >= mid);
    return h1.length >= 2 && h2.length >= 2 ? [f(h1), f(h2)] : null;
  };
  const climbs = laps.filter((l) => l.up / l.d >= 0.05);
  const descents = laps.filter((l) => l.down / l.d >= 0.05);
  const vam = (ls: KmLap[]) => (ls.reduce((s, l) => s + l.up, 0) / ls.reduce((s, l) => s + l.t, 0)) * 3600;
  const speed = (ls: KmLap[]) => (ls.reduce((s, l) => s + l.d, 0) / ls.reduce((s, l) => s + l.t, 0)) * 3.6;
  const withCad = (ls: KmLap[]) => ls.filter((l) => l.cad > 0);
  const cadFirst = withCad(first), cadLast = withCad(last);

  return {
    activity: a,
    trail: isTrailRun(a),
    hours: total / 3600,
    efLoss: (1 - efLast / ref) * 100,
    paceFade: (tw(last, (l) => l.gap) / tw(first, (l) => l.gap) - 1) * 100,
    hrDrift: hrDrift(laps.filter((l) => l.start >= 600)),
    onset,
    climb: half(climbs, vam),
    descent: half(descents, speed),
    cadence: cadFirst.length && cadLast.length ? [tw(cadFirst, (l) => l.cad), tw(cadLast, (l) => l.cad)] : null,
    profile,
    steady: tw(last, (l) => l.gap) / tw(first, (l) => l.gap) >= 0.95,
  };
}

export interface DurabilitySummary {
  runs: Durability[];
  /** Perte d'efficacité médiane et pente (points de % par heure) */
  road: { median: number; perHour: number; n: number } | null;
  trail: { median: number; perHour: number; n: number } | null;
  /** Efficacité relative médiane par heure de course (1re heure = index 0) */
  curve: { road: (number | null)[]; trail: (number | null)[] };
  /** Tendance de la perte d'efficacité sur les sorties de plus de 90 min (points de % par mois) */
  trend: number | null;
  hrDrift: number | null;
}

/**
 * Synthèse sur les sorties régulières des `days` derniers jours : les séances de fractionné / tempo et les sorties
 * finies nettement plus vite sont exclues (`skip`), car la vitesse y change pour une autre raison que la fatigue.
 */
export function durabilitySummary(acts: Activity[], today: Date, days = 365, skip: (a: Activity) => boolean = () => false): DurabilitySummary {
  const runs = acts
    .filter((a) => (today.getTime() - parseDay(a.date).getTime()) / DAY_MS <= days && !skip(a))
    .map(durability)
    .filter((d): d is Durability => d !== null && d.steady);
  const group = (trail: boolean) => {
    const rs = runs.filter((r) => r.trail === trail);
    if (rs.length < 2) return null;
    return {
      median: median(rs.map((r) => r.efLoss)),
      perHour: theilSen(rs.map((r) => ({ x: r.hours, y: r.efLoss }))),
      n: rs.length,
    };
  };
  const curveFor = (trail: boolean) => {
    const bins: number[][] = [];
    for (const r of runs.filter((x) => x.trail === trail)) {
      for (const p of r.profile) (bins[Math.floor(p.t / 3600)] ??= []).push(p.rel);
    }
    // Une heure n'est affichée que si au moins deux sorties l'atteignent
    return Array.from(bins, (b, h) => {
      const n = new Set(runs.filter((x) => x.trail === trail && x.hours > h).map((x) => x.activity.id)).size;
      return b && n >= 2 ? median(b) : null;
    });
  };
  const long = runs.filter((r) => r.hours >= 1.5);
  const drifts = runs.map((r) => r.hrDrift).filter((x): x is number => x !== null);
  return {
    runs,
    road: group(false),
    trail: group(true),
    curve: { road: curveFor(false), trail: curveFor(true) },
    trend: long.length >= 4 ? theilSen(long.map((r) => ({ x: parseDay(r.activity.date).getTime() / DAY_MS, y: r.efLoss }))) * 30 : null,
    hrDrift: drifts.length ? median(drifts) : null,
  };
}
