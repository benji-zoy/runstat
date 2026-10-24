// Stockage des fichiers du moteur, indépendant de la plateforme : système de fichiers sur le NAS
// (scripts/node-storage.mjs), IndexedDB dans le navigateur (storage/indexeddb.ts), mémoire pour les tests.
// Chemins relatifs avec « / » (« fit-derived/123.json »), sans « .. » ni « / » initial.

export type FileData = string | Uint8Array;

export interface FileStore {
  /** Noms des fichiers directement dans `dir` ('' = racine), sans les sous-dossiers ; [] si le dossier n'existe pas. Ordre non garanti. */
  list(dir: string): Promise<string[]>;
  /** Contenu brut, ou null si le fichier n'existe pas */
  read(path: string): Promise<Uint8Array | null>;
  /** Contenu en UTF-8, ou null si le fichier n'existe pas */
  readText(path: string): Promise<string | null>;
  write(path: string, data: FileData): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Stockage qui sait lister tous ses chemins (mémoire, IndexedDB) : nécessaire à la sauvegarde */
export interface KeyedStore extends FileStore {
  keys(): Promise<string[]>;
}

/** Deux zones : données brutes (data-raw/) et snapshot servi à l'appli (public/data/) */
export interface Storage {
  raw: FileStore;
  snapshot: FileStore;
}

/** JSON d'un fichier, ou null s'il n'existe pas */
export async function readJson<T = unknown>(store: FileStore, path: string): Promise<T | null> {
  const text = await store.readText(path);
  return text == null ? null : (JSON.parse(text) as T);
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
export const encodeText = (s: string): Uint8Array => utf8.encode(s);
export const decodeText = (b: Uint8Array): string => fromUtf8.decode(b);

/** Chemin normalisé ; refuse « .. », chemins absolus et segments vides */
export function cleanPath(path: string): string {
  const parts = path.split('/');
  if (!path || parts.some((p) => !p || p === '.' || p === '..') || path.includes('\\') || path.includes('\0')) {
    throw new Error(`chemin invalide : ${path}`);
  }
  return path;
}

/** Noms directement dans `dir` parmi une liste de chemins complets */
export function childrenOf(paths: Iterable<string>, dir: string): string[] {
  const prefix = dir ? `${dir}/` : '';
  const out: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest && !rest.includes('/')) out.push(rest);
  }
  return out.sort();
}
