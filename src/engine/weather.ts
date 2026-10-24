// Météo horaire (Open-Meteo, gratuit, sans clé, CORS ouvert) pour chaque lieu de départ, coordonnées arrondies à 0,1°
// (≈ 10 km) : weather/<lat>_<lon>.json ; altitude des points de départ (API elevation, à 0,01° près) : weather/elevation.json ;
// prévision des objectifs des 15 prochains jours : weather/forecast-<id>.json. Sur le NAS (scripts/fetch-weather.mjs) comme
// dans le navigateur (mode local-first), avec le cache déjà présent : seuls les jours manquants sont demandés.
import { readJson, type FileStore } from './storage/types.ts';

const HOURLY = 'temperature_2m,dew_point_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m';

interface Hour {
  t: number;
  dew: number;
  rh: number;
  wind: number;
  dir: number;
}
interface OpenMeteoHourly {
  hourly: {
    time: string[];
    temperature_2m: number[];
    dew_point_2m: number[];
    relative_humidity_2m: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
  };
}
interface Place {
  lat: number | null;
  lon: number | null;
  date: string;
}
interface Goal {
  id: string;
  name: string;
  date: string;
  lat?: number | null;
  lon?: number | null;
}

export interface WeatherOptions {
  fetch?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function hours(data: OpenMeteoHourly): Record<string, Hour> {
  const out: Record<string, Hour> = {};
  data.hourly.time.forEach((t, i) => {
    out[t] = {
      t: data.hourly.temperature_2m[i],
      dew: data.hourly.dew_point_2m[i],
      rh: data.hourly.relative_humidity_2m[i],
      wind: data.hourly.wind_speed_10m[i],
      dir: data.hourly.wind_direction_10m[i],
    };
  });
  return out;
}

/** Complète le cache météo de `raw` d'après les sorties du snapshot (coros.json) et les objectifs (goals.json) */
export async function fetchWeather(raw: FileStore, snapshot: FileStore, { fetch: get = globalThis.fetch, now = new Date(), log = () => {} }: WeatherOptions = {}): Promise<void> {
  const json = async <T>(url: string): Promise<T> => {
    const res = await get(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  };
  const activities = (await readJson<{ activities: Place[] }>(snapshot, 'coros.json'))?.activities ?? [];

  const groups = new Map<string, { lat: string; lon: string; dates: string[] }>();
  for (const a of activities) {
    if (a.lat == null || a.lon == null) continue;
    const key = `${a.lat.toFixed(1)}_${a.lon.toFixed(1)}`;
    const g = groups.get(key) ?? { lat: a.lat.toFixed(1), lon: a.lon.toFixed(1), dates: [] };
    g.dates.push(a.date);
    groups.set(key, g);
  }

  // Les archives (réanalyse ERA5) ont environ 5 jours de retard : le reste vient de l'API de prévision.
  const archiveEnd = isoDay(new Date(now.getTime() - 6 * 86_400_000));

  for (const [key, g] of groups) {
    const file = `weather/${key}.json`;
    const cached = (await readJson<{ hourly: Record<string, Hour> }>(raw, file)) ?? { hourly: {} };
    // Un jour sans direction du vent (cache d'avant son ajout) est re-téléchargé
    const missing = [...new Set(g.dates)].filter((d) => cached.hourly[`${d}T12:00`]?.dir == null);
    if (!missing.length) {
      log(`${key} : à jour`);
      continue;
    }
    missing.sort();
    const start = missing[0];
    const end = missing[missing.length - 1];
    const merge = (data: OpenMeteoHourly) => Object.assign(cached.hourly, hours(data));
    if (start <= archiveEnd) {
      const to = end < archiveEnd ? end : archiveEnd;
      merge(await json(`https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${start}&end_date=${to}&hourly=${HOURLY}&timezone=auto`));
    }
    if (end > archiveEnd) {
      merge(await json(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&past_days=14&forecast_days=1&hourly=${HOURLY}&timezone=auto`));
    }
    await raw.write(file, JSON.stringify(cached));
    log(`${key} : ${missing.length} jours (${start} → ${end})`);
  }

  // Altitude des points de départ (modèle numérique de terrain Copernicus, 90 m), par lots de 100
  const elevFile = 'weather/elevation.json';
  const elevation = (await readJson<Record<string, number>>(raw, elevFile)) ?? {};
  const toFetch = [
    ...new Set(activities.filter((a) => a.lat != null && a.lon != null).map((a) => `${a.lat!.toFixed(2)}_${a.lon!.toFixed(2)}`)),
  ].filter((k) => elevation[k] == null);
  for (let i = 0; i < toFetch.length; i += 100) {
    const batch = toFetch.slice(i, i + 100);
    const lats = batch.map((k) => k.split('_')[0]).join(',');
    const lons = batch.map((k) => k.split('_')[1]).join(',');
    const data = await json<{ elevation: number[] }>(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
    batch.forEach((k, j) => (elevation[k] = data.elevation[j]));
  }
  if (toFetch.length) {
    await raw.write(elevFile, JSON.stringify(elevation));
    log(`Altitude : ${toFetch.length} points de départ`);
  }

  // Prévisions pour les objectifs des 15 prochains jours : lieu indiqué, sinon la case de 0,1° où l'on court le plus souvent.
  // Fichier séparé, pour ne pas mélanger prévision et archive.
  const goals = (await readJson<Goal[]>(raw, 'goals.json')) ?? [];
  const home = [...groups.values()].sort((a, b) => b.dates.length - a.dates.length)[0];
  for (const g of goals) {
    const days = (new Date(g.date).getTime() - new Date(isoDay(now)).getTime()) / 86_400_000;
    if (days < 0 || days > 15) continue;
    const lat = g.lat != null ? g.lat.toFixed(1) : home?.lat;
    const lon = g.lon != null ? g.lon.toFixed(1) : home?.lon;
    if (!lat) continue;
    const data = await json<OpenMeteoHourly>(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&forecast_days=16&hourly=${HOURLY}&timezone=auto`);
    await raw.write(`weather/forecast-${g.id}.json`, JSON.stringify({ fetchedAt: now.toISOString(), lat, lon, hourly: hours(data) }));
    log(`Prévision ${g.name} (${g.date}) : ${lat}, ${lon}${g.lat == null ? ' (lieu habituel)' : ''}`);
  }
}
