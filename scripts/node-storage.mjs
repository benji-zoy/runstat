// Stockage du moteur (src/engine/storage/types.ts) sur le système de fichiers : data-raw/ et public/data/ du dépôt
// (ou du conteneur runstat-sync, où public/data est le dossier html/data du site).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPath } from '#engine/storage/types.ts';

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

export const nodeStorage = (base = root) => ({
  raw: new NodeStore(join(base, 'data-raw')),
  snapshot: new NodeStore(join(base, 'public', 'data')),
});
