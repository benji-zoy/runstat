// Client Google Health API v4 (lecture seule), portable. Le jeton passe par `token` : sur le NAS, POST direct à Google avec
// le secret du client du propriétaire ; dans le navigateur, relais du NAS (POST /relay/google/token, secret ajouté côté
// serveur, scripts/sync/public-api.mjs). Jetons dans google-tokens.json du magasin du compte.
import { fetchRetry, globalFetch, guardedRefresh, ReauthRequired, type Fetch, type TokenStore } from './http.ts';

export const GOOGLE_HEALTH_API = 'https://health.googleapis.com/v4';
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
];

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  obtainedAt?: string;
}

/** Échange ou renouvellement : { grant_type, code, code_verifier, redirect_uri } ou { grant_type, refresh_token } */
export type GoogleTokenEndpoint = (params: Record<string, string>) => Promise<{ status: number; body: Record<string, any> }>;

/** Adresse de consentement Google (hors ligne, PKCE) */
export function googleAuthorizeUrl(clientId: string, { redirect, challenge, state }: { redirect: string; challenge: string; state: string }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
}

/** Champ de filtre d'un type : « daily-resting-heart-rate » → « daily_resting_heart_rate » (le camelCase de la doc est refusé) */
export const filterField = (dataType: string) => dataType.replaceAll('-', '_');

export interface GoogleOptions {
  tokens: TokenStore;
  token: GoogleTokenEndpoint;
  fetch?: Fetch;
}

export type GoogleClient = ReturnType<typeof googleClient>;

export function googleClient({ tokens, token, fetch = globalFetch }: GoogleOptions) {
  async function saveTokens(body: Record<string, any>, previous?: GoogleTokens | null): Promise<GoogleTokens> {
    const t: GoogleTokens = {
      access_token: body['access_token'],
      refresh_token: body['refresh_token'] ?? previous?.refresh_token,
      expires_at: Date.now() + (body['expires_in'] ?? 3600) * 1000,
      scope: body['scope'] ?? previous?.scope,
      obtainedAt: body['refresh_token'] ? new Date().toISOString() : previous?.obtainedAt,
    };
    await tokens.write('google-tokens.json', t);
    return t;
  }

  /** Échange du code, jetons écrits dans le magasin ; renvoie les scopes seulement */
  async function exchangeCode({ code, verifier, redirect }: { code: string; verifier: string; redirect: string }) {
    const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
    if (res.status !== 200) throw new Error(`Échange du code Google : ${res.body['error']} ${res.body['error_description'] ?? ''}`.trim());
    if (!res.body['refresh_token']) throw new Error('Google n’a pas renvoyé de refresh token.');
    return { scope: (await saveTokens(res.body)).scope };
  }

  async function accessToken(): Promise<string> {
    const current = await tokens.read<GoogleTokens>('google-tokens.json');
    if (!current?.refresh_token) throw new ReauthRequired('google', 'aucun token');
    if (current.expires_at - 60_000 > Date.now()) return current.access_token;
    return guardedRefresh<GoogleTokens>(tokens, 'google-tokens.json', async (t) => {
      const res = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token! });
      // invalid_grant : refresh token révoqué ou expiré (7 jours si l'app est restée en « Testing »)
      if (res.status === 400 || res.status === 401) throw new ReauthRequired('google', res.body['error'] ?? 'refus');
      if (res.status !== 200) throw new Error(`Refresh Google : HTTP ${res.status}`);
      return (await saveTokens(res.body, t)).access_token;
    });
  }

  /** GET authentifié ; renvoie { status, body } sans lever d'erreur HTTP (le spike veut tout voir) */
  async function get(path: string, params: Record<string, string | number | null | undefined> = {}): Promise<{ status: number; body: any }> {
    const url = new URL(`${GOOGLE_HEALTH_API}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const res = await fetchRetry(fetch, url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** Toutes les pages de users/me/dataTypes/<type>/dataPoints */
  async function listDataPoints(dataType: string, filter: string, { pageSize, maxPages = 50 }: { pageSize?: number; maxPages?: number } = {}) {
    const pages: { status: number; body: any }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await get(`users/me/dataTypes/${dataType}/dataPoints`, { filter, pageSize, pageToken });
      pages.push(res);
      pageToken = res.body?.nextPageToken;
    } while (pageToken && pages.length < maxPages);
    return pages;
  }

  /** Points d'un type sur une période ; lève une erreur au premier échec */
  async function dataPoints(dataType: string, filter: string): Promise<any[]> {
    const pages = await listDataPoints(dataType, filter, { maxPages: 200 });
    const bad = pages.find((p) => p.status !== 200);
    if (bad?.status === 401) throw new ReauthRequired('google', 'token refusé par l’API');
    if (bad) throw new Error(`${dataType} : HTTP ${bad.status} ${bad.body?.error?.message ?? ''}`);
    if (pages.at(-1)!.body?.nextPageToken) throw new Error(`${dataType} : trop de pages`);
    return pages.flatMap((p) => p.body?.dataPoints ?? []);
  }

  return { exchangeCode, get, listDataPoints, dataPoints, filterField };
}
