// Tracés sans FIT (archive Strava : GPX, TCX ; API Strava : streams) → même structure que la sortie de
// fit-file-parser ({ records, laps, sessions }), pour passer par le même analyse() (fit/analyse.ts).
// Cadence en tours par minute (une jambe), comme dans le FIT ; distance haversine si le fichier n'en a pas.
import type { FitData, FitLap, FitRecord, FitSession } from './types.ts';

const EARTH = 6_371_000;
const rad = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(a));
}

const num = (s: string | null | undefined): number | null =>
  s == null || s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null;
/** Contenu de la première balise `name` (préfixe d'espace de noms quelconque : gpxtpx:hr, ns3:hr…) */
const tag = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>\\s*([^<]*?)\\s*</(?:[\\w-]+:)?${name}>`))?.[1];

/** Point horodaté d'un tracé */
export interface TrackPoint {
  /** Instant (ms) */
  t: number;
  lat?: number | null;
  lon?: number | null;
  alt?: number | null;
  /** Distance cumulée (m), facultative */
  dist?: number | null;
  hr?: number | null;
  cad?: number | null;
  power?: number | null;
  temp?: number | null;
  moving?: boolean;
}

/**
 * Points horodatés → enregistrements. Le chronomètre (timer_time) n'avance pas pendant les pauses : écart de plus
 * de 10 s à moins de 0,5 m/s, ou point marqué immobile (`moving: false`, streams Strava).
 */
export function recordsFromPoints(points: TrackPoint[]): FitRecord[] {
  const pts = points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const hasDist = pts.filter((p) => p.dist != null).length > pts.length * 0.8;
  const records: FitRecord[] = [];
  let dist = 0, timer = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[k - 1];
    if (q) {
      const dt = (p.t - q.t) / 1000;
      let dd = 0;
      if (hasDist) dd = Math.max(0, (p.dist ?? q.dist ?? 0) - (q.dist ?? 0));
      else if (p.lat != null && q.lat != null) dd = haversine(q.lat, q.lon!, p.lat, p.lon!);
      // Saut GPS impossible à pied (> 12 m/s) : distance ignorée
      if (!hasDist && dt > 0 && dd / dt > 12) dd = 0;
      dist += dd;
      const paused = p.moving === false || (dt > 10 && dd / dt < 0.5);
      if (dt > 0 && !paused) timer += dt;
    }
    records.push({
      timer_time: Math.round(timer * 10) / 10,
      distance: Math.round(dist * 10) / 10,
      heart_rate: p.hr ?? undefined,
      altitude: p.alt ?? undefined,
      position_lat: p.lat ?? undefined,
      position_long: p.lon ?? undefined,
      cadence: p.cad ?? undefined,
      power: p.power ?? undefined,
      temperature: p.temp ?? undefined,
    });
  }
  return records;
}

const sessionOf = (records: FitRecord[]): FitSession[] => {
  const pw = records.map((r) => r.power).filter((x): x is number => x != null);
  return [{ avg_power: pw.length ? Math.round(pw.reduce((a, b) => a + b, 0) / pw.length) : null }];
};

export function parseGpx(xml: string): FitData {
  const points: TrackPoint[] = [];
  for (const m of xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
    const attrs = m[1], body = m[2];
    points.push({
      t: Date.parse(tag(body, 'time')!),
      lat: num(attrs.match(/lat="([^"]+)"/)?.[1]),
      lon: num(attrs.match(/lon="([^"]+)"/)?.[1]),
      alt: num(tag(body, 'ele')),
      hr: num(tag(body, 'hr')),
      cad: num(tag(body, 'cad')),
      power: num(tag(body, 'power')),
      temp: num(tag(body, 'atemp')),
    });
  }
  const records = recordsFromPoints(points);
  return { records, laps: [], sessions: sessionOf(records) };
}

export function parseTcx(xml: string): FitData {
  const points: TrackPoint[] = [];
  const laps: FitLap[] = [];
  for (const lap of xml.matchAll(/<(?:[\w-]+:)?Lap\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Lap>/g)) {
    // Totaux du tour : avant le premier point
    const head = lap[1].split(/<(?:[\w-]+:)?Track\b/)[0];
    const total_distance = num(tag(head, 'DistanceMeters'));
    const total_timer_time = num(tag(head, 'TotalTimeSeconds'));
    if (total_distance != null && total_timer_time != null) laps.push({ total_distance, total_timer_time });
    for (const tp of lap[1].matchAll(/<(?:[\w-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Trackpoint>/g)) {
      const b = tp[1];
      const hrBlock = b.match(/<(?:[\w-]+:)?HeartRateBpm\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?HeartRateBpm>/)?.[1];
      points.push({
        t: Date.parse(tag(b, 'Time')!),
        lat: num(tag(b, 'LatitudeDegrees')),
        lon: num(tag(b, 'LongitudeDegrees')),
        alt: num(tag(b, 'AltitudeMeters')),
        dist: num(tag(b, 'DistanceMeters')),
        hr: hrBlock ? num(tag(hrBlock, 'Value')) : null,
        cad: num(tag(b, 'RunCadence')) ?? num(tag(b, 'Cadence')),
        power: num(tag(b, 'Watts')),
      });
    }
  }
  const records = recordsFromPoints(points);
  return { records, laps, sessions: sessionOf(records) };
}

/** Flux de l'API Strava (key_by_type=true) */
export interface StravaStreams {
  [type: string]: { data?: unknown[] } | number | undefined;
  /** Départ (secondes epoch), ajouté à l'enregistrement */
  start?: number;
}

/**
 * Streams de l'API Strava (key_by_type=true) : { time, distance, latlng, altitude, heartrate, cadence, watts, temp,
 * moving }, plus `start` (secondes epoch) ajouté à l'enregistrement.
 */
export function parseStreams(streams: StravaStreams): FitData {
  const s = (k: string) => ((streams[k] as { data?: unknown[] } | undefined)?.data ?? null) as any[] | null;
  const time = s('time');
  if (!time?.length) return { records: [], laps: [], sessions: [{}] };
  const start = ((streams.start as number | undefined) ?? 0) * 1000;
  const [dist, ll, alt, hr, cad, watts, temp, moving] = ['distance', 'latlng', 'altitude', 'heartrate', 'cadence', 'watts', 'temp', 'moving'].map(s);
  const points: TrackPoint[] = time.map((t: number, k: number) => ({
    t: start + t * 1000,
    dist: dist?.[k] ?? null,
    lat: ll?.[k]?.[0] ?? null,
    lon: ll?.[k]?.[1] ?? null,
    alt: alt?.[k] ?? null,
    hr: hr?.[k] || null,
    cad: cad?.[k] || null,
    power: watts?.[k] ?? null,
    temp: temp?.[k] ?? null,
    moving: moving ? Boolean(moving[k]) : undefined,
  }));
  const records = recordsFromPoints(points);
  return { records, laps: [], sessions: sessionOf(records) };
}

export type TrackFormat = 'gpx' | 'tcx' | 'json';

/** Tracé selon l'extension du fichier (déjà décompressé) */
export function parseTrack(ext: string, text: string): FitData {
  if (ext === 'gpx') return parseGpx(text);
  if (ext === 'tcx') return parseTcx(text);
  if (ext === 'json') return parseStreams(JSON.parse(text));
  throw new Error(`format de tracé inconnu : ${ext}`);
}
