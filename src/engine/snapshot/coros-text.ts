// Fichiers texte COROS de data-raw/ (sorties brutes du MCP) : liste des activités, forme, charge.

/** "1:02:03" | "37:40" -> secondes */
export function toSeconds(hms: string): number {
  return hms.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

/** Les fichiers d'outils MCP sont parfois une chaîne JSON encodée. */
export function rawText(text: string): string {
  const t = text.trim();
  return t.startsWith('"') ? JSON.parse(t) : t;
}

export const SPORTS: Record<number, string> = { 100: 'road', 101: 'indoor', 102: 'trail', 103: 'track' };

/** Activité de base lue dans records.txt */
export interface CorosRecord {
  id: string;
  source: 'coros';
  sportType: number;
  kind: string;
  date: string;
  name: string;
  start: number | null;
  durationSec: number;
  distanceKm: number;
  avgHr: number | null;
  calories: number | null;
  lat: number | null;
  lon: number | null;
}

/** records.txt (querySportRecords) → activités */
export function parseRecords(text: string): CorosRecord[] {
  const blocks = text.split(/\n\s*\n/).filter((b) => /LabelId:/.test(b));
  return blocks.map((b) => {
    const head = b.match(/^\s*\d+\.\s+(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})/m)!;
    const name = b.match(/Location:\s*(.*)/)?.[1].trim() ?? '';
    const coords = b.match(/Start Coordinates:\s*([-\d.]+),\s*([-\d.]+)/);
    const ts = b.match(/startTimestamp=(\d+)\s*\|\s*endTimestamp=(\d+)/);
    const dur = b.match(/Duration:\s*([\d:]+)/)![1];
    const dist = b.match(/Distance:\s*([\d.]+)\s*(km|m)\b/)!;
    const hr = b.match(/Avg HR:\s*(\d+)/);
    const cal = b.match(/Calories:\s*(\d+)/);
    const id = b.match(/LabelId:\s*(\d+)/)![1];
    const sportType = Number(b.match(/SportType:\s*(\d+)/)![1]);
    const distanceKm = dist[2] === 'm' ? Number(dist[1]) / 1000 : Number(dist[1]);
    return {
      id,
      source: 'coros',
      sportType,
      kind: SPORTS[sportType] ?? 'other',
      date: head[2],
      name,
      start: ts ? Number(ts[1]) : null,
      durationSec: toSeconds(dur),
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      avgHr: hr ? Number(hr[1]) : null,
      calories: cal ? Number(cal[1]) : null,
      lat: coords ? Number(coords[1]) : null,
      lon: coords ? Number(coords[2]) : null,
    };
  });
}

export interface Fitness {
  vo2max: number | null;
  runningLevel: number | null;
  thresholdPace: string | null;
  predictions: Record<'5K' | '10K' | 'Semi' | 'Marathon', string | null>;
}

/** fitness.txt (queryFitnessAssessmentOverview) */
export function parseFitness(text: string): Fitness {
  const get = (label: string) => text.match(new RegExp(`^${label}:\\s*([^\\n]+)`, 'm'))?.[1].trim() ?? null;
  return {
    vo2max: Number(get('VO2max')) || null,
    runningLevel: Number(get('Running Level')) || null,
    thresholdPace: get('Threshold Pace')?.replace(/\s*\/km/, '') ?? null,
    predictions: {
      '5K': get('5 km Prediction'),
      '10K': get('10 km Prediction'),
      Semi: get('Half Marathon Prediction'),
      Marathon: get('Marathon Prediction'),
    },
  };
}

export interface LoadDay {
  date: string;
  comment: string | null;
  shortTerm: number;
  longTerm: number;
  ratio: number;
}

/** load.txt (queryTrainingLoadAssessment, historique fusionné) */
export function parseLoad(text: string): LoadDay[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => {
      const date = b.match(/^(\d{4}-\d{2}-\d{2})/m)?.[1];
      if (!date) return null;
      const num = (label: string) => Number(b.match(new RegExp(`${label}:\\s*([\\d.]+)`))?.[1]);
      return {
        date,
        comment: b.match(/Comment:\s*(.+)/)?.[1].trim() ?? null,
        shortTerm: num('Short-Term Load'),
        longTerm: num('Long-Term Load'),
        ratio: num('Load Ratio'),
      };
    })
    .filter((x): x is LoadDay => Boolean(x))
    .sort((a, b) => a.date.localeCompare(b.date));
}
