// Garmin Personal API → sorties et jours de santé, sur des réponses fictives au format du Swagger officiel.
import { activityFromGarmin, healthFromGarmin } from './garmin.ts';

const run = {
  activityId: 1001,
  activityName: 'Sortie du matin',
  startTimeLocal: '2026-03-09 07:30:00',
  beginTimestamp: 1773037800000,
  activityType: { typeKey: 'running' },
  eventType: { typeKey: 'uncategorized' },
  distance: 10020.5,
  duration: 3050,
  movingDuration: 3000,
  elapsedDuration: 3100,
  elevationGain: 42,
  elevationLoss: 40,
  averageHR: 148.6,
  maxHR: 171,
  calories: 702,
  averageRunningCadenceInStepsPerMinute: 171.4,
  avgPower: 251,
  startLatitude: 45.1234,
  startLongitude: 4.5678,
};

describe('Garmin : activités', () => {
  it('convertit une sortie au format commun, date et heure locales de Garmin', () => {
    expect(activityFromGarmin(run)).toEqual({
      id: 'garmin:1001', sportType: 100, name: 'Sortie du matin', date: '2026-03-09', start: 1773037800,
      durationSec: 3000, elapsedSec: 3100, distanceKm: 10.021, avgHr: 149, maxHr: 171, calories: 702,
      elevGain: 42, elevLoss: 40, cadence: 171, power: 251, lat: 45.1234, lon: 4.5678,
    });
  });

  it('classe trail, tapis et piste ; marque les courses ; ignore les autres sports', () => {
    const t = (typeKey: string, extra = {}) => activityFromGarmin({ ...run, activityType: { typeKey }, ...extra });
    expect(t('trail_running')?.sportType).toBe(102);
    expect(t('treadmill_running')?.sportType).toBe(101);
    expect(t('track_running')?.sportType).toBe(103);
    expect(t('running', { eventType: { typeKey: 'race' } })?.race).toBe(true);
    expect(t('cycling')).toBeNull();
    expect(activityFromGarmin({ ...run, distance: 0 })).toBeNull();
  });

  it('prend la durée du chronomètre sans temps de déplacement', () => {
    expect(activityFromGarmin({ ...run, movingDuration: undefined })?.durationSec).toBe(3050);
  });
});

describe('Garmin : santé', () => {
  it('sommeil, VFC, FC de repos et poids rattachés à la date du réveil', () => {
    const h = healthFromGarmin({
      sleep: [
        {
          calendarDate: '2026-03-09', sleepTimeSeconds: 27000, napTimeSeconds: 1200, deepSleepSeconds: 5400,
          remSleepSeconds: 6300, awakeSleepSeconds: 900, averageRespirationValue: 14.26, averageSpO2Value: 95.4,
          sleepScores: { overall: { value: 81 } },
        },
        { calendarDate: '2026-03-08', sleepTimeSeconds: 0 },
      ],
      hrv: [{ calendarDate: '2026-03-09', lastNightAvg: 62 }, { calendarDate: '2026-03-08', lastNightAvg: null }],
      summaries: [{ calendarDate: '2026-03-09', heartRate: { restingValue: 47 } }, { calendarDate: '2026-03-07', heartRate: null }],
      weight: [
        { summaryDate: '2026-03-09', latestWeight: { weight: 70.4 } },
        { summaryDate: '2026-03-08', latestWeight: { weight: 70600 } },
      ],
    });
    expect(h.days).toEqual({
      '2026-03-09': {
        sleepMin: 470, sleepMain: 450, awakeMin: 15, deepMin: 90, remPct: 23.3, sleepScore: 81, breath: 14.3, spo2: 95.4,
        hrv: 62, rhr: 47,
      },
    });
    expect(h.weight).toEqual([{ date: '2026-03-08', kg: 70.6 }, { date: '2026-03-09', kg: 70.4 }]);
  });

  it('ignore les dates mal formées', () => {
    expect(healthFromGarmin({ hrv: [{ calendarDate: '09/03/2026', lastNightAvg: 60 }] }).days).toEqual({});
  });
});
