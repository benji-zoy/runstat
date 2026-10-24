// Sources de données d'une instance : lecture de data-raw/sources.json (Node). Le reste est dans le moteur
// (src/engine/sources.ts), partagé avec l'appli.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSources } from '#engine/sources.ts';

export {
  ACTIVITY_SOURCES,
  HEALTH_SOURCES,
  DEFAULT_SOURCES,
  ACTIVITY_ID,
  fileKey,
  idFromFileKey,
  normalizeSources,
} from '#engine/sources.ts';

export function readSources(raw) {
  const file = join(raw, 'sources.json');
  return normalizeSources(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}
