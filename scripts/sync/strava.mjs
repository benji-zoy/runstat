// Client de l'API REST Strava v3 en lecture seule : enveloppe Node du client portable (src/engine/sync/strava.ts).
// Appli Strava perso (strava.com/settings/api, abonnement Strava requis pour le développeur, 10 athlètes au plus) :
// chacun crée la sienne, avec pour domaine de rappel l'hôte du site (ex. nas.tailXXXX.ts.net ; localhost est toujours accepté).
// secrets/strava-client.json = { "client_id": "…", "client_secret": "…" }, saisi dans Réglages (PUT /api/strava/client).
// Connexion depuis le site : Réglages › « Connecter Strava » (strava-connect.mjs). En secours, npm run auth -- strava sur le
// poste, puis copier secrets/strava-tokens.json dans secrets/ du NAS.
// Accès révoqué : supprimer data-raw/strava et les tracés strava-* sous 30 jours.
import { stravaClient, stravaAuthorizeUrl, READ_PATHS, STREAM_KEYS, STRAVA_SCOPE, STRAVA_OAUTH, nearLimit } from '#engine/sync/strava.ts';
import { readSecret, nodeTokens, secretsDir } from './secrets.mjs';
import { loopbackCode, pkce } from './loopback.mjs';

export { RateLimited } from '#engine/sync/http.ts';
export { READ_PATHS, STREAM_KEYS, nearLimit };
/** Nouvelle adresse obligatoire au 1er juin 2027 : https://www.api-v3.strava.com */
export const API = process.env.STRAVA_API_URL ?? 'https://www.strava.com/api/v3';
export const OAUTH = STRAVA_OAUTH;
export const SCOPE = STRAVA_SCOPE;

export const stravaAt = (dir = secretsDir()) => stravaClient({ tokens: nodeTokens(dir), api: API });
let run;
const current = () => (run ??= stravaAt());

/** Adresse d'autorisation Strava (page de consentement de l'athlète) */
export const authorizeUrl = stravaAuthorizeUrl;

/** Échange du code (jetons dans strava-tokens.json de `dir`) ; renvoie l'athlète seulement */
export const exchangeCode = (code, scope, dir) => stravaAt(dir).exchangeCode(code, scope);

/** Autorisation interactive sur le poste (navigateur + loopback), en secours de Réglages › « Connecter Strava » */
export async function authorizeStrava() {
  const c = readSecret('strava-client.json');
  if (!c?.client_id) throw new Error('secrets/strava-client.json absent : crée une appli sur strava.com/settings/api (client_id, client_secret).');
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

export const get = (path, params) => current().get(path, params);
export const activitiesSince = (after) => current().activitiesSince(after);
export const streams = (id) => current().streams(id);
