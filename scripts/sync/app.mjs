// Routes de l'API du site (/api/…), pour une zone de confiance (accounts.mjs) : chaque requête est d'abord rattachée à un
// compte, puis ne touche qu'aux dossiers de ce compte (userPaths). server.mjs monte une instance par port d'écoute.
//   GET  /api/me    → { id, name, role, mode, multi, admin } (compte de la requête)
//   GET  /api/data/coros.json | routes.json → instantané du compte (nginx y renvoie /data/)
//   GET  /api/sync  → { running, queued, startedAt, nextAt, state (sync-state.json), log (fin du dernier run),
//                       stravaClient, stravaConnected, stravaAthlete, corosConnected, googleConnected, googleClient
//                       (présence des applis et des jetons, jamais leur contenu),
//                       stravaOrigin (adresse du site pour la connexion Strava) }
//   POST /api/sync  → 202 lancée ou en file | 409 déjà en cours | 429 trop tôt après la précédente
//   POST /api/fit?id=<labelId | strava:id> → tracé d'une seule sortie (« Affiner avec le tracé ») : 202 | 400 | 409
//   GET|PUT /api/goals, GET|PUT /api/athlete, GET|PUT /api/sources, GET|PUT|DELETE /api/results/<id>[?replaces=date-….json]
//     → saisie depuis le site (scripts/sync/entries.mjs), puis reconstruction seule (run.mjs --rebuild) : 200 | 400 | 404
//   POST /api/strava/archive (corps application/zip, 2 Gio au plus) → import de l'archive Strava puis reconstruction :
//     202 | 400 | 413 | 507
//   PUT /api/strava/client, GET /api/strava/connect, GET /api/strava/callback → connexion Strava depuis Réglages
//     (scripts/sync/strava-connect.mjs : les deux GET sont des navigations, protégées par le state lié au compte)
//   GET /api/coros/connect|callback, /api/google/connect|callback → connexion COROS et Google (oauth-connect.mjs)
//   GET|PUT /api/admin/users → comptes de l'instance (propriétaire, par le tailnet seulement)
//   POST /api/admin/invitations { id, name } → lien d'invitation d'un proche local-first (compte créé au besoin, 7 jours)
//   POST /api/admin/users/<id>/reset → passkeys, sessions et codes du compte local-first révoqués, nouvelle invitation
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_ID, InvalidEntry, deleteResult, readJsonFile, saveResult, validateAthlete, validateGoals, validateSources,
  writeJsonAtomic,
} from './entries.mjs';
import { fileKey, readSources } from './sources.mjs';
import { CALLBACK_PATH, preferredOrigin, stravaStatus } from './strava-connect.mjs';
import { CONNECT_PATHS, connectStatus } from './oauth-connect.mjs';
import { resolveUser, saveUsers, userPaths } from './accounts.mjs';
import { AuthStore } from './auth-store.mjs';
import { jobs } from './queue.mjs';

const MAX_BODY = 64 * 1024;
const MIN_GAP_MS = 20_000; // anti-rebond des clics
const SIZE_TTL_MS = 60_000;
const DATA_FILES = new Set(['coros.json', 'routes.json']);
const ENTRY = /^\/api\/(goals|athlete|sources|results\/[^/]+)$/;
const STRAVA_NAV = ['/api/strava/connect', CALLBACK_PATH];

const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

/** Corps JSON d'une requête, limité à MAX_BODY */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new InvalidEntry(['requête trop volumineuse']));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new InvalidEntry(['JSON invalide']));
      }
    });
    req.on('error', reject);
  });
}

function readState(raw) {
  const file = join(raw, 'sync-state.json');
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {}; // fichier en cours d'écriture
  }
}

/** Taille d'un dossier (octets), récursive */
function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : e.isFile() ? statSync(p).size : 0;
  }
  return total;
}

/**
 * Dossiers d'un compte créés au besoin, droits explicites (secrets lisibles par le seul service) : sur le NAS, les ACL
 * héritées de DSM ouvriraient sinon les nouveaux dossiers en écriture à tous (rwxrwxrwx+).
 */
export function ensureUserDirs(paths) {
  const dirs = [[paths.base, 0o755], [paths.raw, 0o755], [paths.snapshot, 0o755], [paths.secrets, 0o700]];
  for (const [dir, mode] of dirs) {
    if (!dir) continue;
    const fresh = !existsSync(dir);
    mkdirSync(dir, { recursive: true, mode });
    if (fresh || mode === 0o700) chmodSync(dir, mode);
  }
}

/**
 * `zone` : 'lan' | 'tailnet' ; `accounts()` : comptes (accountsLoader) ; `queue` : RunQueue partagée par les zones ;
 * `strava` : routes de connexion (stravaConnectRoutes) ; `nextAt()` : prochaine synchro planifiée ;
 * `quotaBytes` : place par compte hébergé (instance à plusieurs comptes) ; `maxArchive` : taille d'une archive Strava.
 */
export function createApp({ zone, accounts, queue, strava, oauth, appUrl = null, publicUrl = null, nextAt = () => null, quotaBytes = 2048 * 2 ** 20, maxArchive = 2 * 2 ** 30, log = console, now = Date.now }) {
  const sizes = new Map();
  /** Place occupée par un compte, recalculée au plus une fois par minute */
  const used = (id, base) => {
    const hit = sizes.get(id);
    if (hit && now() - hit.at < SIZE_TTL_MS) return hit.bytes;
    const bytes = dirSize(base);
    sizes.set(id, { bytes, at: now() });
    return bytes;
  };
  const overQuota = (acc, user, paths) => acc.multi && used(user.id, paths.base) > quotaBytes;

  const enqueue = (user, job) => queue.enqueue(user.id, job);
  const syncStatus = (user) => {
    const q = queue.status(user.id);
    return { running: q.running || q.queued, queued: q.queued && !q.running, startedAt: q.startedAt, log: q.log };
  };

  /** Saisie : lecture, ou écriture validée suivie d'une reconstruction des données du site */
  async function entries(req, res, path, url, user, paths) {
    const { raw } = paths;
    const goalsFile = join(raw, 'goals.json');
    const athleteFile = join(raw, 'athlete.json');
    const sourcesFile = join(raw, 'sources.json');
    const result = path.match(/^\/api\/results\/([^/]+)$/);
    if (result && !ACTIVITY_ID.test(result[1])) return send(res, 400, { error: 'identifiant de sortie invalide' });
    if (req.method === 'GET') {
      if (path === '/api/goals') return send(res, 200, readJsonFile(goalsFile, []));
      if (path === '/api/athlete') return send(res, 200, readJsonFile(athleteFile, null));
      if (path === '/api/sources') return send(res, 200, readSources(raw));
      return send(res, 200, readJsonFile(join(raw, 'results', `${fileKey(result[1])}.json`), null));
    }
    if (req.method !== 'PUT' && !(req.method === 'DELETE' && result)) return send(res, 405, { error: 'méthode non autorisée' });
    if (req.method === 'PUT' && overQuota(accounts(), user, paths)) return send(res, 507, { error: 'espace du compte plein' });
    const replaces = url.searchParams.get('replaces');
    let saved;
    try {
      mkdirSync(raw, { recursive: true });
      if (req.method === 'DELETE') {
        if (!deleteResult(raw, result[1], replaces)) return send(res, 404, { error: 'aucun classement pour cette sortie' });
      } else {
        const body = await readBody(req);
        if (path === '/api/goals') writeJsonAtomic(goalsFile, (saved = validateGoals(body)));
        else if (path === '/api/athlete') writeJsonAtomic(athleteFile, (saved = validateAthlete(body)));
        else if (path === '/api/sources') writeJsonAtomic(sourcesFile, (saved = validateSources(body)));
        else saved = saveResult(raw, result[1], body, replaces);
      }
    } catch (e) {
      if (e instanceof InvalidEntry) return send(res, 400, { error: e.message, errors: e.errors });
      throw e;
    }
    // Écritures atomiques : sans risque pendant un run, qui sera simplement suivi d'une reconstruction
    enqueue(user, jobs.rebuild());
    const st = syncStatus(user);
    send(res, 200, { saved: saved ?? null, running: st.running, startedAt: st.startedAt });
  }

  /**
   * Archive Strava : corps écrit en flux dans data-raw/import/ (jamais en mémoire), signature zip vérifiée,
   * puis run.mjs --import-strava en file (le fichier est supprimé après l'import).
   */
  async function stravaArchive(req, res, user, paths) {
    if (!/^application\/(zip|x-zip-compressed|octet-stream)$/.test(req.headers['content-type'] ?? ''))
      return send(res, 400, { error: 'archive zip attendue' });
    const length = Number(req.headers['content-length'] ?? NaN);
    if (length > maxArchive) return send(res, 413, { error: 'archive trop volumineuse' });
    if (overQuota(accounts(), user, paths)) return send(res, 507, { error: 'espace du compte plein' });
    const dir = join(paths.raw, 'import');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `strava-${now()}.zip`);
    const ok = await new Promise((resolve) => {
      let size = 0;
      const out = createWriteStream(file);
      req.on('data', (c) => {
        size += c.length;
        if (size > maxArchive) (req.unpipe(out), out.destroy(), req.destroy(), resolve(413));
      });
      req.on('error', () => resolve(400));
      // Envoi interrompu (onglet fermé, réseau coupé)
      req.on('close', () => !req.complete && (out.destroy(), resolve(400)));
      out.on('finish', () => resolve(size > 0 ? 200 : 400));
      out.on('error', () => resolve(500));
      req.pipe(out);
    });
    const magic = Buffer.alloc(4);
    if (ok === 200) {
      const fd = openSync(file, 'r');
      readSync(fd, magic, 0, 4, 0);
      closeSync(fd);
    }
    if (ok !== 200 || magic.readUInt32LE(0) !== 0x04034b50) {
      rmSync(file, { force: true });
      if (ok === 413) return send(res, 413, { error: 'archive trop volumineuse' });
      return send(res, ok === 500 ? 500 : 400, { error: 'ce fichier n’est pas une archive zip' });
    }
    // Le fichier est sur le disque : l'import attend son tour, même si une synchro tourne
    if (enqueue(user, jobs.archive(file)) === 'busy') {
      rmSync(file, { force: true });
      return send(res, 409, { error: 'des archives attendent déjà leur import, réessaie plus tard' });
    }
    send(res, 202, { running: true, startedAt: syncStatus(user).startedAt });
  }

  /** Instantané du compte (coros.json, routes.json), avec ETag pour les requêtes conditionnelles du site */
  function data(req, res, name, paths) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'méthode non autorisée' });
    if (!DATA_FILES.has(name)) return send(res, 404, { error: 'introuvable' });
    const file = join(paths.snapshot, name);
    if (!existsSync(file)) return send(res, 404, { error: 'aucune donnée pour l’instant' });
    const st = statSync(file);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  const authStore = () => new AuthStore(accounts().dir, now);
  /** Lien d'invitation vers l'appli publique (le fragment n'est jamais envoyé au serveur de l'appli) */
  function invitation(userId) {
    const { code, expiresAt } = authStore().createCode(userId, 'invite');
    return { link: `${appUrl}rejoindre#nas=${encodeURIComponent(publicUrl)}&code=${code}`, expiresAt };
  }

  /** Invitation d'un proche local-first : compte créé s'il n'existe pas (mode local, sans login Tailscale) */
  async function invite(req, res) {
    if (!appUrl || !publicUrl) return send(res, 503, { error: 'accès public non configuré (RUNSTAT_APP_URL, RUNSTAT_PUBLIC_URL)' });
    const acc = accounts();
    try {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || typeof body.id !== 'string') throw new InvalidEntry(['identifiant attendu']);
      let target = acc.users.find((u) => u.id === body.id);
      if (!target) {
        const users = saveUsers(acc.dir, [...acc.users.map(({ legacy, ...u }) => u), { id: body.id, name: body.name, role: 'member', mode: 'local', logins: [] }]);
        target = users.find((u) => u.id === body.id);
        log.log?.(`Compte local-first créé : ${target.id}`);
      }
      if (target.mode !== 'local') throw new InvalidEntry([`${target.id} est un compte hébergé (login Tailscale), pas local-first`]);
      return send(res, 201, invitation(target.id));
    } catch (e) {
      if (e instanceof InvalidEntry) return send(res, 400, { error: e.message, errors: e.errors });
      throw e;
    }
  }

  /** Comptes de l'instance : le propriétaire garde son compte, son rôle et le login de la requête */
  async function admin(req, res, user, headers) {
    const acc = accounts();
    if (req.method === 'GET') return send(res, 200, acc.users);
    if (req.method !== 'PUT') return send(res, 405, { error: 'méthode non autorisée' });
    try {
      const body = await readBody(req);
      const me = Array.isArray(body) ? body.find((u) => u?.id === user.id) : null;
      const login = String(headers['tailscale-user-login'] ?? '').trim().toLowerCase();
      const errors = [];
      if (!me || me.role !== 'owner') errors.push('ton compte reste dans la liste, propriétaire');
      else if (!(me.logins ?? []).some((l) => String(l).trim().toLowerCase() === login)) errors.push(`garde ton login ${login} dans ton compte`);
      if (errors.length) throw new InvalidEntry(errors);
      const users = saveUsers(acc.dir, body);
      for (const u of users) if (u.mode === 'hosted') ensureUserDirs(userPaths(acc, u));
      // Compte retiré ou passé en hébergé : plus d'accès public (passkeys, sessions, invitations)
      for (const old of acc.users) if (old.mode === 'local' && !users.some((u) => u.id === old.id && u.mode === 'local')) authStore().revokeAll(old.id);
      log.log?.(`Comptes mis à jour par ${user.id} : ${users.map((u) => u.id).join(', ')}`);
      return send(res, 200, users);
    } catch (e) {
      if (e instanceof InvalidEntry) return send(res, 400, { error: e.message, errors: e.errors });
      throw e;
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://runstat');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'introuvable' });
    const acc = accounts();
    const who = resolveUser(acc, zone, req.headers);
    if (!who.user) return send(res, who.status, { error: who.error });
    const { user } = who;
    const paths = userPaths(acc, user);
    const owner = acc.users.find((u) => u.role === 'owner');
    const ctx = {
      id: user.id,
      raw: paths.raw,
      secrets: paths.secrets,
      // Client Google du propriétaire : un seul projet Google Cloud par instance
      googleClientFile: join(userPaths(acc, owner).secrets, 'google-client.json'),
      // Connexion d'une source : synchro lancée aussitôt si le compte l'utilise
      onConnected: (source = 'strava') => {
        const s = readSources(paths.raw);
        const used = source === 'strava' ? s.activities === 'strava' : source === 'google' ? s.health === 'google' : s.activities === 'coros' || s.health === 'coros';
        if (used) enqueue(user, jobs.full(`${source} connecté`));
      },
    };

    // Navigations du navigateur (redirections OAuth) : sans en-tête X-RunStat, protégées par le state lié au compte
    if (STRAVA_NAV.includes(path)) {
      if (req.method !== 'GET') return send(res, 405, { error: 'méthode non autorisée' });
      try {
        return path === CALLBACK_PATH ? await strava.callback(ctx, req, res, url) : strava.connect(ctx, req, res);
      } catch (e) {
        log.error?.('Connexion Strava :', e.message);
        return send(res, 500, { error: 'connexion Strava impossible' });
      }
    }
    if (CONNECT_PATHS.includes(path)) {
      if (req.method !== 'GET') return send(res, 405, { error: 'méthode non autorisée' });
      try {
        return await oauth.handle(path, ctx, req, res, url);
      } catch (e) {
        log.error?.('Connexion :', e.message);
        return send(res, 500, { error: 'connexion impossible' });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // En-tête propre au site : une page d'un autre domaine ne peut pas l'envoyer sans pré-vérification CORS (refusée)
      if (req.headers['x-runstat'] !== 'sync') return send(res, 403, { error: 'en-tête X-RunStat manquant' });
    }
    if (path === '/api/me') {
      if (req.method !== 'GET') return send(res, 405, { error: 'méthode non autorisée' });
      return send(res, 200, { id: user.id, name: user.name, role: user.role, mode: user.mode, multi: acc.multi, admin: who.admin });
    }
    if (path.startsWith('/api/data/')) return data(req, res, path.slice('/api/data/'.length), paths);
    if (path.startsWith('/api/admin/') && !who.admin) return send(res, 403, { error: 'réservé au propriétaire, par l’adresse Tailscale' });
    if (path === '/api/admin/invitations') {
      if (req.method !== 'POST') return send(res, 405, { error: 'méthode non autorisée' });
      return await invite(req, res);
    }
    const reset = path.match(/^\/api\/admin\/users\/([a-z0-9-]{1,32})\/reset$/);
    if (reset) {
      if (req.method !== 'POST') return send(res, 405, { error: 'méthode non autorisée' });
      const target = acc.users.find((u) => u.id === reset[1]);
      if (!target || target.mode !== 'local') return send(res, 404, { error: 'aucun compte local-first à ce nom' });
      authStore().revokeAll(target.id);
      log.log?.(`Accès réinitialisé pour ${target.id} par ${user.id}`);
      if (!appUrl || !publicUrl) return send(res, 200, { link: null });
      return send(res, 200, invitation(target.id));
    }
    if (path === '/api/admin/users') {
      try {
        return await admin(req, res, user, req.headers);
      } catch (e) {
        log.error?.('Comptes :', e);
        return send(res, 500, { error: 'écriture impossible' });
      }
    }
    if (path === '/api/strava/client') {
      if (req.method !== 'PUT') return send(res, 405, { error: 'méthode non autorisée' });
      try {
        return send(res, 200, strava.saveClient(ctx, await readBody(req)));
      } catch (e) {
        if (e instanceof InvalidEntry) return send(res, 400, { error: e.message, errors: e.errors });
        log.error?.('Appli Strava :', e.message);
        return send(res, 500, { error: 'écriture impossible' });
      }
    }
    if (path === '/api/strava/archive') {
      if (req.method !== 'POST') return send(res, 405, { error: 'méthode non autorisée' });
      try {
        return await stravaArchive(req, res, user, paths);
      } catch (e) {
        log.error?.('Archive Strava :', e);
        return send(res, 500, { error: 'envoi impossible' });
      }
    }
    if (ENTRY.test(path)) {
      try {
        return await entries(req, res, path, url, user, paths);
      } catch (e) {
        log.error?.('Saisie :', e);
        return send(res, 500, { error: 'écriture impossible' });
      }
    }
    if (path !== '/api/sync' && path !== '/api/fit') return send(res, 404, { error: 'introuvable' });
    if (req.method === 'POST') {
      const q = queue.status(user.id);
      if (path === '/api/fit') {
        const id = url.searchParams.get('id') ?? '';
        if (!ACTIVITY_ID.test(id)) return send(res, 400, { error: 'identifiant de sortie invalide' });
        if (enqueue(user, jobs.fit(id)) === 'busy') return send(res, 409, { error: 'un autre tracé attend déjà', startedAt: q.startedAt });
        return send(res, 202, { running: true, startedAt: queue.status(user.id).startedAt });
      }
      if (q.running && q.kind === 'full') return send(res, 409, { error: 'synchro déjà en cours', startedAt: q.startedAt });
      // Anti-rebond après une synchro complète (une reconstruction après saisie ne compte pas)
      const wait = q.fullAt + MIN_GAP_MS - now();
      if (!q.running && wait > 0) return send(res, 429, { error: 'synchro toute récente', retryInSec: Math.ceil(wait / 1000) });
      const r = enqueue(user, jobs.full('manuelle'));
      return send(res, 202, { running: true, queued: r !== 'started', startedAt: queue.status(user.id).startedAt });
    }
    if (req.method !== 'GET' || path !== '/api/sync') return send(res, 405, { error: 'méthode non autorisée' });
    send(res, 200, {
      ...syncStatus(user),
      nextAt: user.mode === 'hosted' ? nextAt() : null,
      state: readState(paths.raw),
      ...stravaStatus(paths.secrets),
      ...connectStatus(paths.secrets, ctx.googleClientFile),
      stravaOrigin: preferredOrigin(),
    });
  };
}
