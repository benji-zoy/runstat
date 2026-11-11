// Validation de la saisie (objectifs, bilans, classements, réglages, sources) : fonctions pures partagées par le NAS
// (scripts/sync/entries.mjs, qui écrit dans data-raw/) et l'appli en mode local-first (core/local-backend.ts).
// Seuls les champs connus sont gardés, jamais de nom d'un autre coureur.
import { ACTIVITY_ID, ACTIVITY_SOURCES, HEALTH_SOURCES } from './sources.ts';
import { PLAN_KINDS, PLAN_MAX_SESSIONS, type TrainingPlan } from './plan/plan.ts';

export class InvalidEntry extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join(' ; '));
    this.errors = errors;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** Fichier de classement rattaché par la date et la distance (data-raw/results/date-AAAA-MM-JJ-<km>.json) */
export const DATE_RESULT = /^date-\d{4}-\d{2}-\d{2}-\d+\.json$/;

/** Accumulateur d'erreurs : chaque lecture renvoie la valeur normalisée ou undefined */
function reader(obj: unknown, prefix: string, errors: string[]) {
  const src = (obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}) as any;
  if (src !== obj) errors.push(`${prefix || 'entrée'} : objet attendu`);
  const fail = (key: string, msg: string): undefined => (errors.push(`${prefix}${key} : ${msg}`), undefined);
  const has = (key: string) => src[key] !== undefined && src[key] !== null && src[key] !== '';
  return {
    has,
    str(key: string, { required = false, max = 200, pattern, msg = 'format invalide' }: { required?: boolean; max?: number; pattern?: RegExp; msg?: string } = {}): string | undefined {
      if (!has(key)) return required ? fail(key, 'obligatoire') : undefined;
      const v = src[key];
      if (typeof v !== 'string') return fail(key, 'texte attendu');
      const s = v.trim();
      if (s.length > max) return fail(key, `${max} caractères au plus`);
      if (pattern && !pattern.test(s)) return fail(key, msg);
      return s;
    },
    num(key: string, { required = false, min = -Infinity, max = Infinity, int = false }: { required?: boolean; min?: number; max?: number; int?: boolean } = {}): number | undefined {
      if (!has(key)) return required ? fail(key, 'obligatoire') : undefined;
      const v = src[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(key, 'nombre attendu');
      if (int && !Number.isInteger(v)) return fail(key, 'nombre entier attendu');
      if (v < min || v > max) return fail(key, `entre ${min} et ${max}`);
      return v;
    },
    oneOf<T>(key: string, values: readonly T[], { required = false }: { required?: boolean } = {}): T | undefined {
      if (!has(key)) return required ? fail(key, 'obligatoire') : undefined;
      return values.includes(src[key]) ? src[key] : fail(key, `valeurs possibles : ${values.join(', ')}`);
    },
    bool(key: string): boolean | undefined {
      if (!has(key)) return undefined;
      return typeof src[key] === 'boolean' ? src[key] : fail(key, 'vrai ou faux attendu');
    },
    raw: (key: string): any => src[key],
    unknown: (known: string[]) => {
      for (const k of Object.keys(src)) if (!known.includes(k)) fail(k, 'champ inconnu');
    },
  };
}

/** Garde les seules valeurs définies, dans l'ordre des clés */
const clean = (o: Record<string, unknown>): any => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const isRealDate = (s: string) => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

function validateDebrief(obj: unknown, prefix: string, errors: string[]) {
  const r = reader(obj, prefix, errors);
  r.unknown(['chipSec', 'gelsKm', 'notes']);
  const out: any = { chipSec: r.num('chipSec', { min: 60, max: 72 * 3600, int: true }) };
  const gels = r.raw('gelsKm');
  if (gels != null) {
    if (!Array.isArray(gels) || gels.length > 40 || gels.some((k) => typeof k !== 'number' || !(k >= 0 && k <= 500)))
      errors.push(`${prefix}gelsKm : liste de km (0 à 500) attendue`);
    else if (gels.length) out.gelsKm = [...gels].sort((a, b) => a - b);
  }
  const notes = r.raw('notes');
  if (notes != null) {
    if (!Array.isArray(notes) || notes.length > 30 || notes.some((n) => typeof n !== 'string' || n.length > 500))
      errors.push(`${prefix}notes : 30 notes de 500 caractères au plus`);
    else {
      const kept = notes.map((n) => n.trim()).filter(Boolean);
      if (kept.length) out.notes = kept;
    }
  }
  const res = clean(out);
  return Object.keys(res).length ? res : undefined;
}

/** Points d'altitude d'un profil au plus (core/course.ts en garde 1 000) */
const MAX_COURSE_POINTS = 1500;

/** Profil compact d'un tracé GPX : altitude tous les `stepKm`, points de passage nommés ; aucune coordonnée */
function validateCourse(obj: unknown, prefix: string, errors: string[]) {
  const r = reader(obj, prefix, errors);
  r.unknown(['stepKm', 'ele', 'waypoints', 'file']);
  const stepKm = r.num('stepKm', { required: true, min: 0.01, max: 1 });
  const ele = r.raw('ele');
  if (!Array.isArray(ele) || ele.length < 2 || ele.length > MAX_COURSE_POINTS || ele.some((z) => typeof z !== 'number' || !(z >= -500 && z <= 9000)))
    errors.push(`${prefix}ele : 2 à ${MAX_COURSE_POINTS} altitudes (−500 à 9 000 m) attendues`);
  const length = Array.isArray(ele) && stepKm ? stepKm * (ele.length - 1) : 0;
  let waypoints: { name: string; km: number }[] | undefined;
  const wps = r.raw('waypoints');
  if (wps != null) {
    if (!Array.isArray(wps) || wps.length > 80) errors.push(`${prefix}waypoints : 80 points au plus`);
    else {
      waypoints = wps.map((w, i) => {
        const wr = reader(w, `${prefix}waypoints ${i + 1} · `, errors);
        wr.unknown(['name', 'km']);
        return clean({ name: wr.str('name', { required: true, max: 60 }), km: wr.num('km', { required: true, min: 0, max: Math.max(0, length + 0.5) }) });
      });
    }
  }
  return clean({
    stepKm,
    ele: Array.isArray(ele) ? ele.map((z) => Math.round(z)) : undefined,
    waypoints: waypoints?.length ? waypoints : undefined,
    file: r.str('file', { max: 120 }),
  });
}

/** Un objectif (data-raw/goals.json) */
export function validateGoal(obj: unknown, prefix = '', errors: string[] = []) {
  const r = reader(obj, prefix, errors);
  r.unknown(['id', 'name', 'date', 'startTime', 'distanceKm', 'elevGain', 'elevLoss', 'targetSec', 'stretchSec', 'kind', 'lat', 'lon', 'debrief', 'course', 'parent', 'cycle']);
  const date = r.str('date', { required: true, pattern: DATE, msg: 'date AAAA-MM-JJ attendue' });
  if (date && !isRealDate(date)) errors.push(`${prefix}date : date inexistante`);
  const goal = clean({
    id: r.str('id', { required: true, pattern: GOAL_ID, msg: 'minuscules, chiffres et tirets' }),
    name: r.str('name', { required: true, max: 80 }),
    date,
    startTime: r.str('startTime', { pattern: TIME, msg: 'heure HH:MM attendue' }),
    distanceKm: r.num('distanceKm', { required: true, min: 0.4, max: 500 }),
    elevGain: r.num('elevGain', { min: 0, max: 30000, int: true }),
    elevLoss: r.num('elevLoss', { min: 0, max: 30000, int: true }),
    targetSec: r.num('targetSec', { min: 60, max: 72 * 3600, int: true }),
    stretchSec: r.num('stretchSec', { min: 60, max: 72 * 3600, int: true }),
    kind: r.oneOf('kind', ['road', 'trail'], { required: true }),
    lat: r.num('lat', { min: -90, max: 90 }),
    lon: r.num('lon', { min: -180, max: 180 }),
    debrief: r.has('debrief') ? validateDebrief(r.raw('debrief'), `${prefix}debrief.`, errors) : undefined,
    course: r.has('course') ? validateCourse(r.raw('course'), `${prefix}course.`, errors) : undefined,
    // Objectif secondaire : identifiant de l'objectif principal qu'il prépare
    parent: r.str('parent', { pattern: GOAL_ID, msg: 'identifiant d’objectif attendu' }),
    // Test de fin d'un cycle d'entraînement (cycles.json)
    cycle: r.str('cycle', { pattern: GOAL_ID, msg: 'identifiant de cycle attendu' }),
  });
  if (goal.stretchSec != null && goal.targetSec == null) errors.push(`${prefix}stretchSec : chrono visé manquant`);
  if (goal.stretchSec != null && goal.targetSec != null && goal.stretchSec >= goal.targetSec)
    errors.push(`${prefix}stretchSec : doit être plus rapide que le chrono visé`);
  if ((goal.lat == null) !== (goal.lon == null)) errors.push(`${prefix}lat/lon : renseigner les deux ou aucun`);
  return goal;
}

/** Liste complète des objectifs, identifiants uniques */
export function validateGoals(list: unknown) {
  const errors: string[] = [];
  if (!Array.isArray(list)) throw new InvalidEntry(['liste d’objectifs attendue']);
  if (list.length > 100) throw new InvalidEntry(['100 objectifs au plus']);
  const goals = list.map((g, i) => validateGoal(g, `objectif ${i + 1} · `, errors));
  const ids = goals.map((g) => g.id).filter(Boolean);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`identifiant en double : ${dup}`);
  const byId = new Map(goals.map((g) => [g.id, g]));
  goals.forEach((g, i) => {
    if (!g.parent) return;
    const main = byId.get(g.parent);
    if (!main || main.id === g.id) errors.push(`objectif ${i + 1} · parent : objectif principal introuvable`);
    else if (main.parent) errors.push(`objectif ${i + 1} · parent : l’objectif principal est lui-même secondaire`);
    else if (g.date && main.date && g.date >= main.date) errors.push(`objectif ${i + 1} · parent : doit avoir lieu avant l’objectif principal`);
  });
  if (errors.length) throw new InvalidEntry(errors);
  return goals;
}

/** Réglages de l'athlète (data-raw/athlete.json) */
export function validateAthlete(obj: unknown) {
  const errors: string[] = [];
  const r = reader(obj, '', errors);
  r.unknown(['hrMax', 'hrRest', 'lt1Hr', 'lt2Hr', 'sex', 'weightKg', 'heightCm', 'birthday', 'homeCity', 'raceWeights']);
  const birthday = r.str('birthday', { required: true, pattern: DATE, msg: 'date AAAA-MM-JJ attendue' });
  if (birthday && !isRealDate(birthday)) errors.push('birthday : date inexistante');
  const athlete = clean({
    hrMax: r.num('hrMax', { required: true, min: 120, max: 230, int: true }),
    hrRest: r.num('hrRest', { required: true, min: 25, max: 110, int: true }),
    // Seuils ventilatoires (build-fit : zones), sinon 80 % et 89 % de la FC max
    lt1Hr: r.num('lt1Hr', { min: 80, max: 230, int: true }),
    lt2Hr: r.num('lt2Hr', { min: 80, max: 230, int: true }),
    sex: r.oneOf('sex', ['M', 'F'], { required: true }),
    weightKg: r.num('weightKg', { required: true, min: 25, max: 250 }),
    heightCm: r.num('heightCm', { required: true, min: 100, max: 250, int: true }),
    birthday,
    // Ville de départ des trajets des équivalences (liste de core/equivalences.ts, Paris si inconnue)
    homeCity: r.str('homeCity', { max: 40 }),
  });
  if (athlete.hrMax != null && athlete.hrRest != null && athlete.hrRest >= athlete.hrMax - 40)
    errors.push('hrRest : trop proche de la FC max');
  const { hrRest, lt1Hr, lt2Hr, hrMax } = athlete;
  if ((lt1Hr != null && (lt1Hr <= hrRest || lt1Hr >= hrMax)) || (lt2Hr != null && (lt2Hr <= (lt1Hr ?? hrRest) || lt2Hr >= hrMax)))
    errors.push('seuils : FC repos < seuil 1 < seuil 2 < FC max');
  const weights = r.raw('raceWeights');
  if (weights != null) {
    const entries = typeof weights === 'object' && !Array.isArray(weights) ? Object.entries(weights) : null;
    if (!entries || entries.some(([id, w]) => !ACTIVITY_ID.test(id) || typeof w !== 'number' || w < 0 || w > 3))
      errors.push('raceWeights : { "<identifiant de sortie>": poids de 0 à 3 } attendu');
    else if (entries.length) athlete.raceWeights = Object.fromEntries(entries);
  }
  if (errors.length) throw new InvalidEntry(errors);
  return athlete;
}

/** Sources de l'instance (data-raw/sources.json) : une source d'activités, une source de santé ou aucune */
export function validateSources(obj: unknown) {
  const errors: string[] = [];
  const r = reader(obj, '', errors);
  r.unknown(['activities', 'health']);
  const sources = {
    activities: r.oneOf('activities', ACTIVITY_SOURCES, { required: true }),
    health: r.oneOf('health', HEALTH_SOURCES, { required: true }),
  };
  if (errors.length) throw new InvalidEntry(errors);
  return sources;
}

/** Classement officiel d'une course (data-raw/results/<activityId>.json) : effectifs seulement, aucun nom */
export function validateResult(activityId: string, obj: unknown, today = new Date().toISOString().slice(0, 10)) {
  const errors: string[] = [];
  if (!ACTIVITY_ID.test(activityId)) throw new InvalidEntry(['identifiant de sortie invalide']);
  const r = reader(obj, '', errors);
  r.unknown([
    'event', 'course', 'distanceKm', 'elevGain', 'officialSec', 'gunSec', 'rank', 'finishers', 'sex', 'sexRank', 'sexCount',
    'category', 'catRank', 'catCount', 'label', 'source', 'timing', 'fetchedAt', 'note', 'pending', 'activityId', 'file',
  ]);
  const count = (key: string) => r.num(key, { min: 1, max: 1_000_000, int: true }) ?? null;
  const res: any = {
    activityId,
    event: r.str('event', { required: true, max: 120 }),
    course: r.str('course', { max: 80 }) ?? null,
    distanceKm: r.num('distanceKm', { min: 0.4, max: 500 }) ?? null,
    elevGain: r.num('elevGain', { min: 0, max: 30000, int: true }) ?? null,
    officialSec: r.num('officialSec', { min: 60, max: 72 * 3600, int: true }) ?? null,
    gunSec: r.num('gunSec', { min: 60, max: 72 * 3600, int: true }) ?? null,
    rank: count('rank'),
    finishers: count('finishers'),
    sex: r.oneOf('sex', ['M', 'F']) ?? null,
    sexRank: count('sexRank'),
    sexCount: count('sexCount'),
    category: r.str('category', { max: 30 }) ?? null,
    catRank: count('catRank'),
    catCount: count('catCount'),
    label: r.str('label', { max: 60 }) ?? null,
    // Facultative : une course déclarée sans page de résultats en ligne
    source: r.str('source', { max: 500, pattern: /^https?:\/\/\S+$/, msg: 'adresse http(s) attendue' }) ?? null,
    timing: r.str('timing', { max: 120 }) ?? null,
    fetchedAt: r.str('fetchedAt', { pattern: DATE, msg: 'date AAAA-MM-JJ attendue' }) ?? today,
    note: r.str('note', { max: 1000 }) ?? null,
  };
  if (r.bool('pending')) res.pending = true;
  if (r.raw('activityId') != null && r.raw('activityId') !== activityId) errors.push('activityId : ne correspond pas à l’adresse');
  for (const [rank, total] of [['rank', 'finishers'], ['sexRank', 'sexCount'], ['catRank', 'catCount']]) {
    if (res[rank] != null && res[total] != null && res[rank] > res[total]) errors.push(`${rank} : plus grand que ${total}`);
  }
  if (res.sexCount != null && res.finishers != null && res.sexCount > res.finishers) errors.push('sexCount : plus grand que finishers');
  if (errors.length) throw new InvalidEntry(errors);
  return res;
}

/** Plan d'entraînement importé (data-raw/plans/<goalId>.json) */
export function validatePlan(goalId: string, obj: unknown): TrainingPlan {
  const errors: string[] = [];
  if (!GOAL_ID.test(goalId)) throw new InvalidEntry(['identifiant d’objectif invalide']);
  const r = reader(obj, '', errors);
  r.unknown(['goalId', 'importedAt', 'sessions', 'coros']);
  if (r.raw('goalId') != null && r.raw('goalId') !== goalId) errors.push('goalId : ne correspond pas à l’adresse');
  const importedAt = r.str('importedAt', { required: true, max: 40, pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, msg: 'date ISO attendue' });
  const list = r.raw('sessions');
  const sessions: any[] = [];
  if (!Array.isArray(list) || list.length > PLAN_MAX_SESSIONS) errors.push(`sessions : ${PLAN_MAX_SESSIONS} séances au plus`);
  else
    list.forEach((s, i) => {
      const p = `séance ${i + 1} · `;
      const sr = reader(s, p, errors);
      sr.unknown(['date', 'kind', 'name', 'durationMin', 'distanceKm', 'steps', 'phase']);
      const date = sr.str('date', { required: true, pattern: DATE, msg: 'date AAAA-MM-JJ attendue' });
      if (date && !isRealDate(date)) errors.push(`${p}date : date inexistante`);
      sessions.push(
        clean({
          date,
          kind: sr.oneOf('kind', PLAN_KINDS, { required: true }),
          name: sr.str('name', { required: true, max: 100 }),
          durationMin: sr.num('durationMin', { min: 1, max: 72 * 60, int: true }),
          distanceKm: sr.num('distanceKm', { min: 0.1, max: 500 }),
          steps: sr.str('steps', { max: 300 }),
          phase: sr.str('phase', { max: 40 }),
        }),
      );
    });
  let coros: any;
  if (r.has('coros')) {
    const cr = reader(r.raw('coros'), 'coros.', errors);
    cr.unknown(['sentAt', 'start', 'weeks', 'sessions', 'until', 'error', 'errorAt']);
    coros = clean({
      sentAt: cr.str('sentAt', { max: 40 }),
      start: cr.str('start', { pattern: DATE }),
      weeks: cr.num('weeks', { min: 1, max: 16, int: true }),
      sessions: cr.num('sessions', { min: 0, max: PLAN_MAX_SESSIONS, int: true }),
      until: cr.str('until', { pattern: DATE }),
      error: cr.str('error', { max: 500 }),
      errorAt: cr.str('errorAt', { max: 40 }),
    });
  }
  if (errors.length) throw new InvalidEntry(errors);
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return clean({ goalId, importedAt, sessions, coros });
}

/** Buts d'un cycle d'entraînement sans course */
export const CYCLE_FOCUS = ['restart', 'endurance', 'speed', 'maintain', 'trail'] as const;
export type CycleFocus = (typeof CYCLE_FOCUS)[number];

/** Cycles d'entraînement sans course (data-raw/cycles.json) : 4 à 16 semaines, comme un plan COROS */
export function validateCycles(list: unknown, goalIds: string[] = []) {
  const errors: string[] = [];
  if (!Array.isArray(list)) throw new InvalidEntry(['liste de cycles attendue']);
  if (list.length > 100) throw new InvalidEntry(['100 cycles au plus']);
  const cycles = list.map((c, i) => {
    const p = `cycle ${i + 1} · `;
    const r = reader(c, p, errors);
    r.unknown(['id', 'name', 'focus', 'start', 'weeks', 'previous']);
    const start = r.str('start', { required: true, pattern: DATE, msg: 'date AAAA-MM-JJ attendue' });
    if (start && !isRealDate(start)) errors.push(`${p}start : date inexistante`);
    return clean({
      id: r.str('id', { required: true, pattern: GOAL_ID, msg: 'minuscules, chiffres et tirets' }),
      name: r.str('name', { required: true, max: 80 }),
      focus: r.oneOf('focus', CYCLE_FOCUS, { required: true }),
      start,
      weeks: r.num('weeks', { required: true, min: 4, max: 16, int: true }),
      previous: r.str('previous', { pattern: GOAL_ID }),
    });
  });
  const ids = cycles.map((c) => c.id).filter(Boolean);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i || goalIds.includes(id));
  if (dup) errors.push(`identifiant en double : ${dup}`);
  if (errors.length) throw new InvalidEntry(errors);
  return cycles as { id: string; name: string; focus: CycleFocus; start: string; weeks: number; previous?: string }[];
}
