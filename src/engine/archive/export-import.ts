// Import d'un export RunStat (Réglages › Mes données du NAS, ou « Mes données » d'un autre appareil) dans la zone raw :
// passage d'un compte hébergé à l'appli publique, ou d'un appareil à l'autre sans compte. Seul `data-raw/` est repris
// (`snapshot/` se reconstruit) ; les fichiers de même chemin sont remplacés, les autres gardés (jetons de l'appareil compris).
// Chemins vérifiés un à un (pas de zip-slip), mêmes bornes que l'archive Strava.
import type { FileStore } from '../storage/types.ts';
import { exported } from './zip-writer.ts';
import { ZipError, openZip, type ByteSource } from './zip.ts';

const MAX_ENTRY = 256 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 8 * 1024 ** 3;
const PREFIX = 'data-raw/';
const SEGMENT = /^[\w.@ -]+$/;

/**
 * Repris de l'export mais propres à la machine d'origine : état de synchro (curseurs, ré-autorisation : l'appareil fait sa
 * première synchro lui-même, les fusions sont idempotentes), réponses brutes du NAS, état local et index de sauvegarde,
 * fichiers du poste. `missing-details.txt` se recalcule.
 */
const SKIPPED = [
  /^sync-state\.json$/,
  /^sync-primary\.json$/,
  /^local-state\.json$/,
  /^backup-index\.json$/,
  /^missing-details\.txt$/,
  /^nas\.txt$/,
  /^health-source\.txt$/,
  /^raw\//,
];

export interface ExportImport {
  files: number;
  bytes: number;
  skipped: number;
}

/** Chemin relatif sûr : segments simples, ni `.` ni `..`, ni chemin absolu ni antislash */
export const safePath = (path: string) => path.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');

/** Lève ZipError si ce n'est pas un export RunStat. `onProgress(fait, total)` : suivi des fichiers. */
export async function importRunstatExport(
  src: ByteSource,
  raw: FileStore,
  { onProgress = (_done: number, _total: number) => {}, maxImportBytes = MAX_EXPORT_BYTES } = {},
): Promise<ExportImport> {
  const zip = await openZip(src, { maxEntrySize: MAX_ENTRY });
  const readme = zip.entries.find((e) => e.name === 'LISEZMOI.txt');
  const head = readme && readme.size < 4096 ? new TextDecoder().decode(await zip.read(readme)) : '';
  if (!head.startsWith('Export RunStat')) throw new ZipError('ce n’est pas un export RunStat (LISEZMOI.txt absent)');
  const entries = zip.entries.filter((e) => e.name.startsWith(PREFIX));
  if (!entries.length) throw new ZipError('export vide : aucun fichier dans data-raw/');

  let budget = maxImportBytes;
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    onProgress(i, entries.length);
    const path = e.name.slice(PREFIX.length);
    if (!safePath(path) || seen.has(path) || !exported(path) || SKIPPED.some((re) => re.test(path))) {
      skipped++;
      continue;
    }
    seen.add(path);
    const data = await zip.read(e);
    budget -= data.length;
    if (budget < 0) throw new ZipError(`export refusé : plus de ${Math.round(maxImportBytes / 1024 ** 2)} Mio une fois décompressé`);
    if (path.endsWith('.json')) {
      try {
        JSON.parse(new TextDecoder().decode(data));
      } catch {
        skipped++;
        continue;
      }
    }
    await raw.write(path, data);
    files++;
    bytes += data.length;
  }
  onProgress(entries.length, entries.length);
  return { files, bytes, skipped };
}
