import { Injectable, computed, signal } from '@angular/core';
import { CorosData } from './models';
import { parseDay, startOfDay } from './stats';

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly data = signal<CorosData | null>(null);
  readonly error = signal<string | null>(null);

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
    fetch('data/routes.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : {}))
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
    try {
      const res = await fetch('data/coros.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data.set(await res.json());
    } catch (e) {
      this.error.set(`Impossible de charger data/coros.json (${(e as Error).message}). Lance « npm run data ».`);
    }
  }
}
