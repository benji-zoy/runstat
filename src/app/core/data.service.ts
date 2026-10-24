import { Injectable, computed, inject, signal } from '@angular/core';
import { LocalService } from './local.service';
import { LOCAL_MODE } from './runtime';
import { CorosData } from './models';
import { parseDay, startOfDay } from './stats';

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly local = inject(LocalService);
  readonly data = signal<CorosData | null>(null);
  readonly error = signal<string | null>(null);
  /** Compte sans données pour l'instant (nouveau compte hébergé : réglages et sources à renseigner, puis synchro) */
  readonly empty = signal(false);

  /** Toutes les sorties, triées de la plus ancienne à la plus récente */
  readonly activities = computed(() => this.data()?.activities ?? []);
  readonly firstDay = computed(() => {
    const first = this.activities()[0];
    return first ? parseDay(first.date) : startOfDay(new Date());
  });

  /** Traces GPS encodées (polyline), chargées à la demande */
  readonly routes = signal<Record<string, string> | null>(null);
  private routesLoading = false;

  constructor() {
    this.load();
  }

  loadRoutes(): void {
    if (this.routesLoading) return;
    this.routesLoading = true;
    (LOCAL_MODE ? this.local.routes() : fetch('data/routes.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})))
      .then((r) => this.routes.set(r))
      .catch(() => this.routes.set({}));
  }

  /** Après une synchro : nouvelles données, traces GPS rechargées à la prochaine demande */
  async reload(): Promise<void> {
    await this.load();
    if (this.routes()) {
      this.routesLoading = false;
      this.loadRoutes();
    }
  }

  async load(): Promise<void> {
    if (LOCAL_MODE) {
      // Appli publique : snapshot calculé sur l'appareil ; aucun encore = compte vide (écran de bienvenue)
      try {
        const d = await this.local.snapshot();
        this.empty.set(!d);
        this.error.set(null);
        if (d) this.data.set(d);
      } catch (e) {
        this.error.set(`Stockage de l’appareil illisible (${(e as Error).message}).`);
      }
      return;
    }
    try {
      const res = await fetch('data/coros.json', { cache: 'no-cache' });
      // Servi par le NAS pour le compte de la requête : 404 = compte vide, 403 = pas de compte pour ce login
      const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
      if (res.status === 404 && json?.error) return this.empty.set(true);
      if (res.status === 403 && json?.error) return this.error.set(`Accès refusé : ${json.error}.`);
      if (!res.ok || !json) throw new Error(`HTTP ${res.status}`);
      this.empty.set(false);
      this.error.set(null);
      this.data.set(json);
    } catch (e) {
      this.error.set(`Impossible de charger data/coros.json (${(e as Error).message}). Lance « npm run data ».`);
    }
  }
}
