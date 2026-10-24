// Reconstruction complète d'une instance, sur l'appareil (mode local-first, Web Worker de l'appli), comme run.mjs --rebuild
// sur le NAS : analyse des FIT et tracés (recalcul forcé si FC max, FC repos ou seuils ont changé), snapshot, météo, snapshot.
// État dans local-state.json de la zone raw (empreinte des réglages FIT, dernière reconstruction, dernière erreur météo).
import { buildFit, buildFitSummary } from './build-fit.ts';
import { buildSnapshot, snapshotSummary, writeSnapshot } from '../snapshot/build.ts';
import { fetchWeather } from '../weather.ts';
import { readJson, type Storage } from '../storage/types.ts';

export const LOCAL_STATE = 'local-state.json';

interface FitAthlete {
  hrMax: number;
  hrRest: number;
  lt1Hr?: number | null;
  lt2Hr?: number | null;
}

export interface LocalState {
  athleteFit?: string;
  lastBuild?: string;
  lastBuildError?: string;
  lastWeatherError?: string;
}

export interface RebuildOptions {
  /** Météo Open-Meteo (réseau) ; sans elle, le snapshot garde le cache déjà présent */
  weather?: boolean;
  fetch?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}

export async function rebuild(storage: Storage, { weather = true, fetch: get = globalThis.fetch, now = new Date(), log = () => {} }: RebuildOptions = {}): Promise<{ summary: string; state: LocalState }> {
  const raw = storage.raw;
  const state = (await readJson<LocalState>(raw, LOCAL_STATE)) ?? {};
  const athlete = await readJson<FitAthlete>(raw, 'athlete.json');
  try {
    // Sans réglages de l'athlète, pas d'analyse FIT (zones de FC) : le snapshot se construit quand même
    if (athlete) {
      const fitKey = JSON.stringify([athlete.hrMax, athlete.hrRest, athlete.lt1Hr ?? null, athlete.lt2Hr ?? null]);
      const fit = await buildFit(raw, { force: state.athleteFit !== undefined && state.athleteFit !== fitKey });
      log(buildFitSummary(fit));
      fit.warnings.forEach(log);
      state.athleteFit = fitKey;
    }
    let result = await buildSnapshot(raw, { now });
    await writeSnapshot(storage, result);
    if (weather) {
      try {
        await fetchWeather(raw, storage.snapshot, { fetch: get, now, log });
        result = await buildSnapshot(raw, { now });
        await writeSnapshot(storage, result);
        delete state.lastWeatherError;
      } catch (e) {
        // Hors ligne : le snapshot reste valable, la météo sera complétée la prochaine fois
        state.lastWeatherError = (e as Error).message;
        log(`Météo : ${state.lastWeatherError}`);
      }
    }
    state.lastBuild = now.toISOString();
    delete state.lastBuildError;
    const summary = snapshotSummary(result);
    log(summary);
    return { summary, state };
  } catch (e) {
    state.lastBuildError = (e as Error).message;
    throw e;
  } finally {
    await raw.write(LOCAL_STATE, JSON.stringify(state));
  }
}
