// Import de l'archive Strava (strava.com › Paramètres › Mon compte › Télécharger ou supprimer votre compte) :
//   activities.csv            → data-raw/strava/activities.json (course à pied seulement, fusion sans rien retirer)
//   activities/<n>.fit.gz     → data-raw/fit/strava-<id>.fit (décompressé, analysé par build-fit comme un FIT COROS)
//   activities/<n>.gpx|tcx(.gz) → data-raw/tracks/strava-<id>.gpx.gz | .tcx.gz (src/engine/fit/track.ts)
// Le numéro du fichier n'est pas l'identifiant de l'activité : la correspondance vient de la colonne Filename.
// Aucun chemin n'est construit à partir des noms d'entrées du zip (pas de zip-slip).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openZip, ZipError } from './zip.mjs';
import { parseActivitiesCsv, mergeStravaActivities } from '#engine/parsers/strava.ts';
import { fileKey } from './sources.mjs';
import { isFitFile } from '#engine/parsers/coros.ts';

const MAX_TRACK = 256 * 1024 * 1024;
const TRACK_ENTRY = /^activities\/[\w.-]+\.(fit|gpx|tcx)(\.gz)?$/;

export const stravaFile = (raw) => join(raw, 'strava', 'activities.json');

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

/**
 * @returns { runs, added, files, skipped } ; lève ZipError si ce n'est pas une archive Strava
 */
export function importStravaArchive(zipPath, raw) {
  const zip = openZip(zipPath, { maxEntrySize: MAX_TRACK });
  try {
    const csv = zip.entries.find((e) => /(^|\/)activities\.csv$/.test(e.name));
    if (!csv) throw new ZipError('activities.csv absent : est-ce bien l’archive Strava ?');
    // Archive éventuellement rangée dans un dossier : les chemins de la colonne Filename sont relatifs à activities.csv
    const base = csv.name.slice(0, -'activities.csv'.length);
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    const runs = parseActivitiesCsv(zip.read(csv).toString('utf8'));

    let files = 0, skipped = 0;
    for (const a of runs) {
      const name = a.filename;
      delete a.filename;
      const m = name?.match(TRACK_ENTRY);
      const entry = m && !name.includes('..') && byName.get(base + name);
      if (!entry) {
        if (name) skipped++;
        continue;
      }
      try {
        let buf = zip.read(entry);
        if (m[2]) buf = gunzipSync(buf, { maxOutputLength: MAX_TRACK });
        const key = fileKey(a.id);
        if (m[1] === 'fit') {
          if (!isFitFile(buf)) throw new Error('FIT invalide');
          writeAtomic(join(raw, 'fit', `${key}.fit`), buf);
        } else {
          writeAtomic(join(raw, 'tracks', `${key}.${m[1]}.gz`), gzipSync(buf));
        }
        a.file = m[1];
        files++;
      } catch (e) {
        console.warn(`  ${name} : ${e.message}`);
        skipped++;
      }
    }

    const file = stravaFile(raw);
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    // L'archive complète l'historique sans écraser ce que l'API a déjà apporté (position de départ, course…)
    const merged = mergeStravaActivities(existing, runs, { prefer: 'existing' });
    writeAtomic(file, JSON.stringify(merged.list));
    return { runs: runs.length, added: merged.added.length, files, skipped };
  } finally {
    zip.close();
  }
}
