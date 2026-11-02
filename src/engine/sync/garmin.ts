// Client de la Garmin Connect Personal API, en lecture seule (GET sur une liste blanche de chemins et de paramètres),
// portable. Chacun crée sa clé personnelle sur Garmin Connect (connect.garmin.com/app/settings/personalApiToken, 30 jours
// à un an) : garmin-key.json = { apiKey, days, savedOn } dans le magasin du compte, jamais relue par le site. La clé
// s'échange contre un jeton Bearer de 24 h (JWT en texte brut), sans refresh token : on en redemande un avec la clé, et il
// reste en mémoire. Garmin refuse le CORS : dans le navigateur, `fetch` passe par le relais du NAS (/relay/garmin/).
import { InvalidEntry } from '../entries.ts';
import { openZip } from '../archive/zip.ts';
import { isFitFile } from '../fit/parse-fit.ts';
import { fetchRetry, globalFetch, RateLimited, ReauthRequired, type Fetch, type TokenStore } from './http.ts';

export const GARMIN_API_URL = 'https://personal.connectapi.garmin.com';
export const GARMIN_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
/** Page de Garmin Connect où l'on crée sa clé */
export const GARMIN_KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
export const GARMIN_KEY_FILE = 'garmin-key.json';
/** Durées de validité proposées par Garmin, en jours */
export const GARMIN_KEY_DAYS = [30, 90, 180, 365] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = '\\d{4}-\\d{2}-\\d{2}\\/\\d{4}-\\d{2}-\\d{2}';

/** Seuls chemins appelés, tous en GET (le relais du NAS applique la même liste) */
export const READ_PATHS = [
  /^\/activitylist-service\/activities\/search\/activities$/,
  /^\/download-service\/files\/activity\/\d{1,30}$/,
  /^\/sleep-service\/sleep\/dailySleepSummariesByDate$/,
  new RegExp(`^\\/hrv-service\\/hrv\\/daily\\/${RANGE}$`),
  /^\/usersummary-service\/v2\/dailysummaries$/,
  new RegExp(`^\\/weight-service\\/weight\\/range\\/${RANGE}$`),
];

/** Seuls paramètres de requête transmis */
export const READ_PARAMS: Record<string, RegExp> = {
  start: /^\d{1,6}$/,
  limit: /^\d{1,3}$/,
  startDate: DATE,
  endDate: DATE,
  activityType: /^running$/,
  sortOrder: /^(asc|desc)$/,
};

/** Requête de lecture autorisée : chemin et paramètres en liste blanche */
export function allowedRequest(path: string, params: URLSearchParams): boolean {
  if (!READ_PATHS.some((re) => re.test(path))) return false;
  for (const [k, v] of params) if (!READ_PARAMS[k]?.test(v)) return false;
  return true;
}

/** Clé personnelle : caractères d'un jeton (base64, base64url, points, tirets), longueur bornée */
const API_KEY = /^[A-Za-z0-9._~+/=-]{16,4096}$/;
/** En-têtes Authorization acceptés par le relais */
export const API_KEY_HEADER = /^ApiKey [A-Za-z0-9._~+/=-]{16,4096}$/;
export const BEARER_HEADER = /^Bearer [A-Za-z0-9._~+/=-]{16,8192}$/;
/** Jeton renvoyé par Garmin : un JWT */
export const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export interface GarminKey {
  apiKey: string;
  /** Durée de validité choisie à la création */
  days: number;
  /** Date d'enregistrement (AAAA-MM-JJ) : l'expiration en découle */
  savedOn: string;
}

/** Clé saisie dans Réglages (NAS ou appareil) : validation stricte, la clé n'est jamais renvoyée */
export function validateGarminKey(body: unknown, today = new Date().toLocaleDateString('sv-SE')): GarminKey {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidEntry(['objet attendu']);
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'apiKey' && k !== 'days') errors.push(`${k} : champ inconnu`);
  const apiKey = typeof b['apiKey'] === 'string' ? b['apiKey'].trim() : '';
  const days = Number(b['days']);
  if (!API_KEY.test(apiKey)) errors.push('Clé : copie la clé affichée par Garmin Connect, telle quelle');
  if (!(GARMIN_KEY_DAYS as readonly number[]).includes(days)) errors.push('Durée : 30, 90, 180 ou 365 jours');
  if (errors.length) throw new InvalidEntry(errors);
  return { apiKey, days, savedOn: today };
}

/** Date d'expiration approximative de la clé (AAAA-MM-JJ) */
export function garminKeyExpiry(k: Pick<GarminKey, 'days' | 'savedOn'> | null | undefined): string | null {
  if (!k?.savedOn || !k.days) return null;
  const d = new Date(`${k.savedOn}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k.days);
  return d.toISOString().slice(0, 10);
}

/** Expiration d'un JWT (`exp`, en secondes) → millisecondes, ou null */
export function jwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')))['exp'];
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Fenêtres de dates consécutives de `days` jours au plus, de `from` à `to` inclus */
export function dateWindows(from: string, to: string, days: number): [string, string][] {
  const out: [string, string][] = [];
  const add = (d: string, n: number) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  for (let a = from; a <= to; a = add(a, days)) out.push([a, [add(a, days - 1), to].sort()[0]]);
  return out;
}

export interface GarminOptions {
  tokens: TokenStore;
  fetch?: Fetch;
  api?: string;
}

export type GarminClient = ReturnType<typeof garminClient>;

/**
 * `fetch` du client dans le navigateur : Garmin refuse le CORS, chaque appel passe par le relais du NAS
 * (/relay/garmin/token, /relay/garmin/api/<chemin>), la clé ou le jeton Garmin en X-Garmin-Authorization et la session
 * RunStat en Authorization. Un refus de la session (et non de Garmin) n'est pas une clé à remplacer : erreur ordinaire.
 */
export function garminRelayFetch(nas: string, session: () => string | null, fetch: Fetch = globalFetch): Fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const target = url.pathname === GARMIN_TOKEN_PATH ? `${nas}/relay/garmin/token` : `${nas}/relay/garmin/api${url.pathname}${url.search}`;
    const headers: Record<string, string> = { 'X-Garmin-Authorization': new Headers(init.headers).get('authorization') ?? '' };
    const token = session();
    if (!token) throw new Error('compte RunStat non connecté : la synchro Garmin passe par ton NAS');
    headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(target, { method: init.method ?? 'GET', headers, signal: init.signal, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      const body = await res.clone().json().catch(() => ({}));
      if (!body?.garmin) throw new Error('session RunStat expirée : reconnecte-toi (Compte et sauvegarde)');
    }
    return res;
  };
}

type Params = Record<string, string | number | null | undefined>;

export function garminClient({ tokens, fetch = globalFetch, api = GARMIN_API_URL }: GarminOptions) {
  let bearer: { token: string; expires: number } | null = null;

  async function apiKey(): Promise<string> {
    const k = await tokens.read<GarminKey>(GARMIN_KEY_FILE);
    if (!k?.apiKey) throw new ReauthRequired('garmin', 'aucune clé');
    return k.apiKey;
  }

  /** Jeton Bearer (24 h) obtenu avec la clé ; redemandé une minute avant son expiration */
  async function token(renew = false, key?: string): Promise<string> {
    if (!renew && !key && bearer && bearer.expires - 60_000 > Date.now()) return bearer.token;
    const res = await fetchRetry(
      fetch,
      `${api}${GARMIN_TOKEN_PATH}`,
      { method: 'POST', headers: { Authorization: `ApiKey ${key ?? (await apiKey())}`, Accept: '*/*' } },
      { tries: 2 },
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new ReauthRequired('garmin', 'clé refusée ou expirée');
    if (res.status === 429) throw new RateLimited('limite de débit Garmin atteinte, suite à la prochaine synchro');
    if (!res.ok) throw new Error(`Jeton Garmin : HTTP ${res.status}`);
    const text = (await res.text()).trim();
    const t = text.startsWith('{') ? String(JSON.parse(text)['access_token'] ?? '') : text;
    if (!JWT.test(t)) throw new Error('Jeton Garmin : réponse inattendue');
    if (!key) bearer = { token: t, expires: jwtExpiry(t) ?? Date.now() + 23 * 3_600_000 };
    return t;
  }

  /** GET authentifié sur la liste blanche ; un 401 redemande un jeton une fois */
  async function request(path: string, params: Params = {}): Promise<Response> {
    const url = new URL(`${api}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    if (!allowedRequest(path, url.searchParams)) throw new Error(`Requête Garmin non autorisée (lecture seule) : ${path}`);
    const send = async (renew: boolean) =>
      fetchRetry(fetch, url, { headers: { Authorization: `Bearer ${await token(renew)}` } }, { tries: 2 });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (res.status === 429) throw new RateLimited('limite de débit Garmin atteinte, suite à la prochaine synchro');
    if (res.status === 401 || res.status === 403) throw new ReauthRequired('garmin', 'jeton refusé par l’API');
    return res;
  }

  async function json<T>(path: string, params: Params = {}): Promise<T | null> {
    const res = await request(path, params);
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`Garmin ${path.split('/')[1]} : HTTP ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Activités de course à pied dont la date locale est entre `from` et `to` (inclus), toutes les pages */
  async function activities(from: string, to: string): Promise<any[]> {
    const all: any[] = [];
    const LIMIT = 100;
    for (let start = 0; start < 100 * LIMIT; start += LIMIT) {
      const list =
        (await json<any[]>('/activitylist-service/activities/search/activities', {
          startDate: from,
          endDate: to,
          activityType: 'running',
          start,
          limit: LIMIT,
        })) ?? [];
      all.push(...list);
      if (list.length < LIMIT) return all;
    }
    throw new Error('Garmin : trop de pages d’activités');
  }

  /** Fichier d'origine d'une activité (zip contenant le .fit) → FIT, ou null si elle n'en a pas */
  async function fit(activityId: string): Promise<Uint8Array | null> {
    const res = await request(`/download-service/files/activity/${activityId}`);
    if (res.status === 404 || res.status === 204) return null;
    if (res.status !== 200) throw new Error(`Garmin FIT ${activityId} : HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (isFitFile(bytes)) return bytes;
    const zip = await openZip({ size: bytes.length, read: async (p, l) => bytes.subarray(p, p + l) }, { maxEntrySize: 64 * 1024 * 1024 });
    const entry = zip.entries.find((e) => /\.fit$/i.test(e.name));
    const out = entry ? await zip.read(entry) : null;
    return out && isFitFile(out) ? out : null;
  }

  /** Santé du `from` au `to` inclus, par fenêtres (31 jours au plus pour le sommeil) */
  async function health(from: string, to: string) {
    const sleep: any[] = [];
    const hrv: any[] = [];
    const summaries: any[] = [];
    const weight: any[] = [];
    for (const [a, b] of dateWindows(from, to, 28)) {
      sleep.push(...((await json<any[]>('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: a, endDate: b })) ?? []));
      hrv.push(...((await json<{ hrvSummaries?: any[] }>(`/hrv-service/hrv/daily/${a}/${b}`))?.hrvSummaries ?? []));
    }
    for (const [a, b] of dateWindows(from, to, 90)) {
      summaries.push(...((await json<{ data?: any[] }>('/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b }))?.data ?? []));
      weight.push(...((await json<{ dailyWeightSummaries?: any[] }>(`/weight-service/weight/range/${a}/${b}`))?.dailyWeightSummaries ?? []));
    }
    return { sleep, hrv, summaries, weight };
  }

  /** Essai d'une clé avant de l'enregistrer (Réglages) : ReauthRequired si Garmin la refuse */
  const verify = async (key: string): Promise<void> => void (await token(true, key));

  return { activities, fit, health, verify, json };
}
