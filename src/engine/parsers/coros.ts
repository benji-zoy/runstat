// Lecture des réponses texte du MCP COROS (pensées pour un LLM) vers les fichiers de data-raw/.
// Fonctions pures, testées par scripts/sync/sync.test.mjs.
export { isFitFile } from '../fit/parse-fit.ts';

/** Le texte d'un outil est souvent une chaîne JSON encodée ("…\n…") */
export function unwrap(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t.startsWith('"')) return t;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export interface RecordBlock {
  id: string;
  sportType: number;
  date: string | null;
  start: number;
  block: string;
}

/** Blocs d'activité de querySportRecords (même format que data-raw/records.txt) */
export function recordBlocks(text: string): RecordBlock[] {
  return unwrap(text)
    .split(/\n\s*\n/)
    .filter((b) => /LabelId:\s*\d+/.test(b))
    .map((b) => {
      const block = b.replace(/^\n+|\s+$/g, '');
      return {
        id: block.match(/LabelId:\s*(\d+)/)![1],
        sportType: Number(block.match(/SportType:\s*(\d+)/)?.[1]),
        date: block.match(/—\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
        start: Number(block.match(/startTimestamp=(\d+)/)?.[1] ?? 0),
        block,
      };
    });
}

/**
 * Fusionne les activités récentes dans records.txt. Les activités de la fenêtre [from, to] absentes
 * de la réponse ont été supprimées dans COROS et sont retirées (sauf si la réponse a pu être tronquée).
 */
export function mergeRecords(
  existingText: string | null | undefined,
  fetchedText: string,
  { from, to, truncated = false }: { from: string; to: string; truncated?: boolean },
): { text: string; added: RecordBlock[]; removed: RecordBlock[] } {
  const byId = new Map(recordBlocks(existingText ?? '').map((r) => [r.id, r]));
  const fetched = recordBlocks(fetchedText);
  const added = fetched.filter((r) => !byId.has(r.id));
  const removed: RecordBlock[] = [];
  if (!truncated) {
    const seen = new Set(fetched.map((r) => r.id));
    for (const [id, r] of byId) {
      if (r.date! >= from && r.date! <= to && !seen.has(id)) (byId.delete(id), removed.push(r));
    }
  }
  for (const r of fetched) byId.set(r.id, r);
  const all = [...byId.values()].sort((a, b) => b.start - a.start || b.id.localeCompare(a.id));
  const body = all.map((r, i) => r.block.replace(/^\s*\d+\./, `${i + 1}.`)).join('\n\n');
  const dates = all
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  const head = `Sport Records — ${dates[0] ?? '?'} to ${dates.at(-1) ?? '?'} (${all.length} records)`;
  return { text: `${head}\n========================\n\n${body}\n`, added, removed };
}

const field = (text: string, label: string): string | null =>
  text.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
const number = (v: string | null | undefined): number | null => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Ligne de data-raw/details/*.jsonl */
export interface ActivityDetail {
  id: string;
  elevGain: number | null;
  elevLoss: number | null;
  cadence: number | null;
  stride: number | null;
  power: number | null;
  trainingLoad: number | null;
  aerobicTE: number | null;
  anaerobicTE: number | null;
  focus: string | null;
  bestKm: string | null;
}

/** getActivityDetail → ligne de data-raw/details/*.jsonl */
export function parseDetail(id: string | number, text: string): ActivityDetail {
  const t = unwrap(text);
  const elev = field(t, 'Elevation Gain / Loss')?.match(/(-?[\d.]+)\s*m\s*\/\s*(-?[\d.]+)\s*m/);
  return {
    id: String(id),
    elevGain: elev ? number(elev[1]) : null,
    elevLoss: elev ? number(elev[2]) : null,
    cadence: number(field(t, 'Average Cadence')),
    stride: number(field(t, 'Average Stride Length')),
    power: number(field(t, 'Average Power')),
    trainingLoad: number(field(t, 'Training Load')),
    aerobicTE: number(field(t, 'Aerobic TE')),
    anaerobicTE: number(field(t, 'Anaerobic TE')),
    focus: field(t, 'Training Focus'),
    bestKm: field(t, 'Best Kilometer')?.match(/\d+:\d{2}(?::\d{2})?/)?.[0] ?? null,
  };
}

/** Un détail exploitable contient au moins la charge ou la cadence */
export const isUsableDetail = (d: ActivityDetail): boolean => d.trainingLoad != null || d.cadence != null || d.focus != null;

/** Blocs datés (queryTrainingLoadAssessment) fusionnés par date : l'historique dépasse les 31 jours renvoyés */
export function mergeLoad(existingText: string | null | undefined, fetchedText: string): string {
  const blocks = (text: string) =>
    unwrap(text)
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => /^\d{4}-\d{2}-\d{2}/.test(b));
  const byDate = new Map(blocks(existingText ?? '').map((b) => [b.slice(0, 10), b]));
  for (const b of blocks(fetchedText)) byDate.set(b.slice(0, 10), b);
  const body = [...byDate.keys()]
    .sort()
    .reverse()
    .map((d) => byDate.get(d))
    .join('\n\n');
  return `Training Load Assessment\n========================\n\n${body}\n`;
}

/** Message de quota FIT atteint (texte, sans code d'erreur) */
export const isFitQuota = (text: string): boolean => /daily limit|limit of \d+ .*fit/i.test(unwrap(text));

/** URL de fichiers FIT dans la réponse de queryActivityFitFileDownloadUrls */
export const fitUrls = (text: string): string[] => [...new Set(unwrap(text).match(/https:\/\/[^\s"'<>)\]]+/g) ?? [])];

/** Séance prévue au calendrier (COROS : queryTrainingSchedule) → data-raw/planned.json */
export interface PlannedSession {
  /** AAAA-MM-JJ, fuseau de la montre */
  date: string;
  name: string;
  distanceKm: number | null;
  durationSec: number | null;
  /** Charge estimée (TL COROS, même échelle que trainingLoad) */
  load: number | null;
  /** Séance d'un plan d'entraînement plutôt qu'isolée */
  fromPlan?: boolean;
}

/** Fichier data-raw/planned.json : calendrier remplacé à chaque synchro (il change d'un jour à l'autre) */
export interface PlannedFile {
  source: 'coros';
  fetchedAt: string;
  /** Fenêtre demandée (AAAA-MM-JJ) : un jour sans séance dans cette fenêtre est un jour de repos */
  from: string;
  to: string;
  sessions: PlannedSession[];
}

const SCHEDULE_META =
  /^(Standalone workout|Training plan|From training plan|Workout from|To view|To reschedule)\b|^(Plan ID|Plan name|Plan|idInPlan|Distance|Estimated Time|Duration|Load|Sport( type)?|Workout ID)\s*:/i;

/** h:mm:ss ou mm:ss → secondes */
const clockSec = (s: string | undefined): number | null => {
  const p = s?.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!p) return null;
  return p[3] != null ? +p[1] * 3600 + +p[2] * 60 + +p[3] : +p[1] * 60 + +p[2];
};

/**
 * Calendrier texte de queryTrainingSchedule : blocs séparés par une ligne vide, chacun ouvert par la date
 * (« 2026-11-14 ») puis le nom de la séance ; un bloc sans date reprend la précédente (plusieurs séances le même jour).
 */
export function parseSchedule(text: string): PlannedSession[] {
  const out: PlannedSession[] = [];
  let date: string | null = null;
  for (const block of unwrap(text).split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = lines[0].match(/^(\d{4}-\d{2}-\d{2})\b/);
    if (head) (date = head[1]), lines.shift();
    if (!date || !lines.length) continue;
    const field = (name: string) => lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))?.slice(name.length + 1).trim();
    const name = lines.find((l) => !SCHEDULE_META.test(l) && !/^=+$/.test(l));
    const dist = field('Distance')?.match(/([\d.]+)\s*(km|m)\b/i);
    const load = field('Load')?.match(/[\d.]+/)?.[0];
    if (!name && !dist && !load) continue;
    out.push({
      date,
      name: (name ?? 'Séance').slice(0, 120),
      distanceKm: dist ? Math.round((dist[2].toLowerCase() === 'm' ? +dist[1] / 1000 : +dist[1]) * 100) / 100 : null,
      durationSec: clockSec(field('Estimated Time') ?? field('Duration')),
      load: load != null ? Math.round(+load) : null,
      ...(lines.some((l) => /plan id|training plan/i.test(l) && !/^Standalone/i.test(l)) ? { fromPlan: true } : {}),
    });
  }
  return out;
}
