// Tests des sources Strava et santé COROS (npm run test:sync). Données fictives dans scripts/sync/fixtures/ :
//   strava/export/       contenu d'une archive Strava (activities.csv + tracés), zippé dans strava/export.zip
//                        (cd strava/export && zip -X -r ../export.zip activities.csv activities), plus une entrée evil.gpx
//   strava/activities-fr.csv  export d'un compte en français
//   coros-health/        réponses des outils santé du MCP COROS, au format réel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { openZip } from './zip.mjs';
import {
  activityFromApi, mergeStravaActivities, parseActivitiesCsv, parseArchiveDate, parseCsv, runSportType,
} from '#engine/parsers/strava.ts';
import { importStravaArchive, stravaFile } from './strava-archive.mjs';
import { parseGpx, parseStreams, parseTcx } from '#engine/fit/track.ts';
import { analyse } from '#engine/fit/analyse.ts';
import { get, nearLimit } from './strava.mjs';
import { healthFromCoros, minutes, parseDailyHealth, parseRestingHr, parseSleepHrv } from '#engine/parsers/coros-health.ts';
import { ACTIVITY_ID, fileKey, idFromFileKey, readSources } from './sources.mjs';
import { validateAthlete, validateResult, validateSources } from './entries.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (...p) => readFileSync(join(fixtures, ...p), 'utf8');
const athlete = { hrMax: 190, hrRest: 50, sex: 'M' };

// ---------- archive Strava ----------

test('CSV : guillemets, virgules et sauts de ligne dans un champ', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""","1\n2"\n'), [['a', 'b'], ['x, "y"', '1\n2']]);
});

test('dates de l’archive : anglais, français, ISO (UTC)', () => {
  assert.equal(parseArchiveDate('Jan 5, 2026, 7:30:12 AM'), Date.UTC(2026, 0, 5, 7, 30, 12));
  assert.equal(parseArchiveDate('Jan 5, 2026, 12:10:00 AM'), Date.UTC(2026, 0, 5, 0, 10, 0));
  assert.equal(parseArchiveDate('Jan 7, 2026, 11:15:00 PM'), Date.UTC(2026, 0, 7, 23, 15, 0));
  assert.equal(parseArchiveDate('5 janv. 2026, 07:30:12'), Date.UTC(2026, 0, 5, 7, 30, 12));
  assert.equal(parseArchiveDate('14 févr. 2026, 18:05:00'), Date.UTC(2026, 1, 14, 18, 5, 0));
  assert.equal(parseArchiveDate('1 août 2026, 06:00:00'), Date.UTC(2026, 7, 1, 6, 0, 0));
  assert.equal(parseArchiveDate('2026-03-01 10:00:00'), Date.UTC(2026, 2, 1, 10, 0, 0));
  assert.equal(parseArchiveDate('n’importe quoi'), null);
});

test('types Strava : course à pied seulement, code de sport COROS', () => {
  assert.equal(runSportType('Run'), 100);
  assert.equal(runSportType('Course à pied'), 100);
  assert.equal(runSportType('Trail Run'), 102);
  assert.equal(runSportType('TrailRun'), 102);
  assert.equal(runSportType('VirtualRun'), 101);
  assert.equal(runSportType('Run', { trainer: true }), 101);
  for (const t of ['Ride', 'VirtualRide', 'Walk', 'Randonnée', 'Vélo', '']) assert.equal(runSportType(t), null, t);
});

test('activities.csv anglais : colonnes en double, autres sports ignorés, date locale', () => {
  const runs = parseActivitiesCsv(read('strava', 'export', 'activities.csv'));
  assert.deepEqual(runs.map((r) => r.id), ['strava:1001', 'strava:1003', 'strava:1004', 'strava:1005', 'strava:1006']);
  const [footing, trail, tapis] = runs;
  assert.deepEqual(
    { ...footing },
    {
      id: 'strava:1001', sportType: 100, name: 'Footing du dimanche', date: '2026-01-05', start: Date.UTC(2026, 0, 5, 7, 30, 12) / 1000,
      durationSec: 600, elapsedSec: 630, distanceKm: 1.797, avgHr: 145, maxHr: 160, calories: 150, elevGain: 12, elevLoss: 11,
      cadence: 170, power: null, lat: null, lon: null, filename: 'activities/5551.gpx.gz',
    },
  );
  // 23 h 15 UTC le 7 = 0 h 15 le 8 à Paris
  assert.equal(trail.date, '2026-01-08');
  assert.equal(trail.sportType, 102);
  assert.equal(tapis.sportType, 101);
  assert.equal(tapis.filename, null);
});

test('activities.csv français : décimales à virgule, en-têtes accentués', () => {
  const runs = parseActivitiesCsv(read('strava', 'activities-fr.csv'));
  assert.deepEqual(runs.map((r) => [r.id, r.sportType, r.date, r.distanceKm, r.durationSec]), [
    ['strava:2001', 100, '2026-01-05', 6.211, 2300],
    ['strava:2003', 102, '2026-08-01', 20, 7000],
  ]);
  assert.equal(runs[0].elevGain, 45);
  assert.equal(runs[0].cadence, 172);
});

test('zip : entrées listées et lues (deflate, stocké)', () => {
  const zip = openZip(join(fixtures, 'strava', 'export.zip'));
  try {
    const names = zip.entries.map((e) => e.name).sort();
    assert.deepEqual(names, [
      'activities.csv', 'activities/5551.gpx.gz', 'activities/5552.fit.gz', 'activities/5553.tcx', 'activities/5556.fit.gz', 'evil.gpx',
    ]);
    const csv = zip.read(zip.entries.find((e) => e.name === 'activities.csv')).toString('utf8');
    assert.equal(csv, read('strava', 'export', 'activities.csv'));
  } finally {
    zip.close();
  }
  assert.throws(() => openZip(join(fixtures, 'strava', 'activities-fr.csv')), /pas une archive zip/);
});

test('import de l’archive : sorties, tracés, entrée piégée ignorée, idempotent', () => {
  const raw = mkdtempSync(join(tmpdir(), 'runstat-'));
  try {
    const r = importStravaArchive(join(fixtures, 'strava', 'export.zip'), raw);
    assert.deepEqual(r, { runs: 5, added: 5, files: 3, skipped: 1 });
    const list = JSON.parse(readFileSync(stravaFile(raw), 'utf8'));
    assert.deepEqual(list.map((a) => [a.id, a.file ?? null]), [
      ['strava:1001', 'gpx'], ['strava:1003', 'tcx'], ['strava:1004', null], ['strava:1005', null], ['strava:1006', 'fit'],
    ]);
    assert.ok(list.every((a) => !('filename' in a)));
    // Fichiers nommés d'après l'identifiant de l'activité, pas d'après le numéro du fichier de l'archive
    assert.deepEqual(readdirSync(join(raw, 'fit')), ['strava-1006.fit']);
    assert.deepEqual(readdirSync(join(raw, 'tracks')).sort(), ['strava-1001.gpx.gz', 'strava-1003.tcx.gz']);
    assert.equal(
      gunzipSync(readFileSync(join(raw, 'tracks', 'strava-1003.tcx.gz'))).toString('utf8'),
      read('strava', 'export', 'activities', '5553.tcx'),
    );
    assert.ok(!existsSync(join(raw, 'evil.gpx')) && !existsSync(join(raw, '..', 'evil.gpx')));

    const again = importStravaArchive(join(fixtures, 'strava', 'export.zip'), raw);
    assert.equal(again.added, 0);
    assert.deepEqual(JSON.parse(readFileSync(stravaFile(raw), 'utf8')), list);
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
});

test('l’archive complète l’API sans l’écraser ; l’API l’emporte et retire les sorties disparues', () => {
  const api = { id: 'strava:1', date: '2026-01-05', start: 10, name: 'API', lat: 45.7, lon: 4.8, race: true };
  const archive = { id: 'strava:1', date: '2026-01-05', start: 10, name: 'Archive', lat: null, elevLoss: 30 };
  const a = mergeStravaActivities([api], [archive], { prefer: 'existing' });
  assert.deepEqual(a.list, [{ id: 'strava:1', date: '2026-01-05', start: 10, name: 'API', lat: 45.7, lon: 4.8, elevLoss: 30, race: true }]);
  const old = { id: 'strava:2', date: '2026-01-06', start: 20 };
  const b = mergeStravaActivities([...a.list, old], [{ ...api, name: 'Renommée' }], { window: { from: '2026-01-04', to: '2026-01-10' } });
  assert.deepEqual(b.removed, ['strava:2']);
  assert.equal(b.list[0].name, 'Renommée');
  assert.equal(b.list[0].elevLoss, 30);
  assert.deepEqual(mergeStravaActivities(b.list, [{ ...api, name: 'Renommée' }], { window: { from: '2026-01-04', to: '2026-01-10' } }).list, b.list);
});

test('activité de l’API : cadence par jambe × 2, course marquée, autres sports ignorés', () => {
  const a = activityFromApi({
    id: 42, name: 'Semi de Lyon', sport_type: 'Run', start_date: '2026-10-04T06:30:00Z', start_date_local: '2026-10-04T08:30:00Z',
    moving_time: 5400, elapsed_time: 5460, distance: 21100, total_elevation_gain: 80, average_heartrate: 171.4, max_heartrate: 186,
    average_cadence: 88.5, average_watts: 260, start_latlng: [45.76, 4.83], workout_type: 1, calories: 1400,
  });
  assert.deepEqual(a, {
    id: 'strava:42', sportType: 100, name: 'Semi de Lyon', date: '2026-10-04', start: Date.UTC(2026, 9, 4, 6, 30) / 1000,
    durationSec: 5400, elapsedSec: 5460, distanceKm: 21.1, avgHr: 171, maxHr: 186, calories: 1400, elevGain: 80, elevLoss: null,
    cadence: 177, power: 260, lat: 45.76, lon: 4.83, race: true,
  });
  assert.equal(activityFromApi({ id: 1, sport_type: 'Ride', distance: 1000, moving_time: 100, start_date: '2026-01-01T00:00:00Z' }), null);
  assert.equal(activityFromApi({ id: 2, sport_type: 'TrailRun', distance: 1000, moving_time: 100, start_date: '2026-01-01T00:00:00Z', trainer: false }).sportType, 102);
});

// ---------- tracés ----------

test('GPX : distance haversine, pause retirée du chronomètre, analyse complète', () => {
  const data = parseGpx(gunzipSync(readFileSync(join(fixtures, 'strava', 'export', 'activities', '5551.gpx.gz'))).toString('utf8'));
  const last = data.records.at(-1);
  assert.equal(data.records.length, 600);
  assert.ok(Math.abs(last.distance - 1797) < 15, `distance ${last.distance}`);
  // 600 points à 1 s, dont un écart de 31 s (pause) hors chronomètre : 598 s
  assert.equal(last.timer_time, 598);
  assert.equal(data.records[10].heart_rate, 141);
  assert.equal(data.records[10].cadence, 85);
  const fit = analyse(data, athlete);
  assert.equal(fit.duration, 598);
  assert.ok(Math.abs(fit.distance - 1797) < 15);
  assert.ok(fit.trimp > 0 && fit.zones5.reduce((a, b) => a + b, 0) > 500);
  assert.ok(fit.route);
  assert.equal(fit.km.length, 2);
  assert.equal(fit.km[0][7], 170); // cadence en pas par minute, comme un FIT
});

test('TCX : distance du fichier, tours, analyse complète', () => {
  const data = parseTcx(read('strava', 'export', 'activities', '5553.tcx'));
  assert.equal(data.records.length, 400);
  assert.equal(data.records.at(-1).distance, 997.5);
  assert.equal(data.records.at(-1).timer_time, 399);
  assert.deepEqual(data.laps.map((l) => l.total_timer_time), [200, 200]);
  assert.equal(data.records[0].cadence, 85);
  const fit = analyse(data, athlete);
  assert.equal(fit.distance, 998);
  assert.ok(fit.efforts['400'] > 0);
});

test('streams Strava : départ, immobilité, même structure', () => {
  const n = 120;
  const streams = {
    start: 1_700_000_000,
    time: { data: Array.from({ length: n }, (_, k) => (k < 60 ? k : k + 40)) },
    distance: { data: Array.from({ length: n }, (_, k) => k * 3) },
    heartrate: { data: Array(n).fill(150) },
    altitude: { data: Array(n).fill(200) },
    moving: { data: Array.from({ length: n }, (_, k) => k !== 60) },
  };
  const data = parseStreams(streams);
  assert.equal(data.records.length, n);
  // Écart de 41 s marqué immobile : hors chronomètre
  assert.equal(data.records.at(-1).timer_time, n - 2);
  assert.equal(data.records.at(-1).distance, (n - 1) * 3);
});

// ---------- client REST : lecture seule ----------

test('client Strava : chemins hors liste blanche refusés avant tout appel réseau', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('aucune requête ne doit partir');
  try {
    for (const path of ['/uploads', '/activities', '/activities/1/kudos', '/athlete', '/segments/1/starred', '/activities/1/../../uploads']) {
      await assert.rejects(get(path), /non autorisé/, path);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('limites de débit Strava : arrêt à 90 % du quota', () => {
  const h = (o) => new Headers(o);
  assert.equal(nearLimit(h({ 'x-ratelimit-limit': '100,1000', 'x-ratelimit-usage': '50,200' })), false);
  assert.equal(nearLimit(h({ 'x-ratelimit-limit': '100,1000', 'x-ratelimit-usage': '90,200' })), true);
  assert.equal(nearLimit(h({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '10,950' })), true);
  assert.equal(nearLimit(h({})), false);
});

// ---------- santé COROS ----------

test('santé COROS : durées « 6h 44min »', () => {
  assert.equal(minutes('6h 44min'), 404);
  assert.equal(minutes('1h 0min'), 60);
  assert.equal(minutes('38 min'), 38);
  assert.equal(minutes('2h'), 120);
  assert.equal(minutes(''), null);
});

test('santé COROS : sommeil (deux mises en page), VFC, FC de repos', () => {
  const daily = read('coros-health', 'daily.txt');
  assert.deepEqual(parseDailyHealth(daily), {
    '2026-01-01': { sleepMin: 450, sleepMain: 450, sleepScore: 88, awakeMin: 20, deepMin: 75, remPct: 23.3 },
    // Sans score : sieste ou bout de nuit, pas une nuit principale
    '2026-01-02': { sleepMin: 40, awakeMin: 5, deepMin: 0, remPct: 0 },
    '2026-01-04': { sleepMin: 360, sleepMain: 360, sleepScore: 70, awakeMin: 62, deepMin: 48, remPct: 25.6 },
  });
  // Évaluation officielle seulement : les points de la série brute (99, 12 ms) sont ignorés
  assert.deepEqual(parseSleepHrv(read('coros-health', 'hrv.txt')), { '2026-01-04': 58, '2026-01-01': 72 });
  assert.deepEqual(parseRestingHr(read('coros-health', 'rhr.txt')), { '2026-01-04': 51, '2026-01-02': 49, '2026-01-01': 50 });
});

test('santé COROS : jours fusionnés au format de health.json', () => {
  const h = healthFromCoros({
    daily: [read('coros-health', 'daily.txt')],
    hrv: [read('coros-health', 'hrv.txt')],
    rhr: [read('coros-health', 'rhr.txt')],
  });
  assert.deepEqual(Object.keys(h.days), ['2026-01-01', '2026-01-02', '2026-01-04']);
  assert.deepEqual(h.days['2026-01-01'], { sleepMin: 450, sleepMain: 450, sleepScore: 88, awakeMin: 20, deepMin: 75, remPct: 23.3, hrv: 72, rhr: 50 });
  assert.deepEqual(h.days['2026-01-02'], { sleepMin: 40, awakeMin: 5, deepMin: 0, remPct: 0, rhr: 49 });
  assert.deepEqual(h.weight, []);
});

// ---------- sources et identifiants ----------

test('sources : valeurs par défaut, validation', () => {
  const raw = mkdtempSync(join(tmpdir(), 'runstat-'));
  try {
    assert.deepEqual(readSources(raw), { activities: 'coros', health: 'google' });
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
  assert.deepEqual(validateSources({ activities: 'strava', health: 'none' }), { activities: 'strava', health: 'none' });
  assert.throws(() => validateSources({ activities: 'garmin', health: 'none' }), /activities/);
  assert.throws(() => validateSources({ activities: 'coros' }), /health : obligatoire/);
  assert.throws(() => validateSources({ activities: 'coros', health: 'coros', token: 'x' }), /champ inconnu/);
});

test('identifiants Strava : acceptés partout, fichiers sans « : »', () => {
  for (const id of ['100000000000000002', 'strava:12345']) assert.ok(ACTIVITY_ID.test(id), id);
  for (const id of ['strava:', 'strava:12a', 'garmin:1', '../1', 'strava-12']) assert.ok(!ACTIVITY_ID.test(id), id);
  assert.equal(fileKey('strava:12345'), 'strava-12345');
  assert.equal(fileKey('100000000000000002'), '100000000000000002');
  assert.equal(idFromFileKey('strava-12345'), 'strava:12345');
  assert.equal(idFromFileKey('100000000000000002'), '100000000000000002');
  assert.equal(validateResult('strava:12', { event: 'Semi', source: 'https://example.org/r' }, '2026-01-01').activityId, 'strava:12');
  const a = validateAthlete({ hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 180, birthday: '1990-01-01', raceWeights: { 'strava:12': 0.5 } });
  assert.deepEqual(a.raceWeights, { 'strava:12': 0.5 });
});
