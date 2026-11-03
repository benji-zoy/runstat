/**
 * Parcours d'un objectif : lecture d'un tracé GPX (profil d'altitude compact et points de passage nommés), découpage en
 * tronçons de pente, et simulation du temps tronçon par tronçon (pente, usure, nuit, arrêts) qui sert aux prédictions
 * d'ultra et aux temps de passage.
 *
 * Sans GPX, un profil synthétique répartit le D+ et le D− uniformément, sur des montées à la pente typique de la course.
 * Seul le profil est gardé (altitude tous les `stepKm`, points de passage) : pas de coordonnées, sauf le départ arrondi
 * qui sert à la météo.
 */
import { GoalCourse } from './models';

export interface Segment {
  /** Bornes en km (distance officielle) */
  from: number;
  to: number;
  /** Pente (m/m) */
  grade: number;
}

export interface Waypoint {
  name: string;
  km: number;
}

export interface ParsedGpx {
  course: GoalCourse;
  distanceKm: number;
  gain: number;
  loss: number;
  /** Départ arrondi à 0,01° (météo) */
  start: { lat: number; lon: number } | null;
}

/** Points d'altitude gardés au plus : ≈ 4 Ko pour 80 km, la saisie est limitée à 64 Ko */
export const MAX_COURSE_POINTS = 1000;
const RESAMPLE_M = 20;
const SMOOTH_M = 60;
const HYSTERESIS_M = 2;
const WAYPOINT_MAX_M = 250;
const MAX_WAYPOINTS = 60;

const R = 6371008.8;
const rad = (x: number) => (x * Math.PI) / 180;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(attrs);
  return m ? Number(m[1]) : NaN;
};

interface RawPoint { lat: number; lon: number; ele: number | null }

function points(xml: string, tag: 'trkpt' | 'rtept' | 'wpt'): (RawPoint & { name: string | null })[] {
  const out: (RawPoint & { name: string | null })[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const lat = attr(m[1], 'lat'), lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const body = m[2] ?? '';
    const ele = /<ele>\s*([-+\d.eE]+)\s*<\/ele>/.exec(body);
    const name = /<name>([\s\S]*?)<\/name>/.exec(body);
    out.push({ lat, lon, ele: ele && Number.isFinite(Number(ele[1])) ? Number(ele[1]) : null, name: name ? xmlText(name[1]) || null : null });
  }
  return out;
}

/** D+ et D− avec hystérésis (contre le bruit de l'altitude) */
export function gainLoss(ele: number[], hysteresis = HYSTERESIS_M): { gain: number; loss: number } {
  let gain = 0, loss = 0, anchor = ele[0];
  for (const z of ele) {
    const dz = z - anchor;
    if (Math.abs(dz) < hysteresis) continue;
    if (dz > 0) gain += dz;
    else loss -= dz;
    anchor = z;
  }
  return { gain, loss };
}

/** Lecture d'un GPX (traces, sinon itinéraire) : erreur lisible si le fichier ne convient pas */
export function parseGpx(xml: string, file?: string): ParsedGpx {
  if (!/<gpx[\s>]/i.test(xml)) throw new Error('Ce fichier n’est pas un GPX.');
  let pts = points(xml, 'trkpt');
  if (pts.length < 2) pts = points(xml, 'rtept');
  if (pts.length < 2) throw new Error('Le GPX ne contient pas de tracé.');
  const withEle = pts.filter((p) => p.ele !== null).length;
  if (withEle < 0.8 * pts.length) throw new Error('Le tracé n’a pas d’altitudes : exporte-le avec le profil (ou depuis le site de la course).');

  // Distance cumulée, altitudes manquantes reprises du point précédent
  const cum = [0];
  const eles = [pts[0].ele ?? pts.find((p) => p.ele !== null)!.ele!];
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    cum.push(cum[i - 1] + (d < 5000 ? d : 0));
    eles.push(pts[i].ele ?? eles[i - 1]);
  }
  const total = cum.at(-1)!;
  if (total < 400) throw new Error('Le tracé fait moins de 400 m.');

  // Rééchantillonnage tous les 20 m, puis lissage (moyenne glissante de ±60 m) : le bruit gonfle le D+
  const n = Math.floor(total / RESAMPLE_M) + 1;
  const fine: number[] = [];
  for (let k = 0, j = 0; k < n; k++) {
    const x = Math.min(total, k * RESAMPLE_M);
    while (j < cum.length - 2 && cum[j + 1] < x) j++;
    const span = cum[j + 1] - cum[j];
    fine.push(span > 0 ? eles[j] + ((eles[j + 1] - eles[j]) * (x - cum[j])) / span : eles[j]);
  }
  const w = Math.round(SMOOTH_M / RESAMPLE_M);
  const prefix = [0];
  for (const z of fine) prefix.push(prefix.at(-1)! + z);
  const smooth = fine.map((_, k) => {
    const a = Math.max(0, k - w), b = Math.min(fine.length - 1, k + w);
    return (prefix[b + 1] - prefix[a]) / (b - a + 1);
  });
  const { gain, loss } = gainLoss(smooth);

  // Profil gardé : pas de 50 m au moins, ≤ MAX_COURSE_POINTS points
  const km = total / 1000;
  const stepKm = Math.max(0.05, Math.ceil((km / (MAX_COURSE_POINTS - 1)) * 20) / 20);
  const ele: number[] = [];
  for (let x = 0; x < km + 1e-9; x += stepKm) ele.push(Math.round(smooth[Math.min(smooth.length - 1, Math.round((x * 1000) / RESAMPLE_M))]));
  if ((ele.length - 1) * stepKm < km - stepKm / 2) ele.push(Math.round(smooth.at(-1)!));

  // Points de passage nommés (ravitaillements, sommets) à moins de 250 m du tracé, dans l'ordre du parcours
  const waypoints: Waypoint[] = [];
  for (const w of points(xml, 'wpt')) {
    let best = Infinity, at = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = haversine(w.lat, w.lon, pts[i].lat, pts[i].lon);
      if (d < best) (best = d), (at = cum[i]);
    }
    if (best > WAYPOINT_MAX_M || at < 500 || at > total - 300) continue;
    waypoints.push({ name: (w.name ?? `km ${Math.round(at / 1000)}`).slice(0, 60), km: Math.round(at / 10) / 100 });
  }
  waypoints.sort((a, b) => a.km - b.km);
  const kept = waypoints.filter((w, i) => !waypoints.slice(0, i).some((o) => o.name === w.name && Math.abs(o.km - w.km) < 0.3)).slice(0, MAX_WAYPOINTS);

  const course: GoalCourse = { stepKm, ele, ...(kept.length ? { waypoints: kept } : {}), ...(file ? { file: file.slice(0, 120) } : {}) };
  return {
    course,
    distanceKm: Math.round(km * 100) / 100,
    gain: Math.round(gain),
    loss: Math.round(loss),
    start: { lat: Math.round(pts[0].lat * 100) / 100, lon: Math.round(pts[0].lon * 100) / 100 },
  };
}

// ---------------------------------------------------------------------------
// Tronçons de pente
// ---------------------------------------------------------------------------

export interface CourseInput {
  distanceKm: number;
  elevGain?: number;
  elevLoss?: number;
  kind: 'road' | 'trail';
  course?: GoalCourse;
}

/** Pente typique des montées d'un parcours sans GPX, selon sa densité de dénivelé (27 m/km → 9 %, 55 m/km → 16 %) */
export function typicalGrade(distanceKm: number, gain: number, loss: number, kind: 'road' | 'trail'): number {
  const density = (gain + loss) / 2 / Math.max(0.1, distanceKm) / 1000;
  const g = kind === 'road' ? 0.04 : Math.min(0.3, Math.max(0.05, 0.02 + 2.5 * density));
  // Les montées et descentes doivent tenir dans le km
  return Math.max(g, ((gain + loss) / Math.max(0.1, distanceKm) / 1000) * 1.05);
}

/**
 * Tronçons du parcours, ramenés à la distance officielle. Avec un GPX, les pentes sont recalées sur le D+ et le D−
 * annoncés (le profil compact en perd un peu). Sans GPX : chaque km reçoit sa part de montée, de plat et de descente.
 */
export function courseSegments(g: CourseInput): Segment[] {
  const D = g.distanceKm;
  const gain = g.elevGain ?? 0;
  const loss = g.elevLoss ?? gain;
  const c = g.course;
  if (c && c.ele.length >= 2) {
    const len = c.stepKm * (c.ele.length - 1);
    const sx = D / len;
    let up = 0, down = 0;
    for (let i = 1; i < c.ele.length; i++) {
      const dz = c.ele[i] - c.ele[i - 1];
      if (dz > 0) up += dz;
      else down -= dz;
    }
    const clamp = (x: number) => Math.min(2, Math.max(0.5, x));
    const su = g.elevGain && up > 0 ? clamp(gain / up) : 1;
    const sd = (g.elevLoss ?? g.elevGain) && down > 0 ? clamp(loss / down) : 1;
    const out: Segment[] = [];
    for (let i = 1; i < c.ele.length; i++) {
      const dz = c.ele[i] - c.ele[i - 1];
      const from = (i - 1) * c.stepKm * sx, to = i * c.stepKm * sx;
      out.push({ from, to, grade: ((dz > 0 ? dz * su : dz * sd) / ((to - from) * 1000)) });
    }
    return out;
  }
  const n = Math.max(1, Math.round(D));
  const step = D / n;
  const grade = typicalGrade(D, gain, loss, g.kind);
  const upKm = gain / n / (grade * 1000), downKm = loss / n / (grade * 1000);
  const out: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const parts: [number, number][] = [[upKm, grade], [Math.max(0, step - upKm - downKm), 0], [downKm, -grade]];
    let x = a;
    for (const [len, gr] of parts) {
      if (len <= 0) continue;
      out.push({ from: x, to: x + len, grade: gr });
      x += len;
    }
  }
  return out;
}

/** Points de passage ramenés à la distance officielle */
export function courseWaypoints(g: CourseInput): Waypoint[] {
  const c = g.course;
  if (!c?.waypoints?.length) return [];
  const sx = g.distanceKm / (c.stepKm * (c.ele.length - 1));
  return c.waypoints.map((w) => ({ name: w.name, km: Math.min(g.distanceKm, w.km * sx) }));
}

/** Profil (km, altitude) à la distance officielle, pour le graphique */
export function courseProfile(g: CourseInput): { km: number; ele: number }[] {
  const c = g.course;
  if (!c) return [];
  const sx = g.distanceKm / (c.stepKm * (c.ele.length - 1));
  return c.ele.map((ele, i) => ({ km: i * c.stepKm * sx, ele }));
}

/** D+ et D− entre deux km d'une liste de tronçons */
export function elevationBetween(segs: Segment[], from: number, to: number): { gain: number; loss: number } {
  let gain = 0, loss = 0;
  for (const s of segs) {
    const len = Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
    if (!len) continue;
    const dz = s.grade * len * 1000;
    if (dz > 0) gain += dz;
    else loss -= dz;
  }
  return { gain, loss };
}

// ---------------------------------------------------------------------------
// Nuit
// ---------------------------------------------------------------------------

/** Fin et début du crépuscule civil (soleil à −6°), en minutes locales : la frontale s'allume entre les deux */
export function nightWindow(date: string, lat = 45, lon = 3): { dusk: number; dawn: number } {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d, 12);
  const n = Math.round((day.getTime() - new Date(y, 0, 1, 12).getTime()) / 86_400_000) + 1;
  const decl = rad(-23.44 * Math.cos(((2 * Math.PI) / 365) * (n + 10)));
  const cosH = (Math.sin(rad(-6)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
  const h = (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI;
  const b = (2 * Math.PI * (n - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const noon = 720 - 4 * lon - eot - day.getTimezoneOffset();
  return { dusk: noon + 4 * h, dawn: noon - 4 * h };
}

/**
 * Coût de la nuit sur un tronçon : +3 % sur le plat et les chemins roulants, +2 % en montée raide (on marche),
 * +8 % en descente raide (on voit mal où poser le pied), +2 % de plus au creux circadien (2 h – 6 h).
 * Ordres de grandeur des retours d'ultra-traileurs : aucune étude ne chiffre précisément l'effet.
 */
export function nightCost(grade: number, minuteOfDay: number): number {
  const base = grade <= -0.08 ? 0.08 : grade >= 0.08 ? 0.02 : 0.03;
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return 1 + base + (m >= 120 && m < 360 ? 0.02 : 0);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimOptions {
  /** Coût relatif d'une pente (1 = plat) */
  cost: (grade: number) => number;
  /** Vitesse sur le plat au départ (m/s) */
  speed: number;
  /** Perte de vitesse par heure au-delà de `fadeFromH` (0,02 = −2 %/h), plancher à 60 % */
  fadePerHour?: number;
  fadeFromH?: number;
  /** Heure de départ (minutes) et fenêtre de nuit : coût de nuit par tronçon */
  startMin?: number | null;
  night?: { dusk: number; dawn: number } | null;
  /** Multiplicateur par tronçon (plan d'allure : départ prudent, final) */
  phase?: (km: number) => number;
  /** Arrêts : secondes ajoutées en arrivant au km donné */
  stops?: { km: number; sec: number }[];
}

export interface Timeline {
  /** km des fins de tronçon, en commençant par 0 */
  km: number[];
  /** Temps écoulé (s) à chaque km */
  t: number[];
  total: number;
  /** Vitesse sur le plat au départ (m/s) */
  speed: number;
}

const isNight = (min: number, w: { dusk: number; dawn: number }) => {
  const m = ((min % 1440) + 1440) % 1440;
  return m >= w.dusk || m < w.dawn;
};

export function simulate(segs: Segment[], o: SimOptions): Timeline {
  const km = [0], t = [0];
  const stops = [...(o.stops ?? [])].sort((a, b) => a.km - b.km);
  let si = 0;
  let time = 0;
  for (const s of segs) {
    const h = time / 3600;
    const fade = Math.max(0.6, 1 - (o.fadePerHour ?? 0) * Math.max(0, h - (o.fadeFromH ?? 0)));
    let dt = ((s.to - s.from) * 1000 * o.cost(s.grade)) / (o.speed * fade);
    if (o.phase) dt *= o.phase((s.from + s.to) / 2);
    if (o.night && o.startMin != null && isNight(o.startMin + time / 60, o.night)) dt *= nightCost(s.grade, o.startMin + time / 60);
    time += dt;
    while (si < stops.length && stops[si].km <= s.to + 1e-9) time += stops[si++].sec;
    km.push(s.to);
    t.push(time);
  }
  return { km, t, total: time, speed: o.speed };
}

/** Simulation recalée (vitesse ajustée) pour durer `total` secondes : forme de la course, durée imposée */
export function fitTimeline(segs: Segment[], total: number, o: Omit<SimOptions, 'speed'>): Timeline {
  const stopSec = (o.stops ?? []).reduce((s, x) => s + x.sec, 0);
  const moving = Math.max(total * 0.5, total - stopSec);
  const dist = segs.reduce((s, x) => s + (x.to - x.from), 0) * 1000;
  let speed = dist / moving;
  let tl = simulate(segs, { ...o, speed });
  for (let i = 0; i < 6 && Math.abs(tl.total / total - 1) > 0.001; i++) {
    speed *= (tl.total - stopSec) / moving;
    tl = simulate(segs, { ...o, speed });
  }
  const k = total / tl.total;
  return { km: tl.km, t: tl.t.map((x) => x * k), total, speed: tl.speed / k };
}

/** Temps écoulé au km `x` (interpolation linéaire) */
export function timeAt(tl: Timeline, x: number): number {
  if (x <= 0) return 0;
  let lo = 0, hi = tl.km.length - 1;
  if (x >= tl.km[hi]) return tl.t[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tl.km[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = tl.km[hi] - tl.km[lo];
  return tl.t[lo] + (span > 0 ? ((tl.t[hi] - tl.t[lo]) * (x - tl.km[lo])) / span : 0);
}
