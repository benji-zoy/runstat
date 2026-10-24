// Données fictives des tests du moteur (scripts/sync/fixtures/) : deux instances complètes, prêtes à charger dans
// un FileStore, et les sorties attendues, produites par l'ancien pipeline Node (build-fit.mjs + build-data.mjs).
import type { FileData } from '../storage/types.ts';

import sortieFit from '../../../scripts/sync/fixtures/engine/sortie.fit';
import records from '../../../scripts/sync/fixtures/engine/raw/records.txt';
import details0 from '../../../scripts/sync/fixtures/engine/raw/details/part-00.jsonl';
import details1 from '../../../scripts/sync/fixtures/engine/raw/details/part-01.jsonl';
import fitness from '../../../scripts/sync/fixtures/engine/raw/fitness.txt';
import load from '../../../scripts/sync/fixtures/engine/raw/load.txt';
import athlete from '../../../scripts/sync/fixtures/engine/raw/athlete.json';
import goals from '../../../scripts/sync/fixtures/engine/raw/goals.json';
import health from '../../../scripts/sync/fixtures/engine/raw/health.json';
import healthApi from '../../../scripts/sync/fixtures/engine/raw/health-api.json';
import laps from '../../../scripts/sync/fixtures/engine/raw/laps/100004.json';
import splits from '../../../scripts/sync/fixtures/engine/raw/splits/100002.json';
import result100005 from '../../../scripts/sync/fixtures/engine/raw/results/100005.json';
import resultOrphan from '../../../scripts/sync/fixtures/engine/raw/results/date-2025-01-01-10.json';
import resultSemi from '../../../scripts/sync/fixtures/engine/raw/results/date-2026-02-22-21.json';
import weather from '../../../scripts/sync/fixtures/engine/raw/weather/45.0_5.0.json';
import elevation from '../../../scripts/sync/fixtures/engine/raw/weather/elevation.json';
import forecast from '../../../scripts/sync/fixtures/engine/raw/weather/forecast-marathon-test.json';

import stravaSources from '../../../scripts/sync/fixtures/engine/raw-strava/sources.json';
import stravaAthlete from '../../../scripts/sync/fixtures/engine/raw-strava/athlete.json';
import stravaGoals from '../../../scripts/sync/fixtures/engine/raw-strava/goals.json';
import stravaHealth from '../../../scripts/sync/fixtures/engine/raw-strava/health-coros.json';
import stravaActivities from '../../../scripts/sync/fixtures/engine/raw-strava/strava/activities.json';
import gpxTrack from '../../../scripts/sync/fixtures/engine/raw-strava/tracks/strava-1001.gpx.gz';
import tcxTrack from '../../../scripts/sync/fixtures/engine/raw-strava/tracks/strava-1003.tcx.gz';

import expectedSortie from '../../../scripts/sync/fixtures/engine/expected/sortie.json';
import expectedCoros from '../../../scripts/sync/fixtures/engine/expected/coros.json';
import expectedRoutes from '../../../scripts/sync/fixtures/engine/expected/routes.json';
import expectedMissing from '../../../scripts/sync/fixtures/engine/expected/missing-details.txt';
import expectedStrava from '../../../scripts/sync/fixtures/engine/expected/strava-coros.json';
import expectedStravaRoutes from '../../../scripts/sync/fixtures/engine/expected/strava-routes.json';

import gpxExport from '../../../scripts/sync/fixtures/strava/export/activities/5551.gpx.gz';
import tcxExport from '../../../scripts/sync/fixtures/strava/export/activities/5553.tcx';
import csvFr from '../../../scripts/sync/fixtures/strava/activities-fr.csv';
import corosDaily from '../../../scripts/sync/fixtures/coros-health/daily.txt';
import corosHrv from '../../../scripts/sync/fixtures/coros-health/hrv.txt';
import corosRhr from '../../../scripts/sync/fixtures/coros-health/rhr.txt';

const json = (v: unknown) => JSON.stringify(v);

export { sortieFit, gpxExport, tcxExport, csvFr, corosDaily, corosHrv, corosRhr };

/** Instance COROS + Google Health : 6 sorties (une avec FIT, une sans détail), classements, météo, objectifs */
export const corosRaw = (): Record<string, FileData> => ({
  'records.txt': records,
  'details/part-00.jsonl': details0,
  'details/part-01.jsonl': details1,
  'fitness.txt': fitness,
  'load.txt': load,
  'athlete.json': json(athlete),
  'goals.json': json(goals),
  'health.json': json(health),
  'health-api.json': json(healthApi),
  'laps/100004.json': json(laps),
  'splits/100002.json': json(splits),
  'results/100005.json': json(result100005),
  'results/date-2025-01-01-10.json': json(resultOrphan),
  'results/date-2026-02-22-21.json': json(resultSemi),
  'weather/45.0_5.0.json': json(weather),
  'weather/elevation.json': json(elevation),
  'weather/forecast-marathon-test.json': json(forecast),
  'fit/100003.fit': sortieFit,
});

/** Instance Strava + santé COROS : sorties de l'archive fictive, un FIT, un GPX et un TCX */
export const stravaRaw = (): Record<string, FileData> => ({
  'sources.json': json(stravaSources),
  'athlete.json': json(stravaAthlete),
  'goals.json': json(stravaGoals),
  'health-coros.json': json(stravaHealth),
  'strava/activities.json': json(stravaActivities),
  'tracks/strava-1001.gpx.gz': gpxTrack,
  'tracks/strava-1003.tcx.gz': tcxTrack,
  'fit/strava-1006.fit': sortieFit,
});

/** Sorties de l'ancien pipeline Node (coros.json sans generatedAt) */
export const expected = {
  sortie: expectedSortie,
  coros: expectedCoros,
  routes: expectedRoutes,
  missing: expectedMissing,
  strava: expectedStrava,
  stravaRoutes: expectedStravaRoutes,
};
