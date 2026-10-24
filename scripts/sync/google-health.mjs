// Client Google Health API v4 en lecture seule : enveloppe Node du client portable (src/engine/sync/google.ts), jeton
// échangé directement avec Google (secret du client ajouté ici ; dans le navigateur, par le relais du NAS).
// Client OAuth « Application Web » : JSON téléchargé depuis la console Google Cloud et copié dans
// secrets/google-client.json du propriétaire, avec les URI de redirection autorisées http://localhost:53683/callback (poste),
// https://<hôte ts.net>/api/google/callback (Réglages › « Connecter Google », oauth-connect.mjs) et
// <appli publique>connexion/google (proches local-first, relais).
import { existsSync, readFileSync } from 'node:fs';
import { googleClient, googleAuthorizeUrl, filterField, GOOGLE_SCOPES } from '#engine/sync/google.ts';
import { postForm, globalFetch } from '#engine/sync/http.ts';
import { readSecret, nodeTokens, secretsDir } from './secrets.mjs';
import { pkce, loopbackCode } from './loopback.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export { GOOGLE_SCOPES, filterField };

/**
 * Client OAuth : celui du compte (secrets/google-client.json), sinon celui du propriétaire (RUNSTAT_GOOGLE_CLIENT,
 * posé par server.mjs pour les proches hébergés : un seul projet Google Cloud par instance). `file` : chemin explicite.
 */
export function client(dir, file = process.env.RUNSTAT_GOOGLE_CLIENT) {
  let raw = readSecret('google-client.json', dir);
  if (!raw && file && existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'));
  const c = raw?.installed ?? raw?.web ?? raw;
  if (!c?.client_id) throw new Error('secrets/google-client.json absent : télécharge le JSON du client OAuth (console Google Cloud).');
  return c;
}

/** Client Google Health d'un dossier de secrets, jeton échangé avec le client `c` */
export const googleAt = (dir = secretsDir(), c) =>
  googleClient({
    tokens: nodeTokens(dir),
    token: (params) => {
      const app = c ?? client(dir);
      return postForm(globalFetch, TOKEN_URL, { ...params, client_id: app.client_id, client_secret: app.client_secret });
    },
  });
let run;
const current = () => (run ??= googleAt());

/** Adresse de consentement Google (hors ligne, PKCE) */
export const authorizeUrl = (c, opts) => googleAuthorizeUrl(c.client_id, opts);

/** Échange du code (secret du client ajouté ici), jetons écrits dans `dir` ; renvoie les scopes seulement */
export const exchangeCode = (c, { code, verifier, redirect, dir }) => googleAt(dir, c).exchangeCode({ code, verifier, redirect });

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

/** GET authentifié ; renvoie { status, body } sans lever d'erreur HTTP (le spike veut tout voir) */
export const get = (path, params) => current().get(path, params);
export const listDataPoints = (type, filter, opts) => current().listDataPoints(type, filter, opts);
/** Points d'un type sur une période ; lève une erreur au premier échec */
export const dataPoints = (type, filter) => current().dataPoints(type, filter);
