import { Injectable, computed, inject, signal } from '@angular/core';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';
import { LOCAL_MODE } from './runtime';
import { DataService } from './data.service';
import { SyncService } from './sync.service';
import { Activity, ActivitySource, Athlete, CorosData, Goal, HealthSource, RaceResult } from './models';

export { EntryError } from './entry-error';

/**
 * Saisie depuis le site (objectifs, bilans, classements, réglages, sources) : écrit dans data-raw/ sur le NAS
 * (scripts/sync/server.mjs → entries.mjs), affiche tout de suite le changement puis recharge après la reconstruction.
 * Appli publique (local-first) : écrit dans IndexedDB (core/local.service.ts) avec les mêmes règles, puis recalcule sur l'appareil.
 * Sans service de synchro ni mode local (ng serve), `available` reste faux et les boutons de saisie sont masqués.
 */
@Injectable({ providedIn: 'root' })
export class EntriesService {
  private readonly store = inject(DataService);
  private readonly sync = inject(SyncService);
  private readonly local = inject(LocalService);
  /** Peut saisir : NAS joignable, ou mode local-first */
  readonly available = computed(() => LOCAL_MODE || this.sync.available());
  readonly saving = signal(false);
  /** Envoi de l'archive Strava : part envoyée (0 à 1), null hors envoi */
  readonly uploading = signal<number | null>(null);

  /** Remplace toute la liste des objectifs (ajout, modification, suppression, bilan) */
  async saveGoals(goals: Goal[]): Promise<void> {
    const body = goals.map(({ forecast, ...g }) => g);
    const saved = (await this.send('PUT', 'goals', body)).saved as Goal[];
    this.patch((d) => {
      // La prévision météo est recalculée par la reconstruction ; gardée en attendant si le départ n'a pas bougé
      const old = new Map((d.goals ?? []).map((g) => [g.id, g]));
      const goals = saved.map((g) => {
        const o = old.get(g.id);
        return o?.forecast && o.date === g.date && o.startTime === g.startTime ? { ...g, forecast: o.forecast } : g;
      });
      return { ...d, goals };
    });
  }

  async saveAthlete(athlete: Athlete): Promise<void> {
    const saved = (await this.send('PUT', 'athlete', athlete)).saved as Athlete;
    this.patch((d) => ({ ...d, athlete: saved }));
  }

  /** Sources de l'instance ; la reconstruction complète (quelques minutes) suit, puis le rechargement */
  async saveSources(sources: { activities: ActivitySource; health: HealthSource }): Promise<void> {
    const saved = (await this.send('PUT', 'sources', sources)).saved as CorosData['sources'];
    this.patch((d) => ({ ...d, sources: saved }));
  }

  /**
   * Archive Strava (zip de l'export du compte) envoyée au NAS, qui l'importe puis reconstruit les données.
   * XMLHttpRequest plutôt que fetch : seule façon de suivre la progression d'un envoi.
   */
  async uploadStravaArchive(file: File): Promise<void> {
    this.uploading.set(0);
    try {
      if (LOCAL_MODE) {
        // Sur l'appareil : lue par morceaux, jamais envoyée ; progression de l'import des tracés
        await this.local.importArchive(file, (p) => this.uploading.set(p));
        await this.store.reload();
        return;
      }
      const { status, body } = await new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'api/strava/archive');
        xhr.setRequestHeader('X-RunStat', 'sync');
        xhr.setRequestHeader('Content-Type', 'application/zip');
        xhr.upload.onprogress = (e) => e.lengthComputable && this.uploading.set(e.loaded / e.total);
        xhr.onload = () => {
          let json = {};
          try {
            json = JSON.parse(xhr.responseText);
          } catch {}
          resolve({ status: xhr.status, body: json });
        };
        xhr.onerror = () => reject(new EntryError(['Service de synchro injoignable']));
        xhr.send(file);
      });
      if (status === 413) throw new EntryError(['Archive trop volumineuse (2 Go au plus)']);
      if (status < 200 || status >= 300) throw new EntryError([body.error ?? `HTTP ${status}`]);
      void this.sync.followImport();
    } finally {
      this.uploading.set(null);
    }
  }

  /** Appli Strava de l'athlète, écrite dans secrets/ du NAS : le secret n'est jamais relu par le site */
  async saveStravaClient(clientId: string, clientSecret: string): Promise<void> {
    if (LOCAL_MODE) throw new EntryError(['La synchro Strava depuis l’appareil arrive bientôt : importe ton archive en attendant']);
    await this.send('PUT', 'strava/client', { client_id: clientId, client_secret: clientSecret });
  }

  /** Classement officiel d'une course ; remplace l'éventuel fichier rattaché par la date */
  async saveResult(activityId: string, result: Omit<RaceResult, 'file'>, replaces?: string): Promise<void> {
    const { activityId: _, ...saved } = (await this.send('PUT', `results/${activityId}${query(replaces)}`, result)).saved as RaceResult & { activityId: string };
    this.patchActivity(activityId, (a) => ({ ...a, result: saved }));
  }

  async deleteResult(activityId: string, replaces?: string): Promise<void> {
    await this.send('DELETE', `results/${activityId}${query(replaces)}`);
    this.patchActivity(activityId, ({ result, ...a }) => a);
  }

  private async send(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ saved: unknown }> {
    this.saving.set(true);
    try {
      if (LOCAL_MODE) {
        const out = await this.local.apply(method, path, body);
        // Recalcul sur l'appareil (zones FC, prévision météo…) puis rechargement, sans bloquer le formulaire
        void this.local.rebuild().then(() => this.store.reload(), () => undefined);
        return out;
      }
      let res: Response;
      try {
        res = await fetch(`api/${path}`, {
          method,
          headers: { 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new EntryError(['Service de synchro injoignable']);
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new EntryError(json.errors ?? [json.error ?? `HTTP ${res.status}`]);
      // Reconstruction en arrière-plan (prévision météo, zones FC…) : suivie sans bloquer le formulaire
      void this.sync.follow();
      return json;
    } finally {
      this.saving.set(false);
    }
  }

  private patch(fn: (d: CorosData) => CorosData): void {
    const d = this.store.data();
    if (d) this.store.data.set(fn(d));
  }

  private patchActivity(id: string, fn: (a: Activity) => Activity): void {
    this.patch((d) => ({ ...d, activities: d.activities.map((a) => (a.id === id ? fn(a) : a)) }));
  }
}

const query = (replaces?: string) => (replaces ? `?replaces=${encodeURIComponent(replaces)}` : '');
