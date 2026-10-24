// Service de synchro (conteneur runstat-sync) : lance run.mjs pour chaque compte hébergé au démarrage puis toutes les
// SYNC_INTERVAL_MIN minutes (un run à la fois, queue.mjs), et sert l'API du site (routes : app.mjs), jamais publiée hors
// du réseau Docker. Un port par zone de confiance, chacun relayé par un seul bloc server de nginx (deploy/nginx/) :
//   SYNC_PORT     (8787) zone lan     : réseau local → compte du propriétaire
//   SYNC_PORT + 1 (8788) zone tailnet : Tailscale Serve → compte du login Tailscale-User-Login
//   SYNC_PORT + 2 (8789) zone public  : Tailscale Funnel (HTTPS 8443) → /auth, /backup, /relay seulement (public-api.mjs),
//                                       pour les proches local-first ; jeton de session, CORS limité à RUNSTAT_APP_ORIGINS
// Comptes : RUNSTAT_USERS/users.json (accounts.mjs) ; sans ce fichier, instance mono-utilisateur historique
// (data-raw/, public/data/ et secrets/ du dépôt ou de l'ancien conteneur).
// Chaque run est un processus neuf, avec l'environnement de son compte (liste blanche, pas de copie de process.env) :
// les scripts déployés sont pris en compte sans redémarrage.
// Usage : node scripts/sync/server.mjs [--no-schedule]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, usersDir } from '../paths.mjs';
import { accountsLoader, runEnv, userPaths } from './accounts.mjs';
import { createApp, ensureUserDirs } from './app.mjs';
import { RunQueue, jobs } from './queue.mjs';
import { stravaConnectRoutes } from './strava-connect.mjs';
import { oauthConnectRoutes } from './oauth-connect.mjs';
import { createPublicApi, parseOrigins } from './public-api.mjs';
import { gcAllBackups } from './backup-store.mjs';

const PORT = Number(process.env.SYNC_PORT ?? 8787);
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MIN ?? 180) * 60_000;
const QUOTA_BYTES = Number(process.env.RUNSTAT_USER_QUOTA_MB ?? 2048) * 2 ** 20;
const MAX_ARCHIVE = Number(process.env.SYNC_MAX_ARCHIVE_MB ?? 2048) * 2 ** 20;
const schedule = !process.argv.includes('--no-schedule');
// Accès public (Funnel) : adresse de l'appli publique (liens d'invitation), adresse publique du NAS, origines de l'appli
const APP_URL = process.env.RUNSTAT_APP_URL || null;
const PUBLIC_URL = process.env.RUNSTAT_PUBLIC_URL || null;
const APP_ORIGINS = parseOrigins(process.env.RUNSTAT_APP_ORIGINS ?? (APP_URL ? new URL(APP_URL).origin : ''));
const BACKUP_QUOTA = Number(process.env.RUNSTAT_BACKUP_QUOTA_MB ?? 1024) * 2 ** 20;
/** Adresses de retour Google acceptées par le relais (page de connexion de l'appli publique) */
const GOOGLE_REDIRECTS = (process.env.RUNSTAT_GOOGLE_REDIRECTS ?? (APP_URL ? `${APP_URL}connexion/google` : '')).split(',').map((s) => s.trim()).filter(Boolean);

const dir = usersDir();
// Nouveau YAML monté avant la migration : un dossier des comptes vide, sans users.json, ferait synchroniser dans un
// data-raw neuf. Refus franc (scripts/migrate-users.sh d'abord).
if (existsSync(dir) && !existsSync(join(dir, 'users.json'))) {
  console.error(`${dir} existe sans users.json : lance d'abord scripts/migrate-users.sh (voir CLAUDE.md, Comptes et migration).`);
  process.exit(1);
}
const accounts = accountsLoader(dir, {
  raw: join(root, 'data-raw'),
  snapshot: join(root, 'public', 'data'),
  // Ancien conteneur : volume /secrets
  secrets: process.env.RUNSTAT_SECRETS ?? join(root, 'secrets'),
});

const children = new Set();
let timer = null;
let nextAt = null;

function startRun(userId, job, onLine) {
  const acc = accounts();
  const user = acc.users.find((u) => u.id === userId);
  if (!user) throw new Error(`compte ${userId} supprimé`);
  const paths = userPaths(acc, user);
  ensureUserDirs(paths);
  const owner = acc.users.find((u) => u.role === 'owner');
  // Client Google du propriétaire, pour les proches qui n'ont pas le leur (google-health.mjs)
  const env = { ...runEnv(paths, dir), RUNSTAT_GOOGLE_CLIENT: join(userPaths(acc, owner).secrets, 'google-client.json') };
  console.log(`--- ${userId} : ${job.trigger}`);
  const child = spawn(process.execPath, [join(root, 'scripts/sync/run.mjs'), ...job.args], { cwd: root, env });
  children.add(child);
  const keep = (chunk, out) => {
    out.write(chunk);
    for (const line of chunk.toString().split('\n').filter(Boolean)) onLine(line);
  };
  child.stdout.on('data', (c) => keep(c, process.stdout));
  child.stderr.on('data', (c) => keep(c, process.stderr));
  return new Promise((resolve) => {
    child.on('error', (e) => (onLine(`lancement impossible : ${e.message}`), resolve(1)));
    child.on('close', (code) => (children.delete(child), resolve(code)));
  });
}

/** Synchro complète de tous les comptes hébergés, l'un après l'autre (file), puis la suivante planifiée */
function syncAll(trigger) {
  for (const u of accounts().users) if (u.mode === 'hosted') queue.enqueue(u.id, jobs.full(trigger));
  plan();
}

function plan() {
  if (!schedule) return;
  clearTimeout(timer);
  nextAt = new Date(Date.now() + INTERVAL_MS).toISOString();
  timer = setTimeout(() => syncAll('planifiée'), INTERVAL_MS);
}

const queue = new RunQueue({ start: startRun });
const strava = stravaConnectRoutes();
const oauth = oauthConnectRoutes();
const common = { accounts, queue, strava, oauth, appUrl: APP_URL, publicUrl: PUBLIC_URL, nextAt: () => nextAt, quotaBytes: QUOTA_BYTES, maxArchive: MAX_ARCHIVE };

const listen = (zone, port) =>
  createServer(createApp({ zone, ...common })).listen(port, () => console.log(`API (${zone}) sur le port ${port}`));
listen('lan', PORT);
listen('tailnet', PORT + 1);
createServer(createPublicApi({ accounts, usersDir: dir, appOrigins: APP_ORIGINS, googleRedirects: GOOGLE_REDIRECTS, quotaBytes: BACKUP_QUOTA }))
  .listen(PORT + 2, () => console.log(`API (public) sur le port ${PORT + 2}${APP_ORIGINS.length ? ` pour ${APP_ORIGINS.join(', ')}` : ', aucune origine autorisée'}`));

// Ménage des sauvegardes local-first (manifestes de plus de 30 jours, objets orphelins, suppressions anciennes) et de celles des
// comptes retirés (backup-store.mjs, gcAllBackups), toutes les 6 h
const backupGc = () => {
  try {
    gcAllBackups(dir, accounts().users);
  } catch (e) {
    console.error(`Sauvegardes : ménage impossible (${e.message})`);
  }
};
if (schedule) setInterval(backupGc, 6 * 3_600_000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const c of children) c.kill('SIGTERM');
    process.exit(0);
  });
}

// Conteneur neuf : un verrou restant vient d'un run interrompu par l'arrêt précédent
for (const u of accounts().users) rmSync(join(userPaths(accounts(), u).raw, '.sync.lock'), { force: true });
if (schedule) syncAll('démarrage');
