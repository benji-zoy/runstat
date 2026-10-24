// Moteur de RunStat : des données brutes des sources au snapshot de l'appli, sans API Node ni Angular.
// Tourne sur le NAS (scripts/*.mjs, type stripping de Node) et dans le navigateur (stockage IndexedDB).
export * from './sources.ts';
export * from './fit/types.ts';
export * from './fit/analyse.ts';
export * from './fit/track.ts';
export * from './fit/parse-fit.ts';
export * from './pipeline/build-fit.ts';
export * from './snapshot/coros-text.ts';
export * from './snapshot/build.ts';
export * from './fit-queue.ts';
export * from './pipeline/rebuild.ts';
export * from './weather.ts';
export * from './entries.ts';
export * from './archive/zip.ts';
export * from './archive/strava-archive.ts';
export * from './storage/types.ts';
export * from './storage/memory.ts';
export * from './storage/indexeddb.ts';
export * as coros from './parsers/coros.ts';
export * as google from './parsers/google.ts';
export * as strava from './parsers/strava.ts';
export * as corosHealth from './parsers/coros-health.ts';
