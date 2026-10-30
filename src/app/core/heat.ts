/**
 * Carte thermique des parcours : chaque tracé GPS est découpé en cellules d'environ 30 m ; une cellule compte
 * le nombre de sorties (distinctes) qui y passent. Chaque tronçon prend le niveau de sa cellule, sur une échelle
 * doublée à chaque niveau (1, 2-3, 4-7, 8-15, 16 et plus) : les parcours habituels ressortent.
 */
export type LatLon = [number, number];

/** Seuils (nombre de sorties) des niveaux 1 à 4 ; en dessous du premier : niveau 0 */
export const HEAT_STEPS = [2, 4, 8, 16] as const;

export interface HeatLine {
  level: number;
  points: LatLon[];
}

export interface Heat {
  lines: HeatLine[];
  /** Cellule la plus fréquentée : nombre de sorties */
  max: number;
  /** Zone principale (autour de la cellule la plus fréquentée) : cadrage sans les sorties lointaines */
  bounds: [LatLon, LatLon] | null;
}

const CELL_LAT = 0.00027; // ≈ 30 m
const cellKey = (p: LatLon) => {
  const lonStep = CELL_LAT / Math.max(0.2, Math.cos((p[0] * Math.PI) / 180));
  return `${Math.round(p[0] / CELL_LAT)}:${Math.round(p[1] / lonStep)}`;
};

export const heatLevel = (count: number) => HEAT_STEPS.filter((s) => count >= s).length;

export function heatOf(tracks: LatLon[][]): Heat {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const seen = new Set<string>();
    for (const p of t) seen.add(cellKey(p));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const lines: HeatLine[] = [];
  for (const t of tracks) {
    let cur: HeatLine | null = null;
    for (let i = 1; i < t.length; i++) {
      const level = heatLevel(Math.min(counts.get(cellKey(t[i - 1])) ?? 1, counts.get(cellKey(t[i])) ?? 1));
      if (!cur || cur.level !== level) {
        cur = { level, points: [t[i - 1]] };
        lines.push(cur);
      }
      cur.points.push(t[i]);
    }
  }
  // Les niveaux forts sont dessinés en dernier, par-dessus
  lines.sort((a, b) => a.level - b.level);
  let max = 0, hot = '';
  for (const [k, n] of counts) if (n > max) [max, hot] = [n, k];
  return { lines, max, bounds: mainBounds(tracks, hot) };
}

/** Cadrage : 2e-98e centiles des points à moins de ~12 km de la cellule la plus fréquentée */
function mainBounds(tracks: LatLon[][], hot: string): [LatLon, LatLon] | null {
  const center = tracks.flat().find((p) => cellKey(p) === hot);
  if (!center) return null;
  const lats: number[] = [], lons: number[] = [];
  const near = (p: LatLon) => Math.abs(p[0] - center[0]) < 0.11 && Math.abs(p[1] - center[1]) < 0.11 / Math.max(0.2, Math.cos((center[0] * Math.PI) / 180));
  for (const t of tracks) {
    // Un point sur 5 suffit pour les centiles
    for (let i = 0; i < t.length; i += 5) {
      if (!near(t[i])) continue;
      lats.push(t[i][0]);
      lons.push(t[i][1]);
    }
  }
  if (!lats.length) return null;
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  lats.sort((a, b) => a - b);
  lons.sort((a, b) => a - b);
  return [
    [q(lats, 0.02), q(lons, 0.02)],
    [q(lats, 0.98), q(lons, 0.98)],
  ];
}

/**
 * Aperçu SVG sans fond de carte (carte de Comprendre) : chemins `d` par niveau, cadrés sur la zone principale
 * dans une boîte w × h (projection équirectangulaire, suffisante à l'échelle d'une ville).
 */
export function heatPreview(heat: Heat, w: number, h: number): { level: number; d: string }[] {
  if (!heat.bounds) return [];
  const [[lat0, lon0], [lat1, lon1]] = heat.bounds;
  const k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const spanX = Math.max(1e-4, (lon1 - lon0) * k), spanY = Math.max(1e-4, lat1 - lat0);
  const scale = Math.min(w / spanX, h / spanY);
  const ox = (w - spanX * scale) / 2, oy = (h - spanY * scale) / 2;
  const xy = (p: LatLon) => `${(ox + (p[1] - lon0) * k * scale).toFixed(1)} ${(oy + (lat1 - p[0]) * scale).toFixed(1)}`;
  const byLevel = new Map<number, string[]>();
  for (const line of heat.lines) {
    const step = Math.max(1, Math.floor(line.points.length / 40));
    const pts = line.points.filter((_, i) => i % step === 0 || i === line.points.length - 1);
    const d = 'M' + pts.map(xy).join('L');
    const list = byLevel.get(line.level) ?? [];
    list.push(d);
    byLevel.set(line.level, list);
  }
  return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, ds]) => ({ level, d: ds.join('') }));
}
