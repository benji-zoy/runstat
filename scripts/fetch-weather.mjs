// Récupère la météo horaire (Open-Meteo, gratuit, sans clé) pour chaque lieu de départ,
// coordonnées arrondies à 0,1° (≈ 10 km). Résultat : data-raw/weather/<lat>_<lon>.json
// Altitude des points de départ (API elevation, à 0,01° près) : data-raw/weather/elevation.json
// Usage : node scripts/fetch-weather.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data-raw/weather');
mkdirSync(dir, { recursive: true });

const { activities } = JSON.parse(readFileSync(join(root, 'public/data/coros.json'), 'utf8'));
const HOURLY = 'temperature_2m,dew_point_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m';

const groups = new Map();
for (const a of activities) {
  if (a.lat == null || a.lon == null) continue;
  const key = `${a.lat.toFixed(1)}_${a.lon.toFixed(1)}`;
  const g = groups.get(key) ?? { lat: a.lat.toFixed(1), lon: a.lon.toFixed(1), dates: [] };
  g.dates.push(a.date);
  groups.set(key, g);
}

const isoDay = (d) => d.toISOString().slice(0, 10);
// Les archives (réanalyse ERA5) ont environ 5 jours de retard : le reste vient de l'API de prévision.
const archiveEnd = isoDay(new Date(Date.now() - 6 * 86_400_000));

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

for (const [key, g] of groups) {
  const file = join(dir, `${key}.json`);
  const cached = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { hourly: {} };
  // Un jour sans direction du vent (cache d'avant son ajout) est re-téléchargé
  const missing = [...new Set(g.dates)].filter((d) => cached.hourly[`${d}T12:00`]?.dir == null);
  if (!missing.length) {
    console.log(`${key} : à jour`);
    continue;
  }
  missing.sort();
  const start = missing[0];
  const end = missing.at(-1);
  const merge = (data) => {
    data.hourly.time.forEach((t, i) => {
      cached.hourly[t] = {
        t: data.hourly.temperature_2m[i],
        dew: data.hourly.dew_point_2m[i],
        rh: data.hourly.relative_humidity_2m[i],
        wind: data.hourly.wind_speed_10m[i],
        dir: data.hourly.wind_direction_10m[i],
      };
    });
  };
  if (start <= archiveEnd) {
    const to = end < archiveEnd ? end : archiveEnd;
    merge(await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${start}&end_date=${to}&hourly=${HOURLY}&timezone=auto`));
  }
  if (end > archiveEnd) {
    merge(await get(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&past_days=14&forecast_days=1&hourly=${HOURLY}&timezone=auto`));
  }
  writeFileSync(file, JSON.stringify(cached));
  console.log(`${key} : ${missing.length} jours (${start} → ${end})`);
}

// Altitude des points de départ (modèle numérique de terrain Copernicus, 90 m), par lots de 100
const elevFile = join(dir, 'elevation.json');
const elevation = existsSync(elevFile) ? JSON.parse(readFileSync(elevFile, 'utf8')) : {};
const toFetch = [
  ...new Set(activities.filter((a) => a.lat != null && a.lon != null).map((a) => `${a.lat.toFixed(2)}_${a.lon.toFixed(2)}`)),
].filter((k) => elevation[k] == null);
for (let i = 0; i < toFetch.length; i += 100) {
  const batch = toFetch.slice(i, i + 100);
  const lats = batch.map((k) => k.split('_')[0]).join(',');
  const lons = batch.map((k) => k.split('_')[1]).join(',');
  const data = await get(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  batch.forEach((k, j) => (elevation[k] = data.elevation[j]));
}
if (toFetch.length) {
  writeFileSync(elevFile, JSON.stringify(elevation));
  console.log(`Altitude : ${toFetch.length} points de départ`);
}

// Prévisions pour les objectifs des 15 prochains jours (data-raw/goals.json) : lieu indiqué,
// sinon la case de 0,1° où tu cours le plus souvent. Fichier séparé, pour ne pas mélanger prévision et archive.
const goalsFile = join(root, 'data-raw/goals.json');
const goals = existsSync(goalsFile) ? JSON.parse(readFileSync(goalsFile, 'utf8')) : [];
const home = [...groups.values()].sort((a, b) => b.dates.length - a.dates.length)[0];
for (const g of goals) {
  const days = (new Date(g.date) - new Date(isoDay(new Date()))) / 86_400_000;
  if (days < 0 || days > 15) continue;
  const lat = g.lat != null ? g.lat.toFixed(1) : home?.lat;
  const lon = g.lon != null ? g.lon.toFixed(1) : home?.lon;
  if (!lat) continue;
  const data = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&forecast_days=16&hourly=${HOURLY}&timezone=auto`);
  const hourly = {};
  data.hourly.time.forEach((t, i) => {
    hourly[t] = {
      t: data.hourly.temperature_2m[i], dew: data.hourly.dew_point_2m[i], rh: data.hourly.relative_humidity_2m[i],
      wind: data.hourly.wind_speed_10m[i], dir: data.hourly.wind_direction_10m[i],
    };
  });
  writeFileSync(join(dir, `forecast-${g.id}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), lat, lon, hourly }));
  console.log(`Prévision ${g.name} (${g.date}) : ${lat}, ${lon}${g.lat == null ? ' (lieu habituel)' : ''}`);
}
