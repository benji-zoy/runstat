// Service de synchro (conteneur runstat-sync) : lance run.mjs au démarrage puis toutes les SYNC_INTERVAL_MIN
// minutes, et expose /api/sync au site (proxy nginx, jamais publié hors du réseau Docker) :
//   GET  /api/sync  → { running, startedAt, nextAt, state (sync-state.json), log (fin du dernier run),
//                       stravaClient, stravaConnected, stravaAthlete (présence de l'appli et des jetons, jamais leur contenu),
//                       stravaOrigin (adresse du site pour la connexion Strava) }
//   POST /api/sync  → 202 lancée | 409 déjà en cours | 429 trop tôt après la précédente
//   POST /api/fit?id=<labelId | strava:id> → tracé d'une seule sortie (« Affiner avec le tracé ») : 202 | 400 | 409
//   GET|PUT /api/goals, GET|PUT /api/athlete, GET|PUT /api/sources, GET|PUT|DELETE /api/results/<id>[?replaces=date-….json]
//     → saisie depuis le site (scripts/sync/entries.mjs), puis reconstruction seule (run.mjs --rebuild) : 200 | 400 | 404
//   POST /api/strava/archive (corps application/zip, 2 Gio au plus) → import de l'archive Strava puis reconstruction :
//     202 | 400 | 409 | 413
//   PUT /api/strava/client, GET /api/strava/connect, GET /api/strava/callback → connexion Strava depuis Réglages
//     (scripts/sync/strava-connect.mjs : les deux GET sont des navigations, protégées par le state OAuth)
// Chaque run est un processus neuf : les scripts déployés sont pris en compte sans redémarrage.
// Usage : node scripts/sync/server.mjs [--no-schedule]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdirSync, createWriteStream, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_ID, InvalidEntry, deleteResult, readJsonFile, saveResult, validateAthlete, validateGoals, validateSources,
  writeJsonAtomic,
} from './entries.mjs';
import { fileKey, readSources } from './sources.mjs';
import { CALLBACK_PATH, preferredOrigin, stravaConnectRoutes, stravaStatus } from './strava-connect.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = join(root, 'data-raw');
const MAX_BODY = 64 * 1024;
const MAX_ARCHIVE = Number(process.env.SYNC_MAX_ARCHIVE_MB ?? 2048) * 1024 * 1024;
const PORT = Number(process.env.SYNC_PORT ?? 8787);
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MIN ?? 180) * 60_000;
const MIN_GAP_MS = 20_000; // anti-rebond des clics
const schedule = !process.argv.includes('--no-schedule');

let child = null;
let startedAt = null;
let finishedAt = 0;
let nextAt = null;
let timer = null;
let log = [];
/** Saisie pendant un run : une reconstruction est relancée à la fin */
let rebuildPending = false;

function run(trigger, args = []) {
  if (child) return false;
  // Un tracé seul (--fit) ne décale pas la prochaine synchro planifiée
  const full = !args.length;
  if (full) clearTimeout(timer);
  startedAt = new Date().toISOString();
  log = [];
  console.log(`--- synchro (${trigger})`);
  child = spawn(process.execPath, [join(root, 'scripts/sync/run.mjs'), ...args], { cwd: root });
  const keep = (chunk, out) => {
    out.write(chunk);
    log.push(...chunk.toString().split('\n').filter(Boolean));
    log = log.slice(-80);
  };
  child.stdout.on('data', (c) => keep(c, process.stdout));
  child.stderr.on('data', (c) => keep(c, process.stderr));
  child.on('close', (code) => {
    if (code) log.push(`run.mjs terminé avec le code ${code}`);
    child = null;
    finishedAt = Date.now();
    if (full) plan();
    if (rebuildPending) {
      rebuildPending = false;
      run('saisie', ['--rebuild']);
    }
  });
  return true;
}

function plan(delay = INTERVAL_MS) {
  if (!schedule) return;
  nextAt = new Date(Date.now() + delay).toISOString();
  // Tracé seul en cours à l'heure prévue : on réessaie une minute plus tard
  timer = setTimeout(() => run('planifiée') || plan(60_000), delay);
}

function state() {
  const file = join(raw, 'sync-state.json');
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {}; // fichier en cours d'écriture
  }
}

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

/** Saisie : lecture, ou écriture validée suivie d'une reconstruction des données du site */
async function entries(req, res, path, url) {
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
  const replaces = url.searchParams.get('replaces');
  let saved;
  try {
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
  if (!run('saisie', ['--rebuild'])) rebuildPending = true;
  send(res, 200, { saved: saved ?? null, running: Boolean(child), startedAt });
}

const ENTRY = /^\/api\/(goals|athlete|sources|results\/[^/]+)$/;

/** Connexion Strava : synchro lancée aussitôt si Strava est la source d'activités */
const strava = stravaConnectRoutes({
  raw,
  onConnected: () => readSources(raw).activities === 'strava' && run('Strava connecté'),
});
const STRAVA_NAV = ['/api/strava/connect', CALLBACK_PATH];

/**
 * Archive Strava : corps écrit en flux dans data-raw/import/ (jamais en mémoire), signature zip vérifiée,
 * puis run.mjs --import-strava (le fichier est supprimé après l'import).
 */
async function stravaArchive(req, res) {
  if (child) return send(res, 409, { error: 'synchro en cours, réessaie dans quelques minutes', startedAt });
  if (!/^application\/(zip|x-zip-compressed|octet-stream)$/.test(req.headers['content-type'] ?? ''))
    return send(res, 400, { error: 'archive zip attendue' });
  const length = Number(req.headers['content-length'] ?? NaN);
  if (length > MAX_ARCHIVE) return send(res, 413, { error: 'archive trop volumineuse' });
  const dir = join(raw, 'import');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `strava-${Date.now()}.zip`);
  const ok = await new Promise((resolve) => {
    let size = 0;
    const out = createWriteStream(file);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_ARCHIVE) (req.unpipe(out), out.destroy(), req.destroy(), resolve(413));
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
  // Une synchro a pu démarrer pendant l'envoi : l'import attendra la suivante
  if (!run('archive Strava', ['--import-strava', file])) {
    rmSync(file, { force: true });
    return send(res, 409, { error: 'synchro en cours, réessaie dans quelques minutes', startedAt });
  }
  send(res, 202, { running: true, startedAt });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://runstat');
  const path = url.pathname;
  const entry = ENTRY.test(path);
  const upload = path === '/api/strava/archive';
  // Navigations du navigateur (redirections OAuth) : sans en-tête X-RunStat, protégées par le state
  if (STRAVA_NAV.includes(path)) {
    if (req.method !== 'GET') return send(res, 405, { error: 'méthode non autorisée' });
    try {
      return path === CALLBACK_PATH ? await strava.callback(req, res, url) : strava.connect(req, res);
    } catch (e) {
      console.error('Connexion Strava :', e.message);
      return send(res, 500, { error: 'connexion Strava impossible' });
    }
  }
  const stravaClient = path === '/api/strava/client';
  if (path !== '/api/sync' && path !== '/api/fit' && !entry && !upload && !stravaClient)
    return send(res, 404, { error: 'introuvable' });
  if (req.method !== 'GET') {
    // En-tête propre au site : une page d'un autre domaine ne peut pas l'envoyer sans pré-vérification CORS (refusée)
    if (req.headers['x-runstat'] !== 'sync')
      return send(res, 403, { error: 'en-tête X-RunStat manquant' });
  }
  if (stravaClient) {
    if (req.method !== 'PUT') return send(res, 405, { error: 'méthode non autorisée' });
    try {
      return send(res, 200, strava.saveClient(await readBody(req)));
    } catch (e) {
      if (e instanceof InvalidEntry) return send(res, 400, { error: e.message, errors: e.errors });
      console.error('Appli Strava :', e.message);
      return send(res, 500, { error: 'écriture impossible' });
    }
  }
  if (upload) {
    if (req.method !== 'POST') return send(res, 405, { error: 'méthode non autorisée' });
    try {
      return await stravaArchive(req, res);
    } catch (e) {
      console.error('Archive Strava :', e);
      return send(res, 500, { error: 'envoi impossible' });
    }
  }
  if (entry) {
    try {
      return await entries(req, res, path, url);
    } catch (e) {
      console.error('Saisie :', e);
      return send(res, 500, { error: 'écriture impossible' });
    }
  }
  if (req.method === 'POST') {
    if (child) return send(res, 409, { error: 'synchro déjà en cours', startedAt });
    if (path === '/api/fit') {
      const id = url.searchParams.get('id') ?? '';
      if (!ACTIVITY_ID.test(id)) return send(res, 400, { error: 'identifiant de sortie invalide' });
      run(`tracé ${id}`, ['--fit', id]);
      return send(res, 202, { running: true, startedAt });
    }
    const wait = finishedAt + MIN_GAP_MS - Date.now();
    if (wait > 0)
      return send(res, 429, { error: 'synchro toute récente', retryInSec: Math.ceil(wait / 1000) });
    run('manuelle');
    return send(res, 202, { running: true, startedAt });
  }
  if (req.method !== 'GET' || path !== '/api/sync') return send(res, 405, { error: 'méthode non autorisée' });
  send(res, 200, { running: Boolean(child), startedAt, nextAt, state: state(), log, ...stravaStatus(), stravaOrigin: preferredOrigin() });
}).listen(PORT, () => console.log(`Service de synchro sur le port ${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    child?.kill('SIGTERM');
    process.exit(0);
  });
}

// Conteneur neuf : un verrou restant vient d'un run interrompu par l'arrêt précédent
rmSync(join(root, 'data-raw/.sync.lock'), { force: true });
if (schedule) run('démarrage');
