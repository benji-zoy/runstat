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
/**
 * Octets décompressés par import (lectures du zip et dégzippage des tracés, fichier activities.csv compris) : des milliers
 * de sorties en FIT ou GPX en font quelques Gio au plus ; au-delà, l'archive est refusée (bombe zip répartie sur des milliers
 * d'entrées, chacune sous MAX_TRACK).
 */
export const MAX_IMPORT_BYTES = 8 * 1024 ** 3;
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
  { warn = (_: string) => {}, onProgress = (_done: number, _total: number) => {}, maxImportBytes = MAX_IMPORT_BYTES } = {},
): Promise<ArchiveImport> {
  const zip = await openZip(src, { maxEntrySize: MAX_TRACK });
  let budget = maxImportBytes;
  const charge = (bytes: number) => {
    budget -= bytes;
    if (budget < 0)
      throw new ZipError(`archive refusée : plus de ${Math.round(maxImportBytes / 1024 ** 2)} Mio une fois décompressée, ce n'est pas une archive Strava ordinaire`);
  };
  const spend = (data: Uint8Array) => (charge(data.length), data);
  const csv = zip.entries.find((e) => /(^|\/)activities\.csv$/.test(e.name));
  if (!csv) throw new ZipError('activities.csv absent : est-ce bien l’archive Strava ?');
  // Archive éventuellement rangée dans un dossier : les chemins de la colonne Filename sont relatifs à activities.csv
  const base = csv.name.slice(0, -'activities.csv'.length);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const runs = parseActivitiesCsv(new TextDecoder().decode(spend(await zip.read(csv)))) as (StravaActivity & { filename?: string; file?: string })[];

  let files = 0;
  let skipped = 0;
  let done = 0;
  // Une entrée du zip ne sert qu'une fois : plusieurs lignes du CSV vers le même fichier ne le relisent pas
  const used = new Set<string>();
  for (const a of runs) {
    onProgress(done++, runs.length);
    const name = a.filename;
    delete a.filename;
    const m = name?.match(TRACK_ENTRY);
    const entry = m && name && !name.includes('..') ? byName.get(base + name) : undefined;
    if (!m || !entry || used.has(entry.name)) {
      if (name) skipped++;
      continue;
    }
    used.add(entry.name);
    let buf: Uint8Array;
    try {
      buf = spend(await zip.read(entry));
      if (m[2]) buf = spend(await inflate(buf, 'gzip', MAX_TRACK));
    } catch (e) {
      if (budget < 0) throw e;
      // Décompression arrêtée à MAX_TRACK : autant d'octets décompressés pour rien, comptés aussi
      if (e instanceof ZipError && /trop volumineux/.test(e.message)) charge(MAX_TRACK);
      warn(`  ${name} : ${(e as Error).message}`);
      skipped++;
      continue;
    }
    try {
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
