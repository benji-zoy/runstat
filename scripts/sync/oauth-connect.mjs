// Connexion COROS et Google depuis le site (Réglages), sans terminal, pour chaque compte (proches hébergés compris) :
//   GET /api/coros/connect  → 302 vers l'autorisation COROS (client public enregistré pour l'adresse du site, PKCE)
//   GET /api/coros/callback → échange du code, client + jetons dans les secrets du compte, puis 302 vers /aujourdhui?coros=ok|refus
//   GET /api/google/connect → 302 vers le consentement Google (client OAuth du propriétaire, PKCE, hors ligne)
//   GET /api/google/callback → échange du code (secret ajouté côté serveur), jetons du compte, puis /aujourdhui?google=ok|refus
// Comme pour Strava (strava-connect.mjs) : navigations protégées par un state aléatoire (10 min, usage unique) lié au compte qui
// a lancé la connexion ; redirect_uri = origine du site, acceptée seulement si elle est dans SYNC_PUBLIC_ORIGINS. Le vérificateur
// PKCE et le client COROS en attente restent en mémoire ; rien n'est écrit sans state valide, et le client COROS n'est écrit
// qu'avec les jetons qu'il a obtenus (jamais un client neuf à côté d'anciens jetons, qui casserait leur renouvellement).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './entries.mjs';
import { pkce } from './loopback.mjs';
import { readSecret } from './secrets.mjs';
import { StateStore, allowedOrigins, publicOrigin } from './strava-connect.mjs';
import * as coros from './coros.mjs';
import * as google from './google-health.mjs';

export const CALLBACKS = { coros: '/api/coros/callback', google: '/api/google/callback' };
export const CONNECT_PATHS = ['/api/coros/connect', '/api/google/connect', ...Object.values(CALLBACKS)];
/** Sources de sync-state.json à sortir de pause après une connexion (la santé COROS partage les jetons COROS) */
const STATE_KEYS = { coros: ['coros', 'corosHealth'], google: ['google'] };
const CODE = /^[\w./~+-]{1,1000}$/;

const redirect = (res, location) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
};
/** Retour vers le site : chemin relatif à l'origine de la requête, jamais une adresse fournie par le client */
const back = (res, source, ok, reason) =>
  redirect(res, `/aujourdhui?${source}=${ok ? 'ok' : 'refus'}${reason ? `&raison=${reason}` : ''}`);

/** Présence des jetons COROS et Google du compte (GET /api/sync), jamais leur contenu */
export function connectStatus(secrets, googleClientFile) {
  const read = (name) => {
    try {
      return readSecret(name, secrets);
    } catch {
      return null; // fichier en cours d'écriture
    }
  };
  let googleClient = false;
  try {
    googleClient = Boolean(google.client(secrets, googleClientFile));
  } catch {
    googleClient = false;
  }
  return {
    corosConnected: Boolean(read('coros-tokens.json')?.refresh_token),
    googleConnected: Boolean(read('google-tokens.json')?.refresh_token),
    googleClient,
  };
}

/**
 * Routes, pour le compte de la requête : `user` = { id, raw, secrets, googleClientFile (client du propriétaire),
 * onConnected(source) }. `providers` : coros.mjs et google-health.mjs (remplaçables dans les tests).
 */
export function oauthConnectRoutes({ origins = allowedOrigins(), store = new StateStore(), log = console, providers = { coros, google } } = {}) {
  /** Pause de ré-autorisation levée tout de suite (run.mjs le ferait aussi d'après la date du fichier de jetons) */
  function resume(user, source) {
    const file = join(user.raw, 'sync-state.json');
    try {
      const st = existsSync(file) ? readJsonFile(file, {}) : {};
      let changed = false;
      for (const k of STATE_KEYS[source]) if (st[k]?.reauthSince) (delete st[k].reauthSince, (changed = true));
      if (changed) writeJsonAtomic(file, st);
    } catch (e) {
      log.error?.(`${source} : sync-state.json illisible (${e.message})`);
    }
  }

  async function connect(source, user, req, res) {
    const origin = publicOrigin(req.headers, origins);
    if (!origin) {
      log.warn?.(`${source} : connexion refusée depuis un hôte hors liste (${req.headers['x-forwarded-host'] ?? req.headers.host ?? '?'})`);
      return back(res, source, false, 'origine');
    }
    const redirectUri = `${origin}${CALLBACKS[source]}`;
    const { verifier, challenge } = pkce();
    if (source === 'coros') {
      let meta;
      let client;
      try {
        meta = await providers.coros.metadata();
        client = await providers.coros.registerClient(meta, { redirect: redirectUri, persist: false, dir: user.secrets });
      } catch (e) {
        log.error?.(`COROS : ${e.message}`);
        return back(res, source, false, 'enregistrement');
      }
      const state = store.create({ userId: user.id, source, verifier, redirectUri, client });
      return redirect(res, providers.coros.authorizeUrl(meta, client, { redirect: redirectUri, challenge, state }));
    }
    let client;
    try {
      client = providers.google.client(user.secrets, user.googleClientFile);
    } catch {
      return back(res, source, false, 'appli');
    }
    const state = store.create({ userId: user.id, source, verifier, redirectUri });
    redirect(res, providers.google.authorizeUrl(client, { redirect: redirectUri, challenge, state }));
  }

  async function callback(source, user, req, res, url) {
    const q = url.searchParams;
    const pending = store.consume(q.get('state'));
    if (!pending || pending.source !== source) return back(res, source, false, 'lien');
    if (pending.userId !== user.id) {
      log.warn?.(`${source} : retour de connexion refusé (compte ${user.id}, lancée par un autre compte)`);
      return back(res, source, false, 'compte');
    }
    if (q.get('error')) return back(res, source, false, 'annule');
    const code = q.get('code');
    if (!code || !CODE.test(code)) return back(res, source, false, 'lien');
    const params = { code, verifier: pending.verifier, redirect: pending.redirectUri, dir: user.secrets };
    let result;
    try {
      result =
        source === 'coros'
          ? await providers.coros.exchangeCode(await providers.coros.metadata(), pending.client, params)
          : await providers.google.exchangeCode(providers.google.client(user.secrets, user.googleClientFile), params);
    } catch (e) {
      log.error?.(`${source} : ${e.message}`);
      return back(res, source, false, 'echange');
    }
    resume(user, source);
    log.log?.(`${source} connecté pour ${user.id} (scopes : ${result.scope ?? '?'})`);
    user.onConnected?.(source);
    back(res, source, true);
  }

  return {
    /** GET /api/<source>/connect | callback */
    handle(path, user, req, res, url) {
      const [, , source, step] = path.split('/');
      if (!CALLBACKS[source]) return back(res, 'coros', false, 'lien');
      return step === 'callback' ? callback(source, user, req, res, url) : connect(source, user, req, res);
    },
  };
}
