// Client de l'API REST Strava v3, en lecture seule (GET sur une liste blanche de chemins), portable (l'API et /oauth/token
// acceptent le CORS). Chacun a sa propre appli Strava (strava.com/settings/api) : strava-client.json = { client_id,
// client_secret } dans le magasin du compte, jamais relu par le site ; jetons dans strava-tokens.json.
// Politique API Strava : cache de 7 jours au plus (§ 6.2), assumé pour l'historique personnel.
import { InvalidEntry } from '../entries.ts';
import { fetchRetry, globalFetch, guardedRefresh, RateLimited, ReauthRequired, type Fetch, type TokenStore } from './http.ts';

/** Nouvelle adresse obligatoire au 1er juin 2027 : https://www.api-v3.strava.com */
export const STRAVA_API_URL = 'https://www.strava.com/api/v3';
export const STRAVA_OAUTH = 'https://www.strava.com/oauth';
export const STRAVA_SCOPE = 'read,activity:read_all';

/** Seuls chemins appelés, tous en GET */
export const READ_PATHS = [/^\/athlete\/activities$/, /^\/activities\/\d+$/, /^\/activities\/\d+\/streams$/];

/** Streams d'une activité, pour build-fit (src/engine/fit/track.ts) */
export const STREAM_KEYS = 'time,distance,latlng,altitude,heartrate,cadence,watts,temp,moving';

export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  athleteId?: number;
  athleteName?: string;
  obtainedAt?: string;
}

/** Identifiants de l'appli Strava saisis dans Réglages (NAS ou appareil) : validation stricte, le secret n'est jamais renvoyé */
export function validateStravaApp(body: unknown): { client_id: string; client_secret: string } {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidEntry(['objet attendu']);
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'client_id' && k !== 'client_secret') errors.push(`${k} : champ inconnu`);
  const id = typeof b['client_id'] === 'string' || typeof b['client_id'] === 'number' ? String(b['client_id']).trim() : '';
  const secret = typeof b['client_secret'] === 'string' ? b['client_secret'].trim() : '';
  if (!/^\d{1,12}$/.test(id)) errors.push('Client ID : nombre attendu (strava.com/settings/api)');
  if (!/^[A-Za-z0-9]{20,100}$/.test(secret)) errors.push('Client Secret : 40 caractères attendus (strava.com/settings/api)');
  if (errors.length) throw new InvalidEntry(errors);
  return { client_id: id, client_secret: secret };
}

/** Utilisation des limites (« 100,1000 » / « 12,300 ») : vrai si le quota des 15 min est presque épuisé */
export function nearLimit(headers: Headers): boolean {
  for (const [limitH, usageH] of [
    ['x-ratelimit-limit', 'x-ratelimit-usage'],
    ['x-readratelimit-limit', 'x-readratelimit-usage'],
  ]) {
    const limit = headers.get(limitH)?.split(',').map(Number);
    const usage = headers.get(usageH)?.split(',').map(Number);
    if (!limit || !usage) continue;
    if (usage.some((u, i) => limit[i] > 0 && u >= limit[i] * 0.9)) return true;
  }
  return false;
}

/** Adresse d'autorisation Strava (page de consentement de l'athlète) */
export function stravaAuthorizeUrl(clientId: string, redirect: string, state: string): string {
  const url = new URL(`${STRAVA_OAUTH}/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', approval_prompt: 'auto', scope: STRAVA_SCOPE, state }).toString();
  return url.toString();
}

export interface StravaOptions {
  tokens: TokenStore;
  fetch?: Fetch;
  api?: string;
}

export type StravaClient = ReturnType<typeof stravaClient>;

export function stravaClient({ tokens, fetch = globalFetch, api = STRAVA_API_URL }: StravaOptions) {
  let throttled = false;

  async function app(): Promise<{ client_id: string; client_secret: string }> {
    const c = await tokens.read('strava-client.json');
    if (!c?.client_id || !c?.client_secret) throw new Error('appli Strava absente : crée-la sur strava.com/settings/api (Client ID, Client Secret).');
    return c;
  }

  async function postToken(params: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
    const c = await app();
    const res = await fetchRetry(fetch, `${STRAVA_OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: String(c.client_id), client_secret: c.client_secret, ...params }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function saveTokens(body: Record<string, any>, previous?: StravaTokens | null): Promise<StravaTokens> {
    const t: StravaTokens = {
      access_token: body['access_token'],
      // Le refresh token peut changer à chaque renouvellement : un seul détenteur
      refresh_token: body['refresh_token'] ?? previous?.refresh_token,
      expires_at: (body['expires_at'] ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
      scope: body['scope'] ?? previous?.scope,
      athleteId: body['athlete']?.id ?? previous?.athleteId,
      // Prénom seul, pour « Connecté (…) » dans Réglages
      athleteName: body['athlete']?.firstname ?? previous?.athleteName,
      obtainedAt: body['athlete'] ? new Date().toISOString() : previous?.obtainedAt,
    };
    await tokens.write('strava-tokens.json', t);
    return t;
  }

  /**
   * Échange du code d'autorisation contre les jetons. `scope` : scopes cochés par l'athlète, rendus par Strava dans la
   * redirection (absents de la réponse du jeton). Renvoie l'athlète seulement.
   */
  async function exchangeCode(code: string, scope: string | null) {
    const res = await postToken({ code, grant_type: 'authorization_code' });
    if (res.status !== 200 || !res.body['access_token'] || !res.body['refresh_token'])
      throw new Error(`Échange du code Strava : HTTP ${res.status} ${res.body['message'] ?? ''}`.trim());
    const t = await saveTokens({ ...res.body, scope });
    return { athleteId: t.athleteId, athleteName: t.athleteName, scope: t.scope };
  }

  async function accessToken(): Promise<string> {
    const current = await tokens.read<StravaTokens>('strava-tokens.json');
    if (!current?.refresh_token) throw new ReauthRequired('strava', 'aucun token');
    if (current.expires_at - 60_000 > Date.now()) return current.access_token;
    return guardedRefresh<StravaTokens>(tokens, 'strava-tokens.json', async (t) => {
      const res = await postToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      if (res.status === 400 || res.status === 401) throw new ReauthRequired('strava', res.body['message'] ?? 'refus');
      if (res.status !== 200) throw new Error(`Refresh Strava : HTTP ${res.status}`);
      return (await saveTokens(res.body, t)).access_token;
    });
  }

  /** GET authentifié sur un chemin de la liste blanche ; JSON ou erreur */
  async function get(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<any> {
    if (!READ_PATHS.some((re) => re.test(path))) throw new Error(`Chemin Strava non autorisé (lecture seule) : ${path}`);
    if (throttled) throw new RateLimited('limite de débit Strava presque atteinte, suite au prochain run');
    const url = new URL(`${api}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    // Pas de nouvel essai sur 429 : la fenêtre est de 15 minutes
    const res = await fetchRetry(fetch, url, { headers: { Authorization: `Bearer ${await accessToken()}` } }, { tries: 2 });
    if (res.status === 429) throw new RateLimited('limite de débit Strava atteinte, suite au prochain run');
    if (nearLimit(res.headers)) throttled = true;
    if (res.status === 401) throw new ReauthRequired('strava', 'token refusé par l’API');
    if (res.status !== 200) throw new Error(`Strava ${path} : HTTP ${res.status}`);
    return res.json();
  }

  /** Activités depuis `after` (secondes epoch), toutes les pages */
  async function activitiesSince(after: number): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 50; page++) {
      const list = await get('/athlete/activities', { after, page, per_page: 100 });
      all.push(...list);
      if (list.length < 100) return all;
    }
    throw new Error('Strava : trop de pages d’activités');
  }

  const streams = (id: string) => get(`/activities/${id}/streams`, { keys: STREAM_KEYS, key_by_type: true });

  return { exchangeCode, get, activitiesSince, streams, authorizeUrl: stravaAuthorizeUrl };
}
