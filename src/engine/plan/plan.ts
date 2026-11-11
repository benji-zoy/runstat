// Plan d'entraînement rendu par une IA (export « Plan d'entraînement » de l'appli) : lecture du bloc ```runstat-plan```
// (sinon d'un tableau Markdown de même forme), étapes des séances, fusion avec le plan déjà enregistré.
// Fonctions pures, partagées par le NAS (validation, envoi à COROS) et l'appli (import, aperçu).

/** Nature d'une séance, telle que l'IA l'écrit dans la colonne « type » */
export type PlanKind = 'easy' | 'quality' | 'long' | 'race' | 'strength' | 'other';
export const PLAN_KINDS: readonly PlanKind[] = ['easy', 'quality', 'long', 'race', 'strength', 'other'];

export interface PlanSession {
  /** AAAA-MM-JJ */
  date: string;
  kind: PlanKind;
  name: string;
  durationMin?: number;
  distanceKm?: number;
  /** Étapes au format court (« 15' Z1 + 6×(1000 m @ 4:10-4:15 / 2' Z1) + 10' Z1 ») */
  steps?: string;
  /** Phase du plan (« Foncier », « Développement »…) */
  phase?: string;
}

export interface CorosPlanStatus {
  /** Dernier envoi réussi */
  sentAt?: string;
  /** Premier jour du plan COROS (AAAA-MM-JJ) */
  start?: string;
  weeks?: number;
  sessions?: number;
  /** Séances au-delà de 16 semaines, non envoyées (dernière date envoyée) */
  until?: string;
  /** Dernier envoi en échec */
  error?: string;
  errorAt?: string;
}

/** data-raw/plans/<goalId>.json */
export interface TrainingPlan {
  goalId: string;
  importedAt: string;
  sessions: PlanSession[];
  coros?: CorosPlanStatus;
}

export const PLAN_MAX_SESSIONS = 400;

// ---------------------------------------------------------------------------
// Étapes : « 15' Z1 + 6×(1000 m @ 4:10-4:15 / 2' Z1) + 10' Z1 »
// ---------------------------------------------------------------------------

export type StepIntensity =
  | { type: 'zone'; zone: number }
  | { type: 'pace'; from: number; to: number }
  | { type: 'hr'; from: number; to: number };

export interface Step {
  /** Durée (s) ou distance (m) */
  target: { type: 'time'; sec: number } | { type: 'distance'; m: number };
  intensity?: StepIntensity;
}

export type StepPart = { step: Step } | { repeat: number; steps: Step[] };

/** Durée (s) : « 45' », « 45 min », « 1 h 10 », « 1h10 », « 90 s », « 30" », « 1:10:00 » ; null sinon */
export function parseDurationText(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/,/g, '.');
  let m = t.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = t.match(/^(\d+(?:\.\d+)?)\s*h\s*(\d{1,2})?\s*(?:min|mn|')?$/);
  if (m) return Math.round(Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60);
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:'|’|min|mn|minutes?)\s*(\d{1,2})?\s*(?:"|”|s)?$/);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  m = t.match(/^(\d+)\s*(?:"|”|s|sec|secondes?)$/);
  if (m) return Number(m[1]);
  return null;
}

/** Distance (km) : « 11 km », « 11,5 km », « 800 m » ; null sinon */
export function parseDistanceText(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/,/g, '.').replace(/^≈\s*/, '');
  let m = t.match(/^(\d+(?:\.\d+)?)\s*km$/);
  if (m) return Number(m[1]);
  m = t.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (m) return Number(m[1]) / 1000;
  return null;
}

const paceSec = (s: string) => {
  const m = s.match(/^(\d{1,2})[:'’](\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function parseIntensity(s: string): StepIntensity | null {
  const t = s.trim().toLowerCase().replace(/\s*\/\s*km$/, '').replace(/\s+/g, ' ');
  let m = t.match(/^z\s*([1-6])$/);
  if (m) return { type: 'zone', zone: Number(m[1]) };
  m = t.match(/^(?:fc\s*)?(\d{2,3})\s*[-–à]\s*(\d{2,3})\s*(?:bpm)?$/);
  if (m && (t.includes('fc') || t.includes('bpm'))) return { type: 'hr', from: Number(m[1]), to: Number(m[2]) };
  m = t.match(/^(?:fc\s*)?(\d{2,3})\s*(?:bpm)$/) ?? t.match(/^fc\s*(\d{2,3})$/);
  if (m) return { type: 'hr', from: Number(m[1]), to: Number(m[1]) };
  m = t.match(/^(\d{1,2}[:'’]\d{2})\s*[-–à]\s*(\d{1,2}[:'’]\d{2})$/);
  if (m) {
    const [a, b] = [paceSec(m[1])!, paceSec(m[2])!];
    return { type: 'pace', from: Math.min(a, b), to: Math.max(a, b) };
  }
  const one = paceSec(t);
  return one ? { type: 'pace', from: one, to: one } : null;
}

function parseStep(s: string): Step | null {
  const [amount, intensity] = s.split('@').map((x) => x.trim());
  // « 15' Z1 » : l'intensité peut suivre la quantité sans @
  let qty = amount;
  let zone: StepIntensity | null = null;
  const tail = amount.match(/^(.*?)\s+(z\s*[1-6])$/i);
  if (tail) {
    qty = tail[1];
    zone = parseIntensity(tail[2]);
  }
  const sec = parseDurationText(qty);
  const km = sec == null ? parseDistanceText(qty) : null;
  if (sec == null && km == null) return null;
  const step: Step = { target: sec != null ? { type: 'time', sec } : { type: 'distance', m: Math.round(km! * 1000) } };
  const it = intensity ? parseIntensity(intensity) : zone;
  if (intensity && !it) return null;
  if (it) step.intensity = it;
  return step;
}

/** Étapes d'une séance ; null si le texte ne suit pas le format court */
export function parseSteps(text: string): StepPart[] | null {
  const parts: StepPart[] = [];
  // Découpe sur « + » hors parenthèses
  let depth = 0;
  let cur = '';
  const chunks: string[] = [];
  // « 4:10/km » : l'unité gênerait la découpe des répétitions sur « / »
  for (const ch of text.replace(/\s*\/\s*km\b/gi, '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '+' && depth === 0) {
      chunks.push(cur);
      cur = '';
    } else cur += ch;
  }
  chunks.push(cur);
  for (const raw of chunks.map((c) => c.trim()).filter(Boolean)) {
    const group = raw.match(/^(\d{1,2})\s*[×x*]\s*\((.+)\)$/i);
    if (group) {
      const steps = group[2].split('/').map((x) => parseStep(x)).filter((x): x is Step => !!x);
      if (!steps.length || steps.length !== group[2].split('/').length) return null;
      parts.push({ repeat: Math.min(20, Math.max(1, Number(group[1]))), steps });
      continue;
    }
    const step = parseStep(raw);
    if (!step) return null;
    parts.push({ step });
  }
  return parts.length ? parts : null;
}

// ---------------------------------------------------------------------------
// Lecture du plan
// ---------------------------------------------------------------------------

const KIND_WORDS: [RegExp, PlanKind][] = [
  [/^(facile|footing|ef|endurance|r[ée]cup)/i, 'easy'],
  [/^(qualit[ée]|fractionn[ée]|seuil|tempo|vma|intervalles?|sp[ée]cifique|c[ôo]tes?)/i, 'quality'],
  [/^(longue|sortie longue|sl)/i, 'long'],
  [/^(course|comp[ée]tition|objectif|test)/i, 'race'],
  [/^(renfo|renforcement|muscu|gainage|ppg)/i, 'strength'],
  [/^(autre|v[ée]lo|natation|cross)/i, 'other'],
];
const REST = /^(repos|off|rest)\b/i;

function kindOf(s: string): PlanKind | 'rest' | null {
  const t = s.trim();
  if (REST.test(t)) return 'rest';
  return KIND_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** AAAA-MM-JJ ou JJ/MM/AAAA → AAAA-MM-JJ, null sinon */
function dateOf(s: string): string | null {
  const t = s.trim().replace(/\*\*/g, '');
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const fr = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (fr) m = [fr[0], fr[3], fr[2].padStart(2, '0'), fr[1].padStart(2, '0')] as RegExpMatchArray;
  }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const EMPTY = /^[-–—]?$|^(n\/a|aucune?)$/i;

export interface ParsedPlan {
  sessions: PlanSession[];
  /** Lignes de séance non comprises (texte d'origine) */
  ignored: string[];
  /** Jours de repos lus (non enregistrés) */
  rest: number;
  /** Bloc ```runstat-plan``` trouvé (sinon : tableau Markdown) */
  fenced: boolean;
}

/**
 * Lit le plan d'un texte Markdown : le bloc ```runstat-plan``` s'il existe, sinon toutes les lignes de tableau qui commencent
 * par une date. Colonnes : date | type | nom | durée | distance | étapes | phase (les dernières sont facultatives).
 */
export function parsePlanMarkdown(text: string): ParsedPlan {
  const fence = text.match(/```\s*runstat-plan[^\n]*\n([\s\S]*?)```/i);
  const lines = (fence ? fence[1] : text).split(/\r?\n/);
  const sessions: PlanSession[] = [];
  const ignored: string[] = [];
  let rest = 0;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw.includes('|')) continue;
    const cells = raw.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const date = dateOf(cells[0] ?? '');
    if (!date) {
      // En-tête, séparateur ou ligne de texte : ignorés sans bruit, sauf dans le bloc dédié
      if (fence && !/^[-:\s|]+$/.test(raw) && !/^date\b/i.test(cells[0] ?? '')) ignored.push(raw);
      continue;
    }
    const kind = kindOf(cells[1] ?? '');
    if (kind === 'rest') {
      rest++;
      continue;
    }
    const name = (cells[2] ?? '').replace(/\*\*/g, '').trim();
    if (!kind || !name) {
      ignored.push(raw);
      continue;
    }
    const s: PlanSession = { date, kind, name: name.slice(0, 100) };
    const dur = cells[3] && !EMPTY.test(cells[3]) ? parseDurationText(cells[3].replace(/^≈\s*/, '')) : null;
    if (dur) s.durationMin = Math.round(dur / 60);
    const km = cells[4] && !EMPTY.test(cells[4]) ? parseDistanceText(cells[4]) : null;
    if (km) s.distanceKm = Math.round(km * 10) / 10;
    if (cells[5] && !EMPTY.test(cells[5])) s.steps = cells[5].replace(/`/g, '').slice(0, 300);
    if (cells[6] && !EMPTY.test(cells[6])) s.phase = cells[6].replace(/\*\*/g, '').slice(0, 40);
    sessions.push(s);
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { sessions, ignored, rest, fenced: !!fence };
}

/**
 * Nouveau plan importé sur l'ancien : les séances des jours couverts par le nouveau (de sa première à sa dernière date)
 * sont remplacées, les autres gardées. L'état de l'envoi à COROS est conservé.
 */
export function mergePlan(previous: TrainingPlan | null, goalId: string, incoming: PlanSession[], now = new Date()): TrainingPlan {
  const sorted = [...incoming].sort((a, b) => a.date.localeCompare(b.date));
  const from = sorted[0]?.date;
  const to = sorted.at(-1)?.date;
  const kept = (previous?.sessions ?? []).filter((s) => !from || s.date < from || s.date > to!);
  const sessions = [...kept, ...sorted].sort((a, b) => a.date.localeCompare(b.date)).slice(0, PLAN_MAX_SESSIONS);
  return { goalId, importedAt: now.toISOString(), sessions, ...(previous?.coros ? { coros: previous.coros } : {}) };
}
