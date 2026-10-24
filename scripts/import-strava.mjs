// Import de l'archive Strava sur le poste : npm run strava -- "<chemin vers export_….zip>", puis npm run data
// (sources.json : { "activities": "strava" }) et npm run nas -- push strava fit tracks. Depuis le site : Réglages.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStravaArchive } from './sync/strava-archive.mjs';

const zip = process.argv[2];
if (!zip) {
  console.error('Usage : npm run strava -- <export_strava.zip>');
  process.exit(1);
}
const raw = join(dirname(fileURLToPath(import.meta.url)), '..', 'data-raw');
const r = importStravaArchive(zip, raw);
console.log(
  `Strava : ${r.runs} sorties de course à pied (${r.added} nouvelles), ${r.files} tracés` +
    (r.skipped ? `, ${r.skipped} ignorés` : ''),
);
