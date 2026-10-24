// Stockage en mémoire (tests, calculs ponctuels).
import { childrenOf, cleanPath, decodeText, encodeText, type FileData, type FileStore, type Storage } from './types.ts';

export class MemoryStore implements FileStore {
  readonly files = new Map<string, Uint8Array>();

  constructor(initial: Record<string, FileData> = {}) {
    for (const [path, data] of Object.entries(initial)) this.files.set(cleanPath(path), toBytes(data));
  }

  async list(dir: string): Promise<string[]> {
    return childrenOf(this.files.keys(), dir);
  }

  /** Tous les chemins, sous-dossiers compris (sauvegarde) */
  async keys(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(cleanPath(path)) ?? null;
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.read(path);
    return b && decodeText(b);
  }

  async write(path: string, data: FileData): Promise<void> {
    this.files.set(cleanPath(path), toBytes(data));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(cleanPath(path));
  }
}

export const memoryStorage = (raw: Record<string, FileData> = {}): Storage => ({
  raw: new MemoryStore(raw),
  snapshot: new MemoryStore(),
});

const toBytes = (data: FileData) => (typeof data === 'string' ? encodeText(data) : new Uint8Array(data));
