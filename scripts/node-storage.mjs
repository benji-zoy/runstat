// Stockage du moteur (src/engine/storage/types.ts) sur le système de fichiers : dossiers de l'utilisateur du run
// (scripts/paths.mjs : RUNSTAT_RAW / RUNSTAT_SNAPSHOT, sinon data-raw/ et public/data/ du dépôt).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPath } from '#engine/storage/types.ts';
import { rawDir, snapshotDir } from './paths.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export class NodeStore {
  constructor(dir) {
    this.dir = dir;
  }

  #path(path) {
    return join(this.dir, cleanPath(path));
  }

  async list(dir) {
    const d = dir ? this.#path(dir) : this.dir;
    if (!existsSync(d)) return [];
    return readdirSync(d, { withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => e.name);
  }

  async read(path) {
    const f = this.#path(path);
    return existsSync(f) ? readFileSync(f) : null;
  }

  async readText(path) {
    const f = this.#path(path);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  /** Écriture atomique (fichier temporaire puis renommage) : un lecteur ne voit jamais un fichier à moitié écrit */
  async write(path, data) {
    const f = this.#path(path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, data);
    renameSync(`${f}.tmp`, f);
  }

  async remove(path) {
    rmSync(this.#path(path), { force: true });
  }
}

/** `base` : copie d'un dépôt (data-raw/ et public/data/), sinon les dossiers du run */
export const nodeStorage = (base) => ({
  raw: new NodeStore(base ? join(base, 'data-raw') : rawDir()),
  snapshot: new NodeStore(base ? join(base, 'public', 'data') : snapshotDir()),
});
