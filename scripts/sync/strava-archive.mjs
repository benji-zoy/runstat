// Import de l'archive Strava sur le NAS ou le poste : lecture et conversion par le moteur (src/engine/archive/), fichier
// ouvert en Blob à accès direct (fs.openAsBlob, jamais chargé en mémoire), écritures atomiques dans data-raw/.
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { STRAVA_FILE, importStravaArchive as importArchive } from '#engine/archive/strava-archive.ts';
import { blobSource } from '#engine/archive/zip.ts';
import { NodeStore } from '../node-storage.mjs';

export { ZipError } from '#engine/archive/zip.ts';
export const stravaFile = (raw) => join(raw, STRAVA_FILE);

/** @returns Promise<{ runs, added, files, skipped }> ; ZipError si ce n'est pas une archive Strava */
export async function importStravaArchive(zipPath, raw) {
  return importArchive(blobSource(await openAsBlob(zipPath)), new NodeStore(raw), { warn: (m) => console.warn(m) });
}
