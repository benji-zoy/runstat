// Client de l'API REST Strava v3, en lecture seule (GET sur une liste blanche de chemins).
// Le MCP officiel (mcp.strava.com) est réservé à Claude et aux abonnés : inutilisable ici.
// Appli Strava perso (strava.com/settings/api, abonnement Strava requis pour le développeur, 10 athlètes au plus) :
// chacun crée la sienne, avec pour domaine de rappel l'hôte du site (ex. nas.tailXXXX.ts.net ; localhost est toujours accepté).
// secrets/strava-client.json = { "client_id": "…", "client_secret": "…" }, saisi dans Réglages (PUT /api/strava/client).
// Connexion depuis le site : Réglages › « Connecter Strava » (strava-connect.mjs). En secours, npm run auth -- strava sur le
// poste, puis copier secrets/strava-tokens.json dans secrets/ du NAS.
// Politique API Strava : les données ne devraient pas rester en cache plus de 7 jours (§ 6.2) ; ce tableau de bord
// personnel les garde pour l'historique, en connaissance de cause. Accès révoqué : supprimer data-raw/strava et les
// tracés strava-* sous 30 jours.
import { readSecret, writeSecret, ReauthRequired } from './secrets.mjs';
import { loopbackCode, pkce } from './loopback.mjs';
import { fetchRetry } from './retry.mjs';

/** Nouvelle adresse obligatoire au 1er juin 2027 : https://www.api-v3.strava.com */
export const API = process.env.STRAVA_API_URL ?? 'https://www.strava.com/api/v3';
export const OAUTH = 'https://www.strava.com/oauth';
export const SCOPE = 'read,activity:read_all';

/** Seuls chemins appelés, tous en GET */
export const READ_PATHS = [/^\/athlete\/activities$/, /^\/activities\/\d+$/, /^\/activities\/\d+\/streams$/];

/** Limite de débit atteinte (429 ou quota des 15 min presque épuisé) : on s'arrête proprement */
export class RateLimited extends Error {}

function client() {
  const c = readSecret('strava-client.json');
  if (!c?.client_id || !c?.client_secret) {
    throw new Error('secrets/strava-client.json absent : crée une appli sur strava.com/settings/api (client_id, client_secret).');
  }
  return c;
}

async function postToken(params) {
  const c = client();
  const res = await fetchRetry(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function saveTokens(body, previous) {
  const tokens = {
    access_token: body.access_token,
    // Le refresh token peut changer à chaque renouvellement : un seul détenteur (le NAS)
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: (body.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
    scope: body.scope ?? previous?.scope,
    athleteId: body.athlete?.id ?? previous?.athleteId,
    // Prénom seul, pour « Connecté (…) » dans Réglages
    athleteName: body.athlete?.firstname ?? previous?.athleteName,
    obtainedAt: body.athlete ? new Date().toISOString() : previous?.obtainedAt,
  };
  writeSecret('strava-tokens.json', tokens);
  return tokens;
}

/** Adresse d'autorisation Strava (page de consentement de l'athlète) */
export function authorizeUrl(clientId, redirect, state) {
  const url = new URL(`${OAUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: SCOPE,
    state,
  });
  return url.toString();
}

/**
 * Échange du code d'autorisation contre les jetons, écrits dans secrets/strava-tokens.json.
 * `scope` : scopes cochés par l'athlète, rendus par Strava dans la redirection (absents de la réponse du jeton).
 * Renvoie l'athlète seulement : les jetons ne sortent jamais de ce module.
 */
export async function exchangeCode(code, scope) {
  const res = await postToken({ code, grant_type: 'authorization_code' });
  if (res.status !== 200 || !res.body.access_token || !res.body.refresh_token)
    throw new Error(`Échange du code Strava : HTTP ${res.status} ${res.body.message ?? ''}`.trim());
  const t = saveTokens({ ...res.body, scope });
  return { athleteId: t.athleteId, athleteName: t.athleteName, scope: t.scope };
}

/** Autorisation interactive sur le poste (navigateur + loopback), en secours de Réglages › « Connecter Strava » */
export async function authorizeStrava() {
  const c = client();
  const { state } = pkce();
  const { code, scope } = await loopbackCode({
    host: 'localhost',
    path: '/callback',
    state,
    authorize: (redirect) => authorizeUrl(c.client_id, redirect, state),
  });
  // Sans activity:read_all, pas de sorties privées
  const t = await exchangeCode(code, scope);
  console.log(`Strava autorisé (athlète ${t.athleteId}, scopes : ${scope}).`);
  if (!/activity:read_all/.test(scope ?? '')) console.log('Sorties privées non autorisées : elles ne seront pas synchronisées.');
}

async function accessToken() {
  const tokens = readSecret('strava-tokens.json');
  if (!tokens?.refresh_token) throw new ReauthRequired('strava', 'aucun token');
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  const res = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  if (res.status === 400 || res.status === 401) throw new ReauthRequired('strava', res.body.message ?? 'refus');
  if (res.status !== 200) throw new Error(`Refresh Strava : HTTP ${res.status}`);
  return saveTokens(res.body, tokens).access_token;
}

/** Utilisation des limites (« 100,1000 » / « 12,300 ») : vrai si le quota des 15 min est presque épuisé */
export function nearLimit(headers) {
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

let throttled = false;

/** GET authentifié sur un chemin de la liste blanche ; JSON ou erreur */
export async function get(path, params = {}) {
  if (!READ_PATHS.some((re) => re.test(path))) throw new Error(`Chemin Strava non autorisé (lecture seule) : ${path}`);
  if (throttled) throw new RateLimited('limite de débit Strava presque atteinte, suite au prochain run');
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  // Pas de nouvel essai sur 429 : la fenêtre est de 15 minutes
  const res = await fetchRetry(url, { headers: { Authorization: `Bearer ${await accessToken()}` } }, { tries: 2 });
  if (res.status === 429) throw new RateLimited('limite de débit Strava atteinte, suite au prochain run');
  if (nearLimit(res.headers)) throttled = true;
  if (res.status === 401) throw new ReauthRequired('strava', 'token refusé par l’API');
  if (res.status !== 200) throw new Error(`Strava ${path} : HTTP ${res.status}`);
  return res.json();
}

/** Activités depuis `after` (secondes epoch), toutes les pages */
export async function activitiesSince(after) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const list = await get('/athlete/activities', { after, page, per_page: 100 });
    all.push(...list);
    if (list.length < 100) return all;
  }
  throw new Error('Strava : trop de pages d’activités');
}

/** Streams d'une activité, pour build-fit (src/engine/fit/track.ts) */
export const STREAM_KEYS = 'time,distance,latlng,altitude,heartrate,cadence,watts,temp,moving';
export const streams = (id) => get(`/activities/${id}/streams`, { keys: STREAM_KEYS, key_by_type: true });
