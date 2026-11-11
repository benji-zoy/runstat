// API de la zone publique (Tailscale Funnel, HTTPS 8443 → nginx :82 → port SYNC_PORT + 2), seul routeur monté sur ce port :
// les proches local-first s'y connectent depuis l'appli publique (RUNSTAT_APP_ORIGINS) pour la sauvegarde chiffrée et le relais.
// Aucune route du tableau de bord. Pas de cookie : jeton de session en Authorization: Bearer (pas de CSRF possible).
// Le CORS n'est qu'un filtre (un client hors navigateur n'envoie pas d'Origin) : la sécurité repose sur l'invitation, la passkey
// et la session.
//   POST /auth/invitation/options { code }              → options de création de passkey (le code ouvre l'enregistrement)
//   POST /auth/invitation/register { code, credential, label } → { token, user } (code consommé, passkey et session créées)
//   POST /auth/login/options                            → options de connexion (passkey découvrable)
//   POST /auth/login { credential, label }              → { token, user }
//   POST /auth/link { code, label }                     → { token, user } (lien de connexion à usage unique, appareil sans passkey)
//   GET  /auth/session                                  → compte, sessions, passkeys
//   DELETE /auth/session | /auth/sessions/<id>          → déconnexion (révocation côté serveur)
//   POST /auth/stepup/options, POST /auth/stepup        → ré-authentification par passkey (5 min)
//   POST /auth/links                    (ré-auth.)      → lien de connexion pour un autre appareil (15 min)
//   POST /auth/credentials/options, POST /auth/credentials, DELETE /auth/credentials/<id> (ré-auth.) → passkeys du compte
//   DELETE /auth/account                (ré-auth.)      → suppression : sauvegarde (douce, 30 jours), passkeys, sessions et codes
//   GET  /backup/manifest | /backup/manifests | /backup/manifests/<v> ; PUT /backup/manifest (If-Match: "v<n>" | If-None-Match: *)
//   POST /backup/objects/missing { ids } ; PUT|GET /backup/objects/<id> ; DELETE /backup (ré-auth., suppression douce)
//   POST /relay/google/token                            → échange ou renouvellement du jeton Google, secret du propriétaire ajouté ici
//   GET  /relay/google/client                           → identifiant (public) du client Google, pour l'adresse de consentement
//   POST /relay/garmin/token, GET /relay/garmin/api/<chemin> → Garmin Personal API (qui refuse le CORS) relayée telle quelle :
//     clé ou jeton Garmin de la personne en X-Garmin-Authorization, chemins et paramètres en liste blanche (moteur), rien gardé
// Journal : méthode, route type, statut, compte ; jamais de corps, de jeton, de code ni d'URL relayée.
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { Readable } from 'node:stream';
import { allowedRequest, API_KEY_HEADER, BEARER_HEADER, GARMIN_API_URL, GARMIN_TOKEN_PATH, JWT } from '#engine/sync/garmin.ts';
import { AuthStore } from './auth-store.mjs';
import { BackupError, BackupStore, MAX_OBJECT, OBJECT_ID } from './backup-store.mjs';
import { ALGORITHMS, WebAuthnError, challengeOf, verifyAssertion, verifyRegistration } from './webauthn.mjs';
import { userPaths } from './accounts.mjs';
import { parseUrl, pipeFile } from './http-safe.mjs';

const MAX_JSON = 64 * 1024;
const MAX_MANIFEST = 12 * 2 ** 20;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 500;
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
/** Réponse Garmin relayée : un fichier d'origine (zip du FIT) tient largement dans 32 Mio */
const MAX_RELAYED = 32 * 2 ** 20;
const RELAYED_TYPES = /^(application\/json|application\/x-zip-compressed|application\/zip|application\/octet-stream)\b/;

/** Liste d'origines (séparées par des virgules) → origines normalisées */
export function parseOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => {
      try {
        return new URL(s.trim()).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Clé de limite d'une adresse : l'adresse entière en IPv4 (y compris « ::ffff:a.b.c.d »), le /64 en IPv6 (un client en
 * reçoit un entier : changer d'adresse dedans ne doit pas donner un nouveau budget). Autre chose : la valeur telle quelle.
 */
export function ipKey(ip) {
  const v = String(ip ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(v)) return v;
  if (!isIPv6(v)) return v.slice(0, 64) || '?';
  // Forme complète : « :: » développé en groupes nuls (une IPv4 finale compte pour deux groupes)
  const [head, tail] = v.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const used = h.length + t.length + (String(t.at(-1) ?? h.at(-1)).includes('.') ? 1 : 0);
  const all = [...h, ...Array(tail === undefined ? 0 : Math.max(0, 8 - used)).fill('0'), ...t];
  return `${all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Seau à jetons : `capacity` requêtes, rechargé de `capacity` par `windowMs` */
export class Limiter {
  constructor(capacity, windowMs, now = Date.now) {
    Object.assign(this, { capacity, windowMs, now, buckets: new Map() });
  }
  take(key) {
    const t = this.now();
    // Mémoire bornée : on oublie d'abord les seaux pleins (rien à retenir), et tout seulement en dernier recours
    if (this.buckets.size > 10_000)
      for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) * this.capacity) / this.windowMs >= this.capacity) this.buckets.delete(k);
    if (this.buckets.size > 10_000) this.buckets.clear();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) * this.capacity) / this.windowMs);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    Object.assign(this, { status, extra });
  }
}

function readJson(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return reject(new HttpError(415, 'JSON attendu'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'requête trop volumineuse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

const label = (v, req) => String(v ?? req.headers['user-agent'] ?? 'appareil').replace(/[^\p{L}\p{N} .,:;()/_-]/gu, '').slice(0, 60) || 'appareil';

/**
 * `accounts()` : comptes (accountsLoader) ; `appOrigins` : origines de l'appli publique ; `googleRedirects` : adresses de retour
 * Google acceptées par le relais ; `quotaBytes` : place de la sauvegarde par compte ; `fetch` : remplaçable dans les tests.
 */
export function createPublicApi({
  accounts,
  usersDir,
  appOrigins,
  googleRedirects = [],
  quotaBytes = 1024 * 2 ** 20,
  log = console,
  now = Date.now,
  fetch: fetchImpl = globalThis.fetch,
  garminApi = GARMIN_API_URL,
}) {
  const auth = new AuthStore(usersDir, now);
  const challenges = new Map();
  const limits = {
    // /auth : 30 par minute et par adresse (/64 en IPv6), toutes routes confondues. Plafond global seulement sur les demandes
    // de challenge anonymes (…/options) : les saturer ne bloque ni les vérifications ni les sessions déjà ouvertes.
    authIp: new Limiter(30, 60_000, now),
    authOptions: new Limiter(300, 60_000, now),
    backup: new Limiter(1200, 10 * 60_000, now),
    relay: new Limiter(30, 3_600_000, now),
    // Une synchro Garmin : un jeton, une page d'activités par centaine, un FIT par sortie, la santé par fenêtres de 28 jours
    garmin: new Limiter(600, 3_600_000, now),
  };

  const userById = (id) => accounts().users.find((u) => u.id === id && u.mode === 'local') ?? null;
  const backupOf = (user) => new BackupStore(userPaths(accounts(), user).base, now);
  /** Octets réservés par les envois d'objets en cours, par compte : des envois simultanés ne passent pas tous le quota */
  const reserved = new Map();
  const publicUser = (u) => ({ id: u.id, name: u.name });

  function newChallenge(data) {
    const t = now();
    for (const [k, v] of challenges) if (v.expires <= t) challenges.delete(k);
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const challenge = randomBytes(32).toString('base64url');
    challenges.set(challenge, { ...data, expires: t + CHALLENGE_TTL_MS });
    return challenge;
  }
  /** Demande en attente du challenge contenu dans clientDataJSON, consommée (usage unique) */
  function takeChallenge(credential, purpose) {
    const c = challengeOf(credential?.response?.clientDataJSON);
    const entry = c && challenges.get(c);
    if (c) challenges.delete(c);
    if (!entry || entry.purpose !== purpose || entry.expires <= now()) throw new HttpError(400, 'demande expirée : recommence');
    return { challenge: c, entry };
  }

  /** rpId de la page qui appelle (origine autorisée), sinon de la première origine */
  const rpOf = (req) => new URL(appOrigins.includes(req.headers.origin) ? req.headers.origin : appOrigins[0]).hostname;
  const creationOptions = (req, user, challenge) => ({
    challenge,
    rp: { id: rpOf(req), name: 'RunStat' },
    user: { id: auth.handle(user.id), name: user.name, displayName: user.name },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: auth.credentials(user.id).map((c) => ({ type: 'public-key', id: c.id })),
    attestation: 'none',
    timeout: CHALLENGE_TTL_MS,
  });
  const requestOptions = (req, challenge, userId) => ({
    challenge,
    rpId: rpOf(req),
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    ...(userId && { allowCredentials: auth.credentials(userId).map((c) => ({ type: 'public-key', id: c.id })) }),
  });

  function addCredential(userId, cred, name) {
    try {
      auth.addCredential(userId, cred, name);
    } catch (e) {
      throw new HttpError(409, e.message);
    }
  }

  /** Vérifie une assertion et renvoie la passkey ; `userId` : imposé (ré-authentification) */
  function assertion(credential, challenge, userId) {
    const stored = auth.credential(String(credential?.id ?? ''));
    if (!stored || (userId && stored.userId !== userId)) throw new HttpError(401, 'clé inconnue');
    const { signCount } = verifyAssertion(credential.response, stored, { challenge, origins: appOrigins });
    auth.touchCredential(stored.id, signCount);
    return stored;
  }

  function session(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization ?? '');
    const s = m && auth.session(m[1]);
    const user = s && userById(s.userId);
    if (!user) throw new HttpError(401, 'session expirée : reconnecte-toi');
    return { s, user };
  }
  const requireStepUp = (s) => {
    if (!(s.stepUpUntil > now())) throw new HttpError(403, 'confirme avec ta passkey', { stepUp: true });
  };

  // ---------- routes ----------

  async function authRoutes(req, res, path, ctx) {
    const m = req.method;
    if (m === 'POST' && path === '/auth/invitation/options') {
      const { code } = await readJson(req);
      const invite = auth.findCode(code, 'invite');
      const user = invite && userById(invite.userId);
      if (!user) throw new HttpError(400, 'invitation inconnue ou expirée : demande un nouveau lien');
      ctx.userId = user.id;
      return { status: 200, body: creationOptions(req, user, newChallenge({ purpose: 'register', userId: user.id, code })) };
    }
    if (m === 'POST' && path === '/auth/invitation/register') {
      const body = await readJson(req);
      const { challenge, entry } = takeChallenge(body.credential, 'register');
      if (entry.code !== body.code) throw new HttpError(400, 'invitation différente');
      const invite = auth.findCode(body.code, 'invite');
      const user = invite && invite.userId === entry.userId && userById(invite.userId);
      if (!user) throw new HttpError(400, 'invitation inconnue ou expirée : demande un nouveau lien');
      const cred = verifyRegistration(body.credential?.response, { challenge, origins: appOrigins });
      // Code consommé et passkey enregistrée dans la même étape (aucun await entre les deux)
      addCredential(user.id, cred, label(body.label, req));
      auth.consumeCode(body.code);
      ctx.userId = user.id;
      return { status: 201, body: { token: auth.createSession(user.id, label(body.label, req), { stepUp: true }), user: publicUser(user) } };
    }
    if (m === 'POST' && path === '/auth/login/options') return { status: 200, body: requestOptions(req, newChallenge({ purpose: 'login' })) };
    if (m === 'POST' && path === '/auth/login') {
      const body = await readJson(req);
      const { challenge } = takeChallenge(body.credential, 'login');
      const stored = assertion(body.credential, challenge);
      const user = userById(stored.userId);
      if (!user) throw new HttpError(401, 'compte supprimé');
      ctx.userId = user.id;
      return { status: 200, body: { token: auth.createSession(user.id, label(body.label, req), { stepUp: true }), user: publicUser(user) } };
    }
    if (m === 'POST' && path === '/auth/link') {
      const body = await readJson(req);
      const link = auth.findCode(body.code, 'link');
      const user = link && userById(link.userId);
      if (!user) throw new HttpError(400, 'lien inconnu ou expiré');
      auth.consumeCode(body.code);
      ctx.userId = user.id;
      return { status: 200, body: { token: auth.createSession(user.id, label(body.label, req)), user: publicUser(user) } };
    }

    // Routes avec session
    const { s, user } = session(req);
    ctx.userId = user.id;
    if (m === 'GET' && path === '/auth/session') {
      return {
        status: 200,
        body: {
          user: publicUser(user),
          session: s.id,
          stepUp: s.stepUpUntil > now(),
          sessions: auth.sessions(user.id).map((x) => ({ id: x.id, label: x.label, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt, current: x.id === s.id })),
          credentials: auth.credentials(user.id).map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
        },
      };
    }
    if (m === 'DELETE' && path === '/auth/session') return auth.revokeSession(user.id, s.id), { status: 204 };
    const sid = path.match(/^\/auth\/sessions\/([\w-]{1,20})$/);
    if (m === 'DELETE' && sid) return { status: auth.revokeSession(user.id, sid[1]) ? 204 : 404 };
    if (m === 'POST' && path === '/auth/stepup/options')
      return { status: 200, body: requestOptions(req, newChallenge({ purpose: 'stepup', userId: user.id, session: s.id }), user.id) };
    if (m === 'POST' && path === '/auth/stepup') {
      const body = await readJson(req);
      const { challenge, entry } = takeChallenge(body.credential, 'stepup');
      if (entry.session !== s.id) throw new HttpError(400, 'demande d’une autre session');
      assertion(body.credential, challenge, user.id);
      auth.stepUp(s.id);
      return { status: 204 };
    }
    if (m === 'DELETE' && path === '/auth/account') {
      requireStepUp(s);
      backupOf(user).softDelete();
      auth.revokeAll(user.id);
      log.log?.(`Compte local-first supprimé par son titulaire : ${user.id}`);
      return { status: 204 };
    }
    if (m === 'POST' && path === '/auth/links') {
      requireStepUp(s);
      return { status: 201, body: auth.createCode(user.id, 'link') };
    }
    if (m === 'POST' && path === '/auth/credentials/options') {
      requireStepUp(s);
      return { status: 200, body: creationOptions(req, user, newChallenge({ purpose: 'add', userId: user.id, session: s.id })) };
    }
    if (m === 'POST' && path === '/auth/credentials') {
      requireStepUp(s);
      const body = await readJson(req);
      const { challenge, entry } = takeChallenge(body.credential, 'add');
      if (entry.session !== s.id) throw new HttpError(400, 'demande d’une autre session');
      addCredential(user.id, verifyRegistration(body.credential?.response, { challenge, origins: appOrigins }), label(body.label, req));
      return { status: 201 };
    }
    const cid = path.match(/^\/auth\/credentials\/([A-Za-z0-9_-]{16,1400})$/);
    if (m === 'DELETE' && cid) {
      requireStepUp(s);
      if (auth.credentials(user.id).length <= 1) throw new HttpError(409, 'garde au moins une passkey');
      return { status: auth.removeCredential(user.id, cid[1]) ? 204 : 404 };
    }
    throw new HttpError(404, 'introuvable');
  }

  async function backupRoutes(req, res, path, ctx) {
    const { s, user } = session(req);
    ctx.userId = user.id;
    if (!limits.backup.take(user.id)) throw new HttpError(429, 'trop de requêtes : réessaie dans quelques minutes');
    const store = backupOf(user);
    const m = req.method;
    if (m === 'GET' && path === '/backup/manifest') {
      const latest = store.latest();
      if (!latest) throw new HttpError(404, 'aucune sauvegarde');
      return { status: 200, body: latest, headers: { ETag: `"v${latest.version}"` } };
    }
    if (m === 'GET' && path === '/backup/manifests') return { status: 200, body: store.list() };
    const ver = path.match(/^\/backup\/manifests\/(\d{1,12})$/);
    if (m === 'GET' && ver) {
      const mf = store.get(Number(ver[1]));
      if (!mf) throw new HttpError(404, 'version inconnue');
      return { status: 200, body: mf };
    }
    if (m === 'PUT' && path === '/backup/manifest') {
      const ifMatch = req.headers['if-match'];
      const expected = req.headers['if-none-match'] === '*' ? null : /^"v(\d{1,12})"$/.exec(ifMatch ?? '')?.[1];
      if (expected === undefined) throw new HttpError(428, 'If-Match: "v<version>" ou If-None-Match: * attendu');
      const body = await readJson(req, MAX_MANIFEST);
      if (store.usage() > quotaBytes) throw new HttpError(507, 'sauvegarde pleine');
      const saved = store.putManifest(body, expected === null ? null : Number(expected));
      // Ménage opportuniste (manifestes de plus de 30 jours, objets orphelins)
      store.gc();
      return { status: 201, body: saved, headers: { ETag: `"v${saved.version}"` } };
    }
    if (m === 'POST' && path === '/backup/objects/missing') {
      const { ids } = await readJson(req, 16 * 2 ** 20);
      return { status: 200, body: { missing: store.missing(ids) } };
    }
    const obj = path.match(/^\/backup\/objects\/([a-f0-9]{64})$/);
    if (obj && m === 'GET') {
      const o = store.objectStream(obj[1]);
      if (!o) throw new HttpError(404, 'objet inconnu');
      return { status: 200, stream: o.stream, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': o.size } };
    }
    if (obj && m === 'PUT') {
      if (!OBJECT_ID.test(obj[1])) throw new HttpError(400, 'identifiant invalide');
      if (store.hasObject(obj[1])) return req.resume(), { status: 200, body: { stored: false } };
      const length = Number(req.headers['content-length'] ?? NaN);
      if (!(length > 0) || length > MAX_OBJECT) throw new HttpError(length > MAX_OBJECT ? 413 : 411, 'taille de l’objet attendue (32 Mio au plus)');
      const id = user.id;
      if (store.usage() + (reserved.get(id) ?? 0) + length > quotaBytes) throw new HttpError(507, 'sauvegarde pleine');
      reserved.set(id, (reserved.get(id) ?? 0) + length);
      const release = () => {
        const left = (reserved.get(id) ?? 0) - length;
        if (left > 0) reserved.set(id, left);
        else reserved.delete(id);
      };
      const tmp = store.tmpFile(obj[1]);
      const size = await new Promise((resolve, reject) => {
        let n = 0;
        const out = createWriteStream(tmp, { mode: 0o640 });
        req.on('data', (c) => {
          n += c.length;
          if (n > length) (req.unpipe(out), out.destroy(), req.destroy(), reject(new HttpError(413, 'objet plus long qu’annoncé')));
        });
        req.on('error', reject);
        out.on('finish', () => resolve(n));
        out.on('error', reject);
        req.pipe(out);
      })
        .catch((e) => (rmSync(tmp, { force: true }), Promise.reject(e)))
        .finally(release);
      if (size !== length) throw (rmSync(tmp, { force: true }), new HttpError(400, 'objet tronqué'));
      return { status: 201, body: { stored: store.commitObject(obj[1], tmp) } };
    }
    if (m === 'DELETE' && path === '/backup') {
      requireStepUp(s);
      store.softDelete();
      return { status: 204 };
    }
    throw new HttpError(404, 'introuvable');
  }

  /**
   * Garmin Personal API : clé (POST du jeton) ou jeton Bearer de la personne en X-Garmin-Authorization (Authorization porte
   * la session), seulement les lectures de la liste blanche du moteur, réponse bornée et jamais conservée.
   */
  async function garminRelay(req, path, url, ctx) {
    const { user } = session(req);
    ctx.userId = user.id;
    if (!limits.garmin.take(user.id)) throw new HttpError(429, 'trop de requêtes Garmin : réessaie plus tard');
    const auth = String(req.headers['x-garmin-authorization'] ?? '');
    if (req.method === 'POST' && path === '/relay/garmin/token') {
      if (!API_KEY_HEADER.test(auth)) throw new HttpError(400, 'clé Garmin attendue');
      req.resume();
      const r = await fetchImpl(`${garminApi}${GARMIN_TOKEN_PATH}`, { method: 'POST', headers: { Authorization: auth, Accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
      const text = (await r.text()).slice(0, 16_384).trim();
      const token = text.startsWith('{') ? String(JSON.parse(text)['access_token'] ?? '') : text;
      if (r.ok && JWT.test(token)) return { status: 200, stream: Readable.from([token]), headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
      // `garmin` : refus de Garmin, pas de la session RunStat (le client ne met en pause la source que dans ce cas)
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new HttpError(401, 'clé refusée par Garmin', { garmin: true });
      throw new HttpError(r.status === 429 ? 429 : 502, r.status === 429 ? 'limite de débit Garmin atteinte' : 'Garmin injoignable');
    }
    const garminPath = path.slice('/relay/garmin/api'.length);
    if (req.method !== 'GET' || !path.startsWith('/relay/garmin/api/')) throw new HttpError(404, 'introuvable');
    if (!BEARER_HEADER.test(auth)) throw new HttpError(400, 'jeton Garmin attendu');
    if (!allowedRequest(garminPath, url.searchParams)) throw new HttpError(400, 'requête Garmin refusée (lecture seule)');
    const r = await fetchImpl(`${garminApi}${garminPath}${url.search}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 || r.status === 403) return (await r.body?.cancel(), { status: r.status, body: { error: 'jeton refusé par Garmin', garmin: true } });
    if ([204, 404, 429].includes(r.status)) return (await r.body?.cancel(), { status: r.status });
    const type = r.headers.get('content-type') ?? '';
    if (r.status !== 200 || !RELAYED_TYPES.test(type) || Number(r.headers.get('content-length') ?? 0) > MAX_RELAYED)
      return (await r.body?.cancel(), { status: 502, body: { error: 'réponse Garmin inattendue' } });
    // Lue entièrement, bornée : un flux coupé au milieu laisserait au client un fichier tronqué
    const chunks = [];
    let size = 0;
    for await (const c of r.body ?? []) {
      size += c.length;
      if (size > MAX_RELAYED) throw new HttpError(502, 'réponse Garmin trop volumineuse');
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    return { status: 200, stream: Readable.from([body]), headers: { 'Content-Type': type.split(';')[0], 'Content-Length': body.length } };
  }

  /** Jeton Google : secret client du propriétaire ajouté ici, seulement les échanges prévus, réponse filtrée */
  async function relayRoutes(req, res, path, ctx, url) {
    if (path.startsWith('/relay/garmin/')) return garminRelay(req, path, url, ctx);
    if (req.method === 'GET' && path === '/relay/google/client') {
      ctx.userId = session(req).user.id;
      const client = googleClient();
      if (!client) throw new HttpError(503, 'appli Google absente du serveur');
      return { status: 200, body: { client_id: client.client_id, redirects: googleRedirects } };
    }
    if (req.method !== 'POST' || path !== '/relay/google/token') throw new HttpError(404, 'introuvable');
    const { user } = session(req);
    ctx.userId = user.id;
    if (!limits.relay.take(user.id)) throw new HttpError(429, 'trop de demandes de jeton : réessaie plus tard');
    const body = await readJson(req);
    const params = {};
    if (body.grant_type === 'authorization_code') {
      if (!googleRedirects.includes(body.redirect_uri)) throw new HttpError(400, 'adresse de retour refusée');
      if (typeof body.code !== 'string' || body.code.length > 1000) throw new HttpError(400, 'code invalide');
      if (typeof body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) throw new HttpError(400, 'PKCE exigé');
      Object.assign(params, { grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri });
    } else if (body.grant_type === 'refresh_token') {
      if (typeof body.refresh_token !== 'string' || body.refresh_token.length > 1000) throw new HttpError(400, 'jeton invalide');
      Object.assign(params, { grant_type: 'refresh_token', refresh_token: body.refresh_token });
    } else throw new HttpError(400, 'grant_type authorization_code ou refresh_token');
    const client = googleClient();
    if (!client) throw new HttpError(503, 'appli Google absente du serveur');
    const r = await fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: client.client_id, client_secret: client.client_secret }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await r.json().catch(() => ({}));
    const keep = ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type', 'error', 'error_description'];
    return { status: r.ok ? 200 : r.status === 400 || r.status === 401 ? r.status : 502, body: Object.fromEntries(keep.filter((k) => k in json).map((k) => [k, json[k]])) };
  }

  /** Client Google du propriétaire (secrets du compte propriétaire) */
  function googleClient() {
    const acc = accounts();
    const owner = acc.users.find((u) => u.role === 'owner');
    const file = join(userPaths(acc, owner).secrets, 'google-client.json');
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const c = raw.web ?? raw.installed ?? raw;
    return c?.client_id && c?.client_secret ? c : null;
  }

  // ---------- point d'entrée ----------

  const cors = (origin) =>
    origin
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'ETag' }
      : {};

  return async function handle(req, res) {
    const url = parseUrl(req.url);
    if (!url) return res.writeHead(400, { 'Cache-Control': 'no-store' }).end();
    const path = url.pathname;
    const origin = req.headers.origin;
    const area = /^\/(auth|backup|relay)(\/|$)/.exec(path)?.[1];
    const ctx = { userId: null };
    // Chemin relayé à Garmin jamais journalisé (identifiants de sortie, dates)
    const template = path.startsWith('/relay/garmin/api/') ? '/relay/garmin/api/:route' : path.replace(/\/[A-Za-z0-9_-]{20,}$/, '/:id').replace(/\/\d+$/, '/:n');
    const finish = (status, body, headers = {}, stream) => {
      log.log?.(`public ${req.method} ${template} ${status} ${ctx.userId ?? '-'}`);
      const h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors(origin && appOrigins.includes(origin) ? origin : null), ...headers };
      if (stream) {
        res.writeHead(status, h);
        return pipeFile(stream, res);
      }
      if (body === undefined) return res.writeHead(status, h).end();
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...h });
      res.end(JSON.stringify(body));
    };
    if (origin && !appOrigins.includes(origin)) return finish(403, { error: 'origine refusée' });
    if (req.method === 'OPTIONS') {
      if (!origin) return finish(400, { error: 'pré-vérification sans origine' });
      return finish(204, undefined, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'authorization, content-type, if-match, if-none-match, x-garmin-authorization',
        'Access-Control-Max-Age': '600',
      });
    }
    if (!area || !accounts().multi) return finish(404, { error: 'introuvable' });
    // Adresse du client : posée par nginx (:82) d'après la valeur la plus à droite de X-Forwarded-For (celle de Funnel)
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?');
    if (area === 'auth' && (!limits.authIp.take(ipKey(ip)) || (path.endsWith('/options') && !limits.authOptions.take('*'))))
      return finish(429, { error: 'trop de tentatives : réessaie dans une minute' });
    try {
      const out = await (area === 'auth' ? authRoutes : area === 'backup' ? backupRoutes : relayRoutes)(req, res, path, ctx, url);
      return finish(out.status, out.body, out.headers, out.stream);
    } catch (e) {
      if (e instanceof HttpError) return finish(e.status, { error: e.message, ...e.extra });
      if (e instanceof BackupError) return finish(e.status, { error: e.message, ...e.extra });
      if (e instanceof WebAuthnError) return finish(400, { error: `passkey refusée : ${e.message}` });
      log.error?.(`public ${req.method} ${template} : ${e.message}`);
      return finish(500, { error: 'erreur du serveur' });
    }
  };
}
