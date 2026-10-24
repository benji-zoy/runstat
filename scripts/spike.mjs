// Spike (phase 1 de la synchro automatique) : réponses brutes des deux sources sur 7 jours,
// pour concevoir le modèle de données. Lecture seule.
// Usage : npm run spike -- coros | google   → spike-output/<source>/
// Prérequis : npm run auth -- coros | google
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as coros from './sync/coros.mjs';
import * as google from './sync/google-health.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];

function dump(name, value) {
  const dir = join(root, 'spike-output', source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
  if (source === 'coros' && value?.result)
    writeFileSync(join(dir, `${name}.txt`), coros.toolText(value.result));
}

const day = (offset) => new Date(Date.now() - offset * 86_400_000);
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const iso = (d) => d.toISOString().slice(0, 10);

async function spikeCoros() {
  const init = await coros.initialize();
  dump('initialize', init);
  console.log(
    `Serveur : ${init.serverInfo?.name} ${init.serverInfo?.version} (protocole ${init.protocolVersion})`,
  );

  const tools = await coros.listTools();
  dump('tools-list', tools);
  const names = new Set(tools.map((t) => t.name));
  console.log(`${tools.length} outils : ${[...names].join(', ')}`);
  for (const t of coros.READ_TOOLS)
    if (!names.has(t)) console.warn(`Outil de la liste blanche absent du serveur : ${t}`);

  async function call(file, name, args) {
    if (!names.has(name)) return null;
    try {
      const result = await coros.callTool(name, args);
      dump(file, { tool: name, args, fetchedAt: new Date().toISOString(), result });
      const shape = result.structuredContent ? 'structuredContent + ' : '';
      console.log(
        `ok ${name} : ${shape}${coros.toolText(result).length} caractères${result.isError ? ' (isError)' : ''}`,
      );
      return result;
    } catch (e) {
      console.error(`ÉCHEC ${name} : ${e.message}`);
      return null;
    }
  }

  const records = await call('querySportRecords', 'querySportRecords', {
    startDate: ymd(day(7)),
    endDate: ymd(day(0)),
    sportTypeCodes: [100, 101, 102, 103],
    minDistanceKm: 0,
    maxDistanceKm: 1000,
    minDurationMinutes: 0,
    maxDurationMinutes: 10000,
    maxAveragePace: '',
    locationKeyword: '',
    limit: 50,
  });
  const text = coros.toolText(records);
  const labelId = text.match(/LabelId:\s*(\d+)/)?.[1];
  const sportType = Number(text.match(/SportType:\s*(\d+)/)?.[1]);
  if (labelId) {
    await call('getActivityDetail', 'getActivityDetail', { labelId, sportType });
    await call('queryActivityLapData', 'queryActivityLapData', { labelId, sportType });
    // Compte 1 fichier dans le quota FIT du jour (50) : uniquement labelId + sportType
    await call('queryActivityFitFileDownloadUrls', 'queryActivityFitFileDownloadUrls', {
      labelId,
      sportType,
    });
  }
  await call('querySleepOverview', 'querySleepOverview', { days: 7 });
  await call('querySleepHrv', 'querySleepHrv', {
    startDate: ymd(day(6)),
    endDate: ymd(day(0)),
    days: 7,
  });
  await call('queryRestingHeartRate', 'queryRestingHeartRate', { days: 7 });
  await call('queryDailyHealthData', 'queryDailyHealthData', { days: 7 });
  await call('queryRecoveryStatus', 'queryRecoveryStatus', {});
  await call('queryTrainingLoadAssessment', 'queryTrainingLoadAssessment', { days: 7 });
  await call('queryFitnessAssessmentOverview', 'queryFitnessAssessmentOverview', {});
}

async function spikeGoogle() {
  const identity = await google.get('users/me/identity');
  dump('identity', identity);
  console.log(`identity : HTTP ${identity.status}`);
  if (identity.status !== 200) {
    console.error('Compte non lié à Google Health ?', JSON.stringify(identity.body));
    return;
  }
  dump('pairedDevices', await google.get('users/me/pairedDevices'));

  const from = day(7);
  const to = day(-1);
  const daily = (f) => `${f}.date >= "${iso(from)}" AND ${f}.date < "${iso(to)}"`;
  const sample = (f, a = from) =>
    `${f}.sample_time.physical_time >= "${a.toISOString()}" AND ${f}.sample_time.physical_time < "${to.toISOString()}"`;
  const types = {
    'daily-resting-heart-rate': daily,
    'daily-heart-rate-variability': daily,
    'daily-oxygen-saturation': daily,
    'daily-respiratory-rate': daily,
    'daily-sleep-temperature-derivations': daily,
    'daily-vo2-max': daily,
    'heart-rate-variability': (f) => sample(f),
    'respiratory-rate-sleep-summary': (f) => sample(f),
    weight: (f) => `${f}.sample_time.physical_time >= "${day(90).toISOString()}"`,
    // FC intraday : une seule journée, le volume peut être important
    'heart-rate': (f) => sample(f, day(1)),
    steps: (f) =>
      `${f}.interval.start_time >= "${from.toISOString()}" AND ${f}.interval.start_time < "${to.toISOString()}"`,
    sleep: (f) => `${f}.interval.end_time >= "${from.toISOString()}"`,
  };
  for (const [type, filter] of Object.entries(types)) {
    try {
      const pages = await google.listDataPoints(type, filter(google.filterField(type)));
      dump(type, {
        type,
        filter: filter(google.filterField(type)),
        fetchedAt: new Date().toISOString(),
        pages,
      });
      const n = pages.reduce((s, p) => s + (p.body?.dataPoints?.length ?? 0), 0);
      const err = pages.find((p) => p.status !== 200);
      console.log(
        `${err ? 'ÉCHEC' : 'ok'} ${type} : ${n} points${err ? ` (HTTP ${err.status} ${err.body?.error?.message ?? ''})` : ''}`,
      );
    } catch (e) {
      console.error(`ÉCHEC ${type} : ${e.message}`);
    }
  }
}

if (source === 'coros') await spikeCoros();
else if (source === 'google') await spikeGoogle();
else {
  console.error('Usage : npm run spike -- coros | google');
  process.exit(1);
}
