// Une synchronisation des sources choisies (data-raw/sources.json), par le moteur (src/engine/sync/run-sources.ts, le même
// que dans l'appli publique) :
//   activités : COROS (activités, détails, forme, charge, FIT), Strava (API REST : activités, streams) ou Garmin
//   (Personal API : activités, FIT) ;
//   santé : Google Health, COROS (sommeil, VFC, FC de repos), Garmin (sommeil, VFC, FC de repos, poids) ou aucune ;
// puis reconstruction des données du site (build-fit, build-data, file FIT, météo).
// Lancé par le conteneur runstat-sync (server.mjs, un compte à la fois), ou à la main :
//   node scripts/sync/run.mjs [--only coros|strava|garmin|google|corosHealth|garminHealth] [--no-build]
//   node scripts/sync/run.mjs --fit <id>        (tracé d'une seule sortie, bouton « Affiner avec le tracé », puis build-fit + build-data)
//   node scripts/sync/run.mjs --refit [jours]   (retélécharge les FIT / tracés des 14 derniers jours, écrase les anciens, puis build-fit + build-data)
//   node scripts/sync/run.mjs --rebuild         (sans les sources : reconstruction après une saisie depuis le site)
//   node scripts/sync/run.mjs --import-strava <zip>  (archive Strava envoyée depuis le site, supprimée après import)
//   node scripts/sync/run.mjs --coros-plan <goalId>  (envoi du plan importé dans le calendrier COROS, puis build-data)
// Réponses brutes : data-raw/raw/<source>/<type>/… ; état : data-raw/sync-state.json.
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceSync } from '#engine/sync/run-sources.ts';
import { corosAt } from './coros.mjs';
import { googleAt } from './google-health.mjs';
import { stravaAt } from './strava.mjs';
import { garminAt } from './garmin.mjs';
import { nodeTokens, secretsDir } from './secrets.mjs';
import { rawDir } from '../paths.mjs';
import { NodeStore } from '../node-storage.mjs';
import { importStravaArchive } from './strava-archive.mjs';
import { ACTIVITY_ID, readSources } from './sources.mjs';
import { GOAL_ID, validatePlan, writeJsonAtomic } from './entries.mjs';
import { pushPlanToCoros } from '#engine/plan/coros-plan.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Données de l'utilisateur du run (RUNSTAT_RAW posé par server.mjs, sinon data-raw/ du dépôt)
const raw = rawDir();
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const fitOnly = args.includes('--fit') ? args[args.indexOf('--fit') + 1] : null;
const refit = args.includes('--refit');
const refitDays = refit && /^\d+$/.test(args[args.indexOf('--refit') + 1] ?? '') ? Math.min(Number(args[args.indexOf('--refit') + 1]), 60) : 14;
const rebuildOnly = args.includes('--rebuild');
const archive = args.includes('--import-strava') ? args[args.indexOf('--import-strava') + 1] : null;
const corosPlan = args.includes('--coros-plan') ? args[args.indexOf('--coros-plan') + 1] : null;
if (corosPlan !== null && !GOAL_ID.test(corosPlan ?? '')) {
  console.error('Usage : --coros-plan <identifiant d’objectif>');
  process.exit(1);
}
if (fitOnly !== null && !ACTIVITY_ID.test(fitOnly ?? '')) {
  console.error('Usage : --fit <labelId COROS | strava:<id> | garmin:<id>>');
  process.exit(1);
}
const sources = readSources(raw);

const log = (...m) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...m);
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

const secrets = secretsDir();
// Clients du compte (rien n'est lu avant le premier appel : Google n'exige son client OAuth qu'au renouvellement du jeton)
const clients = { tokens: nodeTokens(secrets), coros: corosAt(secrets), strava: stravaAt(secrets), google: googleAt(secrets), garmin: garminAt(secrets) };
const sync = sourceSync(new NodeStore(raw), clients, {
  only,
  overlapDays: Number(process.env.SYNC_OVERLAP_DAYS ?? 3),
  fitPerRun: Number(process.env.SYNC_FIT_PER_RUN ?? 50),
  streamsPerRun: Number(process.env.SYNC_STREAMS_PER_RUN ?? 40),
  log,
});
const state = await sync.loadState();

/** Un seul run à la fois (boucle du conteneur + lancement manuel) */
const lockFile = join(raw, '.sync.lock');
if (existsSync(lockFile) && Date.now() - statSync(lockFile).mtimeMs < 3_600_000) {
  log('Synchro déjà en cours (data-raw/.sync.lock), abandon.');
  process.exit(0);
}
writeFileSync(lockFile, String(process.pid));

function step(script, ...flags) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', script), ...flags], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${script} a échoué (code ${res.status})`);
}

try {
  if (fitOnly) {
    log(`Tracé de la sortie ${fitOnly}…`);
    await sync.syncOne(fitOnly);
  } else if (refit) {
    log(`Retéléchargement des FIT des ${refitDays} derniers jours…`);
    await sync.refetchRecent(refitDays);
    await sync.saveState();
  } else if (archive) {
    log('Import de l’archive Strava…');
    try {
      const r = await importStravaArchive(archive, raw);
      state.stravaArchive = { importedAt: new Date().toISOString(), ...r };
      delete state.lastImportError;
      log(`Archive Strava : ${r.runs} sorties de course à pied (${r.added} nouvelles), ${r.files} tracés`);
    } catch (e) {
      state.lastImportError = e.message;
      log(`Archive Strava : ÉCHEC — ${e.message}`);
    } finally {
      rmSync(archive, { force: true });
    }
    await sync.saveState();
  } else if (corosPlan) {
    // Seule écriture vers COROS, à la demande : réussite ou erreur gardées dans le plan (affichées sur la fiche de l'objectif)
    const file = join(raw, 'plans', `${corosPlan}.json`);
    const plan = readJson(file, null);
    // Objectif ou cycle d'entraînement sans course : seul le nom sert (plan COROS « RunStat · <nom> »)
    const goal = [...readJson(join(raw, 'goals.json'), []), ...readJson(join(raw, 'cycles.json'), [])].find((g) => g.id === corosPlan);
    if (plan && goal) {
      log(`Envoi du plan « ${goal.name} » dans COROS…`);
      try {
        const coros = await pushPlanToCoros(clients.coros, plan, goal.name, new Date().toLocaleDateString('sv-SE'));
        plan.coros = coros;
        log(`Plan COROS : ${coros.sessions} séances sur ${coros.weeks} semaines`);
      } catch (e) {
        plan.coros = { ...(plan.coros ?? {}), error: e.message.slice(0, 500), errorAt: new Date().toISOString() };
        log(`Plan COROS : ÉCHEC — ${e.message}`);
      }
      writeJsonAtomic(file, validatePlan(corosPlan, plan));
    }
    step('build-data.mjs');
  } else if (rebuildOnly) {
    log('Reconstruction après une saisie…');
  } else {
    await sync.syncAll();
  }
  if (corosPlan) {
    // déjà reconstruit
  } else if ((fitOnly || refit) && !state.lastFitError) {
    try {
      step('build-fit.mjs');
      step('build-data.mjs');
    } catch (e) {
      state.lastBuildError = e.message;
      log(`Reconstruction : ÉCHEC — ${e.message}`);
    }
    await sync.saveState();
  } else if (!fitOnly && !refit && !args.includes('--no-build')) {
    try {
      // Réglages de l'athlète utilisés par build-fit modifiés (site ou npm run nas -- push athlete.json) : FC max/repos,
      // seuils → tout recalculer ; poids, taille ou poids des courses ne touchent pas aux FIT
      const athlete = join(raw, 'athlete.json');
      const a = readJson(athlete, {});
      const fitKey = JSON.stringify([a.hrMax, a.hrRest, a.lt1Hr ?? null, a.lt2Hr ?? null]);
      const changed =
        state.athleteFit !== undefined
          ? state.athleteFit !== fitKey
          : state.lastBuild && existsSync(athlete) && statSync(athlete).mtimeMs > Date.parse(state.lastBuild);
      step('build-fit.mjs', ...(changed ? ['--force'] : []));
      step('build-data.mjs');
      if (sources.activities === 'coros') step('fit-queue.mjs');
      step('fetch-weather.mjs');
      step('build-data.mjs');
      state.lastBuild = new Date().toISOString();
      state.athleteFit = fitKey;
      delete state.lastBuildError;
    } catch (e) {
      state.lastBuildError = e.message;
      log(`Reconstruction : ÉCHEC — ${e.message}`);
    }
    await sync.saveState();
  }
  log('Terminé.');
} finally {
  unlinkSync(lockFile);
}
