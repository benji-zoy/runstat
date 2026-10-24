// Santé COROS (réponses texte du MCP) → jours de santé au format de data-raw/health.json, comme healthFromGoogle.
// Le sommeil est rattaché à la date du réveil (convention COROS et Google). Fonctions pures, testées par
// scripts/sync/strava.test.mjs sur des réponses au format réel (scripts/sync/fixtures/coros-health/).
import { unwrap } from './coros.ts';
import type { HealthData, HealthDay } from './google.ts';

const round1 = (v: number) => Math.round(v * 10) / 10;
const isoDate = (s: string) => (s.includes('-') ? s : `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);

/** « 6h 44min » | « 38 min » | « 1h 0min » → minutes */
export function minutes(text: string | null | undefined): number | null {
  const m = String(text ?? '').match(/^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*min)?\s*$/);
  if (!m || (m[1] == null && m[2] == null)) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/**
 * queryDailyHealthData : blocs « --- AAAAMMJJ --- », sommeil sous deux mises en page
 * (« Sleep Summary: (Score: 76) / Total | Awake / Deep | Light | REM », ou tout sur une ligne sans score).
 * @returns { [date]: { sleepMin, sleepMain?, awakeMin, deepMin, remPct, sleepScore? } }
 */
export function parseDailyHealth(text: string): Record<string, HealthDay> {
  const days: Record<string, HealthDay> = {};
  for (const block of unwrap(text).split(/^---\s*/m).slice(1)) {
    const date = block.match(/^(\d{8})\s*---/)?.[1];
    const sleep = block.split(/Sleep Summary:/)[1];
    if (!date || !sleep) continue;
    const field = (label: string) => minutes(sleep.match(new RegExp(`${label}:\\s*([^|\\n]+)`))?.[1]);
    const total = field('Total');
    if (!total) continue;
    const d: HealthDay = { sleepMin: total };
    const score = Number(sleep.match(/^\s*\(Score:\s*(\d+)\)/)?.[1]);
    // Avec un score : nuit principale ; sans score, COROS n'a retenu qu'une sieste ou un bout de nuit
    if (score) (d.sleepMain = total), (d.sleepScore = score);
    const awake = field('Awake');
    const deep = field('Deep');
    const rem = field('REM');
    if (awake != null) d.awakeMin = awake;
    if (deep != null) d.deepMin = deep;
    if (rem != null) d.remPct = round1((rem / total) * 100);
    days[isoDate(date)] = d;
  }
  return days;
}

/** querySleepHrv : évaluation officielle « AAAA-MM-JJ: / HRV Avg: 79 ms » (les séries brutes sont ignorées) */
export function parseSleepHrv(text: string): Record<string, number> {
  const t = unwrap(text);
  const assessment = t.split(/Sleep HRV Time Series/)[0];
  const out: Record<string, number> = {};
  for (const m of assessment.matchAll(/^\s*(\d{4}-\d{2}-\d{2}):\s*\n\s*HRV Avg:\s*(\d+(?:\.\d+)?)\s*ms/gm)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** queryRestingHeartRate : « AAAA-MM-JJ: 60 bpm » ou « No data » */
export function parseRestingHr(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of unwrap(text).matchAll(/^\s*(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/gm)) out[m[1]] = Number(m[2]);
  return out;
}

/**
 * @param daily  textes de queryDailyHealthData
 * @param hrv    textes de querySleepHrv (fenêtres de 7 jours)
 * @param rhr    textes de queryRestingHeartRate
 * @returns { days, weight: [] } (COROS ne donne pas le poids)
 */
export function healthFromCoros({ daily = [], hrv = [], rhr = [] }: { daily?: string[]; hrv?: string[]; rhr?: string[] }): HealthData {
  const days: Record<string, HealthDay> = {};
  const put = (date: string, patch: HealthDay) => (days[date] = { ...days[date], ...patch });
  for (const t of daily) for (const [date, d] of Object.entries(parseDailyHealth(t))) put(date, d);
  for (const t of hrv) for (const [date, v] of Object.entries(parseSleepHrv(t))) put(date, { hrv: v });
  for (const t of rhr) for (const [date, v] of Object.entries(parseRestingHr(t))) put(date, { rhr: v });
  return { days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))), weight: [] };
}
