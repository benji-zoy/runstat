// Stockage IndexedDB (navigateur) : une base, un magasin d'objets par zone (raw, snapshot), clé = chemin,
// valeur = octets du fichier. Prévu pour le local-first (phase 4) : données brutes et snapshot sur l'appareil.
import { childrenOf, cleanPath, decodeText, encodeText, type FileData, type FileStore, type Storage } from './types.ts';

const ZONES = ['raw', 'snapshot'] as const;
type Zone = (typeof ZONES)[number];
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ouvre (et crée au besoin) la base du moteur */
export function openEngineDb(name = 'runstat-engine', factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const req = factory.open(name, DB_VERSION);
  req.onupgradeneeded = () => {
    for (const zone of ZONES) if (!req.result.objectStoreNames.contains(zone)) req.result.createObjectStore(zone);
  };
  return request(req);
}

export class IndexedDbStore implements FileStore {
  private readonly db: IDBDatabase;
  private readonly zone: Zone;

  constructor(db: IDBDatabase, zone: Zone) {
    this.db = db;
    this.zone = zone;
  }

  private store(mode: IDBTransactionMode) {
    return this.db.transaction(this.zone, mode).objectStore(this.zone);
  }

  async list(dir: string): Promise<string[]> {
    if (dir) cleanPath(dir);
    const keys = await request(this.store('readonly').getAllKeys());
    return childrenOf(keys as string[], dir);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const v = await request(this.store('readonly').get(cleanPath(path)));
    return v == null ? null : new Uint8Array(v as ArrayBuffer | Uint8Array);
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.read(path);
    return b && decodeText(b);
  }

  async write(path: string, data: FileData): Promise<void> {
    const bytes = typeof data === 'string' ? encodeText(data) : data;
    const tx = this.db.transaction(this.zone, 'readwrite');
    tx.objectStore(this.zone).put(bytes, cleanPath(path));
    await transactionDone(tx);
  }

  async remove(path: string): Promise<void> {
    const tx = this.db.transaction(this.zone, 'readwrite');
    tx.objectStore(this.zone).delete(cleanPath(path));
    await transactionDone(tx);
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction annulée'));
  });
}

export async function indexedDbStorage(name?: string, factory?: IDBFactory): Promise<Storage> {
  const db = await openEngineDb(name, factory);
  return { raw: new IndexedDbStore(db, 'raw'), snapshot: new IndexedDbStore(db, 'snapshot') };
}
