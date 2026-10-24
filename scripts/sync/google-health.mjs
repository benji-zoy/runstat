// Client Google Health API v4 (lecture seule).
// Client OAuth « Application Web » : JSON téléchargé depuis la console Google Cloud et copié dans
// secrets/google-client.json du propriétaire, avec les URI de redirection autorisées http://localhost:53683/callback (poste)
// et https://<hôte ts.net>/api/google/callback (Réglages › « Connecter Google », google-connect.mjs).
// (Un client « Application de bureau » marche aussi sur le poste, sur un port quelconque, mais pas depuis le site.)
import { existsSync, readFileSync } from 'node:fs';
import { readSecret, writeSecret, ReauthRequired } from './secrets.mjs';
import { pkce, loopbackCode } from './loopback.mjs';
import { fetchRetry } from './retry.mjs';

const API = 'https://health.googleapis.com/v4';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
];

/**
 * Client OAuth : celui du compte (secrets/google-client.json), sinon celui du propriétaire (RUNSTAT_GOOGLE_CLIENT,
 * posé par server.mjs pour les proches hébergés : un seul projet Google Cloud par instance). `file` : chemin explicite.
 */
export function client(dir, file = process.env.RUNSTAT_GOOGLE_CLIENT) {
  let raw = readSecret('google-client.json', dir);
  if (!raw && file && existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'));
  const c = raw?.installed ?? raw?.web ?? raw;
  if (!c?.client_id) {
    throw new Error(
      'secrets/google-client.json absent : télécharge le JSON du client OAuth (console Google Cloud).',
    );
  }
  return c;
}

async function postToken(params) {
  const res = await fetchRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function saveTokens(body, previous, dir) {
  const tokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? previous?.scope,
    obtainedAt: body.refresh_token ? new Date().toISOString() : previous?.obtainedAt,
  };
  writeSecret('google-tokens.json', tokens, dir);
  return tokens;
}

/** Adresse de consentement Google (hors ligne, PKCE) */
export function authorizeUrl(c, { redirect, challenge, state }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return url.toString();
}

/** Échange du code (secret du client ajouté ici), jetons écrits dans `dir` ; renvoie les scopes seulement */
export async function exchangeCode(c, { code, verifier, redirect, dir }) {
  const res = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    client_id: c.client_id,
    client_secret: c.client_secret,
  });
  if (res.status !== 200) {
    throw new Error(
      `Échange du code Google : ${res.body.error} ${res.body.error_description ?? ''}`.trim(),
    );
  }
  if (!res.body.refresh_token) throw new Error('Google n’a pas renvoyé de refresh token.');
  return { scope: saveTokens(res.body, undefined, dir).scope };
}

/** Autorisation interactive sur le poste : ouvre le navigateur, récupère le code en loopback */
export async function authorizeGoogle() {
  const c = client();
  const { verifier, challenge, state } = pkce();
  const web = Boolean(readSecret('google-client.json')?.web);
  const { code, redirect } = await loopbackCode({
    ...(web && { port: 53683, path: '/callback', host: 'localhost' }),
    state,
    authorize: (redirect) => authorizeUrl(c, { redirect, challenge, state }),
  });
  const t = await exchangeCode(c, { code, verifier, redirect });
  console.log(`Google autorisé (scopes : ${t.scope}).`);
}

async function accessToken() {
  const tokens = readSecret('google-tokens.json');
  if (!tokens?.refresh_token) throw new ReauthRequired('google', 'aucun token');
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  const c = client();
  const res = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: c.client_id,
    client_secret: c.client_secret,
  });
  // invalid_grant : refresh token révoqué ou expiré (7 jours si l'app est restée en « Testing »)
  if (res.status === 400 || res.status === 401)
    throw new ReauthRequired('google', res.body.error ?? 'refus');
  if (res.status !== 200) throw new Error(`Refresh Google : HTTP ${res.status}`);
  return saveTokens(res.body, tokens).access_token;
}

/** GET authentifié ; renvoie { status, body } sans lever d'erreur HTTP (le spike veut tout voir) */
export async function get(path, params = {}) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetchRetry(url, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Champ de filtre d'un type : « daily-resting-heart-rate » → « daily_resting_heart_rate »
 *  (l'exemple camelCase de la documentation est refusé par l'API) */
export const filterField = (dataType) => dataType.replaceAll('-', '_');

/** Toutes les pages de users/me/dataTypes/<type>/dataPoints */
export async function listDataPoints(dataType, filter, { pageSize, maxPages = 50 } = {}) {
  const pages = [];
  let pageToken;
  do {
    const res = await get(`users/me/dataTypes/${dataType}/dataPoints`, {
      filter,
      pageSize,
      pageToken,
    });
    pages.push(res);
    pageToken = res.body?.nextPageToken;
  } while (pageToken && pages.length < maxPages);
  return pages;
}

/** Points d'un type sur une période ; lève une erreur au premier échec */
export async function dataPoints(dataType, filter) {
  const pages = await listDataPoints(dataType, filter, { maxPages: 200 });
  const bad = pages.find((p) => p.status !== 200);
  if (bad?.status === 401) throw new ReauthRequired('google', 'token refusé par l’API');
  if (bad) throw new Error(`${dataType} : HTTP ${bad.status} ${bad.body?.error?.message ?? ''}`);
  if (pages.at(-1).body?.nextPageToken) throw new Error(`${dataType} : trop de pages`);
  return pages.flatMap((p) => p.body?.dataPoints ?? []);
}
