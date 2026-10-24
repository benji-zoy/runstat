// Tests de la synchro : node --test scripts/sync/ (npm run test:sync). Données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pc from '#engine/parsers/coros.ts';
import { healthFromGoogle, mergeHealth, combineHealth } from '#engine/parsers/google.ts';
import { READ_TOOLS, callTool } from './coros.mjs';

const block = (n, id, date, start, name = 'Sortie') =>
  `${n}. Outdoor Run — ${date}\n   Location: ${name}\n   Time Window: startTimestamp=${start} | endTimestamp=${start + 1800}\n` +
  `   Duration: 30:00 | Distance: 5.00 km\n   LabelId: ${id} | SportType: 100`;
const records = (...blocks) =>
  JSON.stringify(
    `Sport Records — x to y (${blocks.length} records)\n========================\n\n${blocks.join('\n\n')}`,
  );

test('liste blanche : aucun outil d’écriture, refus avant tout appel réseau', async () => {
  for (const name of READ_TOOLS) assert.match(name, /^(query|get)/);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('aucune requête ne doit partir');
  try {
    for (const name of [
      'createTrainingPlan',
      'updateTrainingPlan',
      'createSingleWorkout',
      'updateWorkoutDetails',
      'scheduleWorkout',
      'createScheduledWorkout',
      'updateScheduledWorkout',
    ]) {
      await assert.rejects(callTool(name, {}), /non autorisé/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('records : fusion, renumérotation, suppression dans la fenêtre, idempotence', () => {
  const existing = records(
    block(1, '30', '2026-10-05', 3000),
    block(2, '20', '2026-10-01', 2000),
    block(3, '10', '2026-09-20', 1000),
  );
  // Fenêtre du 2026-10-01 au 2026-10-14 : 40 est nouvelle, 20 a été supprimée, 30 renommée
  const fetched = records(
    block(1, '40', '2026-10-14', 4000),
    block(2, '30', '2026-10-05', 3000, 'Renommée'),
  );
  const m = pc.mergeRecords(existing, fetched, { from: '2026-10-01', to: '2026-10-14' });
  const ids = pc.recordBlocks(m.text).map((r) => r.id);
  assert.deepEqual(ids, ['40', '30', '10']);
  assert.deepEqual(
    m.added.map((r) => r.id),
    ['40'],
  );
  assert.deepEqual(
    m.removed.map((r) => r.id),
    ['20'],
  );
  assert.match(m.text, /^1\. Outdoor Run — 2026-10-14/m);
  assert.match(m.text, /^3\. Outdoor Run — 2026-09-20/m);
  assert.match(m.text, /Location: Renommée/);
  const again = pc.mergeRecords(m.text, fetched, { from: '2026-10-01', to: '2026-10-14' });
  assert.equal(again.text, m.text);
  assert.equal(again.added.length, 0);
});

test('records : rien n’est supprimé si la réponse peut être tronquée', () => {
  const existing = records(block(1, '20', '2026-10-02', 2000));
  const m = pc.mergeRecords(existing, records(), {
    from: '2026-10-01',
    to: '2026-10-14',
    truncated: true,
  });
  assert.deepEqual(
    pc.recordBlocks(m.text).map((r) => r.id),
    ['20'],
  );
});

test('records : format lu par build-data (en-tête, LabelId, SportType)', () => {
  const m = pc.mergeRecords('', records(block(7, '99', '2026-10-14', 5000)), {
    from: '2026-10-14',
    to: '2026-10-14',
  });
  const b = m.text.split(/\n\s*\n/).find((x) => /LabelId:/.test(x));
  assert.match(b, /^\s*\d+\.\s+(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})/m);
  assert.match(b, /LabelId:\s*99/);
});

test('détail d’activité', () => {
  const text = JSON.stringify(
    'Activity Details\n====\n\nWorkout Time: 49:12\nBest Kilometer: 5:50 /km\nAverage Cadence: 171 spm\n' +
      'Average Stride Length: 0.97 m\nAverage Power: 207 W\nElevation Gain / Loss: 12 m / 11 m\n' +
      'Training Load: 84\nAerobic TE: 2.6\nAnaerobic TE: 0.0\nTraining Focus: Base',
  );
  assert.deepEqual(pc.parseDetail('5', text), {
    id: '5',
    elevGain: 12,
    elevLoss: 11,
    cadence: 171,
    stride: 0.97,
    power: 207,
    trainingLoad: 84,
    aerobicTE: 2.6,
    anaerobicTE: 0,
    focus: 'Base',
    bestKm: '5:50',
  });
  const indoor = pc.parseDetail('6', 'Average Cadence: 160 spm\nTraining Load: 30');
  assert.equal(indoor.elevGain, null);
  assert.equal(indoor.bestKm, null);
  assert.ok(pc.isUsableDetail(indoor));
  assert.ok(!pc.isUsableDetail(pc.parseDetail('7', 'Activity not found')));
});

test('charge : l’historique s’accumule au-delà de la fenêtre renvoyée', () => {
  const day = (d, r) =>
    `${d}\nComment: Maintaining\nShort-Term Load: 100\nLong-Term Load: 100\nLoad Ratio: ${r}`;
  const head = 'Training Load Assessment\n========================\n\n';
  const old = head + [day('2026-09-02', 0.9), day('2026-09-01', 0.8)].join('\n\n');
  const merged = pc.mergeLoad(
    old,
    JSON.stringify(head + [day('2026-09-03', 1.1), day('2026-09-02', 1.0)].join('\n\n')),
  );
  assert.deepEqual(
    [...merged.matchAll(/^(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]),
    ['2026-09-03', '2026-09-02', '2026-09-01'],
  );
  assert.match(merged, /2026-09-02\n[^]*?Load Ratio: 1\b/);
  assert.equal(pc.mergeLoad(merged, merged), merged);
});

test('FIT : quota, URL, en-tête', () => {
  assert.ok(
    pc.isFitQuota(
      'You have reached the daily limit of 50 activity FIT files. Please try again later.',
    ),
  );
  assert.ok(!pc.isFitQuota('https://example.com/a.fit'));
  assert.deepEqual(pc.fitUrls('"Files:\\n1. https://x.example/fit/123.fit?sig=a"'), [
    'https://x.example/fit/123.fit?sig=a',
  ]);
  const fit = Buffer.alloc(20);
  fit.write('.FIT', 8, 'ascii');
  assert.ok(pc.isFitFile(fit));
  assert.ok(!pc.isFitFile(Buffer.from('<html>error</html>')));
});

const src = (platform = 'FITBIT') => ({ dataSource: { platform } });
const date = (s) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};

test('santé Google : champs quotidiens et sommeil au format health.json', () => {
  const h = healthFromGoogle({
    'daily-resting-heart-rate': [
      { ...src(), dailyRestingHeartRate: { date: date('2026-10-14'), beatsPerMinute: '52' } },
    ],
    'daily-heart-rate-variability': [
      {
        ...src(),
        dailyHeartRateVariability: {
          date: date('2026-10-14'),
          averageHeartRateVariabilityMilliseconds: 98.5,
          nonRemHeartRateBeatsPerMinute: '47',
        },
      },
    ],
    'daily-respiratory-rate': [
      { ...src(), dailyRespiratoryRate: { date: date('2026-10-14'), breathsPerMinute: 16 } },
    ],
    'daily-sleep-temperature-derivations': [
      {
        ...src(),
        dailySleepTemperatureDerivations: {
          date: date('2026-10-14'),
          nightlyTemperatureCelsius: 33.5,
        },
      },
    ],
    'daily-oxygen-saturation': [
      { ...src(), dailyOxygenSaturation: { date: date('2026-10-14'), averagePercentage: 96.6 } },
    ],
    sleep: [
      {
        ...src(),
        sleep: {
          // Réveil à 6 h 30 heure de Paris (UTC+2) : nuit du 14
          interval: {
            startTime: '2026-10-13T21:49:00Z',
            endTime: '2026-10-14T04:30:00Z',
            endUtcOffset: '7200s',
          },
          metadata: { mainSleep: true },
          summary: {
            minutesAsleep: '366',
            minutesAwake: '35',
            stagesSummary: [
              { type: 'DEEP', minutes: '59' },
              { type: 'REM', minutes: '83' },
            ],
          },
        },
      },
      {
        ...src(),
        sleep: {
          interval: {
            startTime: '2026-10-14T12:00:00Z',
            endTime: '2026-10-14T12:30:00Z',
            endUtcOffset: '7200s',
          },
          metadata: { mainSleep: false },
          summary: { minutesAsleep: '25', minutesAwake: '5' },
        },
      },
    ],
    weight: [
      {
        ...src('HEALTH_CONNECT'),
        weight: { sampleTime: { physicalTime: '2026-09-14T22:00:00Z' }, weightGrams: 70605 },
      },
    ],
  });
  assert.deepEqual(h.days['2026-10-14'], {
    rhr: 52,
    hrv: 98.5,
    nremHr: 47,
    breath: 16,
    skinTemp: 33.5,
    spo2: 96.6,
    sleepMin: 391,
    sleepMain: 366,
    awakeMin: 35,
    deepMin: 59,
    remPct: 22.7,
  });
  assert.deepEqual(h.weight, [{ date: '2026-09-14', kg: 70.6 }]);
});

test('santé Google : le bracelet prime sur une autre source le même jour', () => {
  const h = healthFromGoogle({
    'daily-resting-heart-rate': [
      {
        ...src('FITBIT'),
        dailyRestingHeartRate: { date: date('2026-10-14'), beatsPerMinute: '52' },
      },
      {
        ...src('HEALTH_CONNECT'),
        dailyRestingHeartRate: { date: date('2026-10-14'), beatsPerMinute: '60' },
      },
    ],
  });
  assert.equal(h.days['2026-10-14'].rhr, 52);
});

test('santé : fusion idempotente et priorité de l’API sur Takeout', () => {
  const fetched = {
    days: { '2026-10-14': { rhr: 52 } },
    weight: [{ date: '2026-10-14', kg: 70.1 }],
  };
  const once = mergeHealth(
    { days: { '2026-10-13': { rhr: 50 }, '2026-10-14': { hrv: 90 } }, weight: [] },
    fetched,
    'T',
  );
  assert.deepEqual(mergeHealth(once, fetched, 'T'), once);
  assert.deepEqual(once.days['2026-10-14'], { hrv: 90, rhr: 52 });

  const takeout = {
    importedAt: '2026-10-07',
    days: { '2026-10-07': { rhr: 53, readiness: 57 }, '2026-10-14': { rhr: 55 } },
    weight: [{ date: '2026-09-14', kg: 70.6 }],
  };
  const all = combineHealth(takeout, once);
  assert.equal(all.importedAt, '2026-10-07');
  assert.equal(all.syncedAt, 'T');
  assert.deepEqual(all.days['2026-10-07'], { rhr: 53, readiness: 57 });
  assert.equal(all.days['2026-10-14'].rhr, 52);
  assert.deepEqual(Object.keys(all.days), ['2026-10-07', '2026-10-13', '2026-10-14']);
  assert.equal(all.weight.length, 2);
  assert.equal(combineHealth(takeout, null), takeout);
});

test('tracé seul : run.mjs refuse un identifiant invalide', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('.', import.meta.url));
  // Instance mono-utilisateur (RUNSTAT_USERS sans users.json), quel que soit le poste
  const env = { ...process.env, RUNSTAT_USERS: join(tmpdir(), 'runstat-aucun-compte') };
  const bad = spawnSync(process.execPath, [`${dir}run.mjs`, '--fit', '../x'], { encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--fit <labelId/);
});

// ---------- saisie depuis le site (entries.mjs) ----------

import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as en from './entries.mjs';

const goal = (over = {}) => ({ id: 'semi-2026', name: 'Semi', date: '2026-10-18', distanceKm: 21.0975, kind: 'road', ...over });

test('objectifs : normalisation, champs vides retirés, bilan trié', () => {
  const [g] = en.validateGoals([
    goal({ startTime: '09:30', targetSec: 5640, elevGain: '', lat: 45, lon: 5, debrief: { chipSec: 5790, gelsKm: [14, 7], notes: [' Parti vite ', ''] } }),
  ]);
  assert.deepEqual(g, {
    id: 'semi-2026', name: 'Semi', date: '2026-10-18', startTime: '09:30', distanceKm: 21.0975, targetSec: 5640, kind: 'road',
    lat: 45, lon: 5, debrief: { chipSec: 5790, gelsKm: [7, 14], notes: ['Parti vite'] },
  });
});

test('objectifs : erreurs (fourchette, date, doublon, champ inconnu, lieu incomplet)', () => {
  const errs = (list) => {
    try {
      en.validateGoals(list);
      return [];
    } catch (e) {
      assert.ok(e instanceof en.InvalidEntry);
      return e.errors.join('\n');
    }
  };
  assert.match(errs([goal({ targetSec: 5640, stretchSec: 6000 })]), /stretchSec : doit être plus rapide/);
  assert.match(errs([goal({ stretchSec: 5000 })]), /chrono visé manquant/);
  assert.match(errs([goal({ date: '2026-02-30' })]), /date inexistante/);
  assert.match(errs([goal(), goal()]), /identifiant en double/);
  assert.match(errs([goal({ coureur: 'X' })]), /coureur : champ inconnu/);
  assert.match(errs([goal({ lat: 43 })]), /lat\/lon/);
  assert.match(errs([goal({ kind: 'piste' })]), /kind/);
  assert.match(errs([goal({ id: 'Semi 2026' })]), /id : minuscules/);
  assert.throws(() => en.validateGoals({}), en.InvalidEntry);
});

test('réglages : bornes et poids des courses', () => {
  const a = { hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };
  assert.deepEqual(en.validateAthlete({ ...a, raceWeights: { '123': 0.5 } }), { ...a, raceWeights: { '123': 0.5 } });
  assert.deepEqual(en.validateAthlete({ ...a, raceWeights: {} }), a);
  assert.throws(() => en.validateAthlete({ ...a, hrRest: 100, hrMax: 135 }), /trop proche/);
  assert.throws(() => en.validateAthlete({ ...a, raceWeights: { abc: 1 } }), /raceWeights/);
  assert.throws(() => en.validateAthlete({ ...a, hrMax: undefined }), /hrMax : obligatoire/);
  assert.deepEqual(en.validateAthlete({ ...a, homeCity: 'Lyon' }), { ...a, homeCity: 'Lyon' });
  assert.throws(() => en.validateAthlete({ ...a, homeCity: 'x'.repeat(41) }), /homeCity/);
});

test('classement : effectifs seulement, rangs cohérents, source http', () => {
  const body = { event: '10 km de Valbourg', source: 'https://example.org/resultats', rank: 120, finishers: 900, sexRank: 100, sexCount: 600 };
  const r = en.validateResult('100000000000000001', body, '2026-10-17');
  assert.equal(r.activityId, '100000000000000001');
  assert.equal(r.fetchedAt, '2026-10-17');
  assert.equal(r.catRank, null);
  assert.throws(() => en.validateResult('100000000000000001', { ...body, rank: 1000 }), /rank : plus grand/);
  assert.throws(() => en.validateResult('100000000000000001', { ...body, source: 'javascript:alert(1)' }), /source/);
  assert.throws(() => en.validateResult('100000000000000001', { ...body, name: 'DUPONT' }), /name : champ inconnu/);
  assert.throws(() => en.validateResult('../etc', body), /identifiant/);
});

test('classement : écriture atomique, remplacement du fichier par date, suppression', () => {
  const raw = mkdtempSync(join(tmpdir(), 'runstat-'));
  try {
    mkdirSync(join(raw, 'results'));
    writeFileSync(join(raw, 'results', 'date-2026-04-26-19.json'), '{}');
    const body = { event: 'Trail', source: 'https://example.org' };
    en.saveResult(raw, '42', body, 'date-2026-04-26-19.json');
    assert.equal(JSON.parse(readFileSync(join(raw, 'results', '42.json'), 'utf8')).event, 'Trail');
    assert.ok(!existsSync(join(raw, 'results', 'date-2026-04-26-19.json')));
    // Un nom hors du motif n'est jamais supprimé
    writeFileSync(join(raw, 'results', 'autre.json'), '{}');
    en.saveResult(raw, '42', body, '../autre.json');
    assert.ok(existsSync(join(raw, 'results', 'autre.json')));
    assert.equal(en.deleteResult(raw, '42'), true);
    assert.equal(en.deleteResult(raw, '42'), false);
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
});
