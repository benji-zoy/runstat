// Connexion Strava depuis le site (Réglages), sans terminal : chaque athlète enregistre sa propre appli Strava
// (client_id + client_secret, abonnement Strava requis pour la créer), puis l'autorise par redirection OAuth.
//   PUT /api/strava/client   (en-tête X-RunStat) → secrets/strava-client.json, jamais relu par le site
//   GET /api/strava/connect  → 302 vers strava.com/oauth/authorize (state aléatoire, 10 min, usage unique)
//   GET /api/strava/callback → échange du code, secrets/strava-tokens.json, puis 302 vers /aujourdhui?strava=ok|refus
// Les deux GET sont des navigations du navigateur (pas d'en-tête X-RunStat possible) : la protection CSRF est le state,
// et rien n'est écrit sans state valide. redirect_uri = origine du site, lue dans les en-têtes transmis par nginx
// (X-Forwarded-Host / Host, X-Forwarded-Proto) et acceptée seulement si elle figure dans SYNC_PUBLIC_ORIGINS
// (sans cette variable : localhost et 127.0.0.1 seulement, pour le poste). Strava refuse en plus tout domaine autre que
// le domaine de rappel de l'appli (et localhost).
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidEntry, readJsonFile, writeJsonAtomic } from './entries.mjs';
import { readSecret, secretsDir, writeSecret } from './secrets.mjs';
import { authorizeUrl, exchangeCode } from './strava.mjs';

export const STATE_TTL_MS = 10 * 60_000;
/** Demandes en attente gardées au plus (les plus anciennes sont oubliées) */
const MAX_PENDING = 20;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const CALLBACK_PATH = '/api/strava/callback';
const TOKENS = 'strava-tokens.json';
const CLIENT = 'strava-client.json';

/** Liste blanche des origines publiques du site (SYNC_PUBLIC_ORIGINS, séparées par des virgules) ; null = poste local */
export function allowedOrigins(value = process.env.SYNC_PUBLIC_ORIGINS) {
  const list = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * Adresse par laquelle se connecter à Strava, à déclarer comme domaine de rappel de l'appli : la première en HTTPS
 * de la liste blanche (Tailscale Serve), sinon la première ; null sans liste (poste local : l'adresse courante).
 */
export const preferredOrigin = (allowed = allowedOrigins()) => allowed?.find((o) => o.startsWith('https:')) ?? allowed?.[0] ?? null;

/** Origine du site telle que le navigateur la voit, ou null si elle n'est pas dans la liste blanche */
export function publicOrigin(headers, allowed) {
  const first = (v) => String(v ?? '').split(',')[0].trim();
  const host = first(headers['x-forwarded-host']) || first(headers.host);
  const proto = first(headers['x-forwarded-proto']).toLowerCase() || 'http';
  if (!host || !/^https?$/.test(proto) || /[/\\@?#\s]/.test(host)) return null;
  let origin;
  try {
    origin = new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
  return (allowed ? allowed.includes(origin) : LOCAL.test(origin)) ? origin : null;
}

/** States OAuth en mémoire : aléatoires, 10 minutes, usage unique */
export class StateStore {
  #pending = new Map();
  constructor(now = Date.now) {
    this.now = now;
  }
  create(data) {
    for (const [k, v] of this.#pending) if (v.expires <= this.now()) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value);
    const state = randomBytes(24).toString('base64url');
    this.#pending.set(state, { ...data, expires: this.now() + STATE_TTL_MS });
    return state;
  }
  /** Données du state, une seule fois, ou null (inconnu, déjà utilisé ou expiré) */
  consume(state) {
    if (typeof state !== 'string' || !state) return null;
    const entry = this.#pending.get(state);
    this.#pending.delete(state);
    return entry && entry.expires > this.now() ? entry : null;
  }
}

/** Identifiants de l'appli Strava saisis dans Réglages : validation stricte, le secret n'est jamais renvoyé */
export function validateStravaClient(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidEntry(['objet attendu']);
  for (const k of Object.keys(body)) if (k !== 'client_id' && k !== 'client_secret') errors.push(`${k} : champ inconnu`);
  const id = typeof body.client_id === 'string' || typeof body.client_id === 'number' ? String(body.client_id).trim() : '';
  const secret = typeof body.client_secret === 'string' ? body.client_secret.trim() : '';
  if (!/^\d{1,12}$/.test(id)) errors.push('Client ID : nombre attendu (strava.com/settings/api)');
  if (!/^[A-Za-z0-9]{20,100}$/.test(secret)) errors.push('Client Secret : 40 caractères attendus (strava.com/settings/api)');
  if (errors.length) throw new InvalidEntry(errors);
  return { client_id: id, client_secret: secret };
}

/** État Strava pour GET /api/sync : rien des jetons ni du secret, seulement leur présence et l'athlète */
export function stravaStatus() {
  const read = (name) => {
    try {
      return readSecret(name);
    } catch {
      return null; // fichier en cours d'écriture
    }
  };
  const tokens = read(TOKENS);
  const connected = Boolean(tokens?.refresh_token);
  return {
    stravaClient: Boolean(read(CLIENT)?.client_id),
    stravaConnected: connected,
    stravaAthlete: connected && tokens.athleteId ? [tokens.athleteName, `athlète ${tokens.athleteId}`].filter(Boolean).join(', ') : null,
  };
}

const redirect = (res, location) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
};
/** Retour vers le site : chemin relatif à l'origine de la requête, jamais une adresse fournie par le client */
const back = (res, ok, reason) =>
  redirect(res, `/aujourdhui?strava=${ok ? 'ok' : 'refus'}${reason ? `&raison=${reason}` : ''}`);

/**
 * Routes de connexion. `raw` : dossier data-raw (sync-state.json) ; `onConnected` : lancé après une connexion réussie
 * (synchro) ; `log` : journal du service, jamais de jeton ni de code.
 */
export function stravaConnectRoutes({ raw, origins = allowedOrigins(), store = new StateStore(), onConnected = () => {}, log = console }) {
  return {
    /** PUT /api/strava/client : nouvelle appli → les jetons de l'ancienne ne valent plus rien */
    saveClient(body) {
      const client = validateStravaClient(body);
      const previous = readSecret(CLIENT);
      writeSecret(CLIENT, client);
      if (previous?.client_id && previous.client_id !== client.client_id) rmSync(join(secretsDir, TOKENS), { force: true });
      return stravaStatus();
    },

    /** GET /api/strava/connect */
    connect(req, res) {
      const origin = publicOrigin(req.headers, origins);
      if (!origin) {
        log.warn?.(`Strava : connexion refusée depuis un hôte hors liste (${req.headers['x-forwarded-host'] ?? req.headers.host ?? '?'})`);
        return back(res, false, 'origine');
      }
      const client = readSecret(CLIENT);
      if (!client?.client_id) return back(res, false, 'appli');
      const state = store.create({ origin });
      redirect(res, authorizeUrl(client.client_id, `${origin}${CALLBACK_PATH}`, state));
    },

    /** GET /api/strava/callback?code&state&scope (ou ?error=access_denied&state) */
    async callback(req, res, url) {
      const q = url.searchParams;
      if (!store.consume(q.get('state'))) return back(res, false, 'lien');
      if (q.get('error')) return back(res, false, 'annule');
      const code = q.get('code');
      const scope = q.get('scope') ?? '';
      if (!code || !/^[A-Za-z0-9]{1,200}$/.test(code)) return back(res, false, 'lien');
      if (!/(^|,)activity:read(_all)?(,|$)/.test(scope)) return back(res, false, 'portee');
      let athlete;
      try {
        athlete = await exchangeCode(code, scope);
      } catch (e) {
        log.error?.(`Strava : ${e.message}`);
        return back(res, false, 'echange');
      }
      // Jetons neufs : la source sort de pause tout de suite (run.mjs le ferait aussi d'après la date du fichier)
      const stateFile = join(raw, 'sync-state.json');
      try {
        const st = existsSync(stateFile) ? readJsonFile(stateFile, {}) : {};
        if (st.strava?.reauthSince) {
          delete st.strava.reauthSince;
          writeJsonAtomic(stateFile, st);
        }
      } catch (e) {
        log.error?.(`Strava : sync-state.json illisible (${e.message})`);
      }
      log.log?.(`Strava connecté (athlète ${athlete.athleteId ?? '?'}, scopes : ${scope})`);
      onConnected();
      back(res, true, /activity:read_all/.test(scope) ? null : 'public');
    },
  };
}
