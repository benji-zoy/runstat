// Météo horaire des lieux de départ, altitude et prévisions des objectifs (Open-Meteo) : src/engine/weather.ts, sur les
// dossiers de l'utilisateur du run (scripts/paths.mjs). Résultat dans data-raw/weather/.
// Usage : node scripts/fetch-weather.mjs
import { fetchWeather } from '#engine/weather.ts';
import { nodeStorage } from './node-storage.mjs';

const { raw, snapshot } = nodeStorage();
await fetchWeather(raw, snapshot, { log: (line) => console.log(line) });
