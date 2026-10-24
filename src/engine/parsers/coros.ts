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
