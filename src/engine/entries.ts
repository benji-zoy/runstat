// Validation de la saisie (objectifs, bilans, classements, réglages, sources) : fonctions pures partagées par le NAS
// (scripts/sync/entries.mjs, qui écrit dans data-raw/) et l'appli en mode local-first (core/local-backend.ts).
// Seuls les champs connus sont gardés, jamais de nom d'un autre coureur.
import { ACTIVITY_ID, ACTIVITY_SOURCES, HEALTH_SOURCES } from './sources.ts';

export class InvalidEntry extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join(' ; '));
    this.errors = errors;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
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

/** Un objectif (data-raw/goals.json) */
export function validateGoal(obj: unknown, prefix = '', errors: string[] = []) {
  const r = reader(obj, prefix, errors);
  r.unknown(['id', 'name', 'date', 'startTime', 'distanceKm', 'elevGain', 'targetSec', 'stretchSec', 'kind', 'lat', 'lon', 'debrief']);
  const date = r.str('date', { required: true, pattern: DATE, msg: 'date AAAA-MM-JJ attendue' });
  if (date && !isRealDate(date)) errors.push(`${prefix}date : date inexistante`);
  const goal = clean({
    id: r.str('id', { required: true, pattern: GOAL_ID, msg: 'minuscules, chiffres et tirets' }),
    name: r.str('name', { required: true, max: 80 }),
    date,
    startTime: r.str('startTime', { pattern: TIME, msg: 'heure HH:MM attendue' }),
    distanceKm: r.num('distanceKm', { required: true, min: 0.4, max: 500 }),
    elevGain: r.num('elevGain', { min: 0, max: 30000, int: true }),
    targetSec: r.num('targetSec', { min: 60, max: 72 * 3600, int: true }),
    stretchSec: r.num('stretchSec', { min: 60, max: 72 * 3600, int: true }),
    kind: r.oneOf('kind', ['road', 'trail'], { required: true }),
    lat: r.num('lat', { min: -90, max: 90 }),
    lon: r.num('lon', { min: -180, max: 180 }),
    debrief: r.has('debrief') ? validateDebrief(r.raw('debrief'), `${prefix}debrief.`, errors) : undefined,
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
    source: r.str('source', { required: true, max: 500, pattern: /^https?:\/\/\S+$/, msg: 'adresse http(s) attendue' }),
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
