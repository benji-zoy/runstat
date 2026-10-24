// Import de l'archive Strava (strava.com › Paramètres › Mon compte › Télécharger ou supprimer votre compte), sur le NAS
// (scripts/sync/strava-archive.mjs) comme dans le navigateur (mode local-first) :
//   activities.csv              → strava/activities.json (course à pied seulement, fusion sans rien retirer)
//   activities/<n>.fit.gz       → fit/strava-<id>.fit (décompressé, analysé par buildFit comme un FIT COROS)
//   activities/<n>.gpx|tcx(.gz) → tracks/strava-<id>.gpx.gz | .tcx.gz (fit/track.ts)
// Le numéro du fichier n'est pas l'identifiant de l'activité : la correspondance vient de la colonne Filename.
// Aucun chemin n'est construit à partir des noms d'entrées du zip (pas de zip-slip).
import { isFitFile } from '../fit/parse-fit.ts';
import { mergeStravaActivities, parseActivitiesCsv, type StravaActivity } from '../parsers/strava.ts';
import { fileKey } from '../sources.ts';
import { readJson, type FileStore } from '../storage/types.ts';
import { ZipError, gzip, inflate, openZip, type ByteSource } from './zip.ts';

const MAX_TRACK = 256 * 1024 * 1024;
const TRACK_ENTRY = /^activities\/[\w.-]+\.(fit|gpx|tcx)(\.gz)?$/;
export const STRAVA_FILE = 'strava/activities.json';

export interface ArchiveImport {
  runs: number;
  added: number;
  files: number;
  skipped: number;
}

/** Lève ZipError si ce n'est pas une archive Strava. `onProgress(fait, total)` : suivi des tracés. */
export async function importStravaArchive(
  src: ByteSource,
  raw: FileStore,
  { warn = (_: string) => {}, onProgress = (_done: number, _total: number) => {} } = {},
): Promise<ArchiveImport> {
  const zip = await openZip(src, { maxEntrySize: MAX_TRACK });
  const csv = zip.entries.find((e) => /(^|\/)activities\.csv$/.test(e.name));
  if (!csv) throw new ZipError('activities.csv absent : est-ce bien l’archive Strava ?');
  // Archive éventuellement rangée dans un dossier : les chemins de la colonne Filename sont relatifs à activities.csv
  const base = csv.name.slice(0, -'activities.csv'.length);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const runs = parseActivitiesCsv(new TextDecoder().decode(await zip.read(csv))) as (StravaActivity & { filename?: string; file?: string })[];

  let files = 0;
  let skipped = 0;
  let done = 0;
  for (const a of runs) {
    onProgress(done++, runs.length);
    const name = a.filename;
    delete a.filename;
    const m = name?.match(TRACK_ENTRY);
    const entry = m && name && !name.includes('..') ? byName.get(base + name) : undefined;
    if (!m || !entry) {
      if (name) skipped++;
      continue;
    }
    try {
      let buf = await zip.read(entry);
      if (m[2]) buf = await inflate(buf, 'gzip', MAX_TRACK);
      const key = fileKey(a.id);
      if (m[1] === 'fit') {
        if (!isFitFile(buf)) throw new Error('FIT invalide');
        await raw.write(`fit/${key}.fit`, buf);
      } else {
        await raw.write(`tracks/${key}.${m[1]}.gz`, await gzip(buf));
      }
      a.file = m[1];
      files++;
    } catch (e) {
      warn(`  ${name} : ${(e as Error).message}`);
      skipped++;
    }
  }
  onProgress(runs.length, runs.length);

  const existing = (await readJson<StravaActivity[]>(raw, STRAVA_FILE)) ?? [];
  // L'archive complète l'historique sans écraser ce que l'API a déjà apporté (position de départ, course…)
  const merged = mergeStravaActivities(existing, runs, { prefer: 'existing' });
  await raw.write(STRAVA_FILE, JSON.stringify(merged.list));
  return { runs: runs.length, added: merged.added.length, files, skipped };
}
