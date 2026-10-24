import { Injectable, signal } from '@angular/core';
import { DATE_RESULT, InvalidEntry, validateAthlete, validateGoals, validateResult, validateSources } from '../../engine/entries';
import { fileKey } from '../../engine/sources';
import { IndexedDbStore, indexedDbStorage } from '../../engine/storage/indexeddb';
import { exportEntries, zipStream } from '../../engine/archive/zip-writer';
import type { KeyedStore, Storage } from '../../engine/storage/types';
import type { ArchiveImport } from '../../engine/archive/strava-archive';
import { EntryError } from './entry-error';
import type { CorosData } from './models';

interface Job {
  type: 'rebuild' | 'import';
  file?: File;
  onProgress?: (p: number) => void;
}

/**
 * Mode local-first (appli publique) : données brutes et snapshot dans IndexedDB (base runstat-engine), calculs par le moteur
 * dans un Web Worker (core/engine.worker.ts). La saisie est validée par les mêmes règles que sur le NAS (src/engine/entries.ts).
 * Rien ne quitte l'appareil, sauf les appels aux services choisis (météo Open-Meteo pour l'instant).
 */
@Injectable({ providedIn: 'root' })
export class LocalService {
  /** Calcul en cours (reconstruction ou import) */
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);
  /** Appelé après chaque calcul réussi (sauvegarde automatique, core/account.service.ts) */
  onRebuilt?: () => void;
  private storage?: Promise<Storage>;
  private worker?: Worker;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private waiting: { promise: Promise<string> } | null = null;

  private store(): Promise<Storage> {
    return (this.storage ??= indexedDbStorage());
  }

  /** Zone des données brutes (sauvegarde chiffrée) */
  async raw(): Promise<KeyedStore> {
    return (await this.store()).raw as KeyedStore;
  }

  async snapshot(): Promise<CorosData | null> {
    const text = await (await this.store()).snapshot.readText('coros.json');
    return text ? (JSON.parse(text) as CorosData) : null;
  }

  async routes(): Promise<Record<string, string>> {
    const text = await (await this.store()).snapshot.readText('routes.json');
    return text ? JSON.parse(text) : {};
  }

  /** Export (RGPD) : zip de la zone raw sans les jetons, et du snapshot */
  async exportZip(): Promise<Blob> {
    const s = await this.store();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for await (const p of zipStream(exportEntries(s.raw as KeyedStore, s.snapshot))) parts.push(p as Uint8Array<ArrayBuffer>);
    return new Blob(parts, { type: 'application/zip' });
  }

  /** Efface toutes les données de l'appareil (après le calcul en cours) */
  async wipe(): Promise<void> {
    await this.chain;
    const s = await this.store();
    await (s.raw as IndexedDbStore).clear();
    await (s.snapshot as IndexedDbStore).clear();
  }

  /** Demande au navigateur de ne pas effacer les données (Safari les efface après 7 jours sans visite, sauf appli installée) */
  async persist(): Promise<boolean> {
    try {
      return (await navigator.storage?.persisted?.()) || ((await navigator.storage?.persist?.()) ?? false);
    } catch {
      return false;
    }
  }

  /**
   * Saisie (mêmes chemins que l'API du NAS : goals, athlete, sources, results/<id>) : validée, écrite dans la zone raw,
   * puis reconstruction en arrière-plan. Renvoie la valeur normalisée, comme le NAS.
   */
  async apply(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ saved: unknown }> {
    void this.persist();
    const raw = (await this.store()).raw;
    const [route, query] = path.split('?');
    const replaces = new URLSearchParams(query ?? '').get('replaces');
    let saved: unknown = null;
    try {
      if (route === 'goals') await raw.write('goals.json', JSON.stringify((saved = validateGoals(body)), null, 2));
      else if (route === 'athlete') await raw.write('athlete.json', JSON.stringify((saved = validateAthlete(body)), null, 2));
      else if (route === 'sources') await raw.write('sources.json', JSON.stringify((saved = validateSources(body)), null, 2));
      else if (route.startsWith('results/')) {
        const id = decodeURIComponent(route.slice('results/'.length));
        if (method === 'DELETE') {
          const exists = (await raw.read(`results/${fileKey(id)}.json`)) != null || (replaces && DATE_RESULT.test(replaces));
          if (!exists) throw new EntryError(['aucun classement pour cette sortie']);
          await raw.remove(`results/${fileKey(id)}.json`);
        } else await raw.write(`results/${fileKey(id)}.json`, JSON.stringify((saved = validateResult(id, body)), null, 2));
        if (replaces && DATE_RESULT.test(replaces)) await raw.remove(`results/${replaces}`);
      } else throw new EntryError(['Pas encore disponible sur l’appareil']);
    } catch (e) {
      if (e instanceof InvalidEntry) throw new EntryError(e.errors);
      throw e;
    }
    return { saved };
  }

  /** Reconstruction complète, regroupée : une demande qui attend encore son tour sert aussi aux saisies suivantes */
  rebuild(): Promise<string> {
    if (this.waiting) return this.waiting.promise;
    const entry: { promise: Promise<string> } = { promise: Promise.resolve('') };
    entry.promise = this.enqueue<{ summary: string }>({ type: 'rebuild' }, () => {
      // Démarrée : une saisie à partir de maintenant en demandera une autre
      if (this.waiting === entry) this.waiting = null;
    }).then((r) => r.summary);
    this.waiting = entry;
    return entry.promise;
  }

  /** Archive Strava choisie sur l'appareil : lue par morceaux (jamais envoyée), importée puis reconstruite */
  importArchive(file: File, onProgress?: (p: number) => void): Promise<{ imported: ArchiveImport; summary: string }> {
    void this.persist();
    return this.enqueue({ type: 'import', file, onProgress });
  }

  /** Un calcul à la fois (le worker écrit dans IndexedDB) */
  private enqueue<T>(job: Job, onStart?: () => void): Promise<T> {
    const run = this.chain.then(() => (onStart?.(), this.post<T>(job)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private post<T>(job: Job): Promise<T> {
    this.busy.set(true);
    this.lastError.set(null);
    const worker = (this.worker ??= this.createWorker());
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: job.onProgress });
      worker.postMessage({ id, type: job.type, file: job.file });
    }).finally(() => this.busy.set(this.pending.size > 0));
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./engine.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; progress?: number; ok?: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      if (data.progress != null) return p.onProgress?.(data.progress);
      this.pending.delete(data.id);
      if (data.ok) {
        p.resolve(data.result);
        this.onRebuilt?.();
      }
      else {
        this.lastError.set(data.error ?? 'erreur inconnue');
        p.reject(new EntryError([data.error ?? 'Calcul impossible']));
      }
    };
    worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new EntryError([`Calcul impossible (${e.message})`]));
      this.pending.clear();
      this.worker = undefined;
      this.busy.set(false);
    };
    return worker;
  }
}
