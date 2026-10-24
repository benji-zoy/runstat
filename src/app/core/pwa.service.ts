import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/**
 * Appli installable (service worker, ngsw-config.json) : nouvelle version prête à charger, et connexion perdue
 * (les données affichées sont alors le dernier instantané mis en cache).
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private readonly sw = inject(SwUpdate);
  readonly updateReady = signal(false);
  readonly online = signal(navigator.onLine);

  constructor() {
    addEventListener('online', () => this.online.set(true));
    addEventListener('offline', () => this.online.set(false));
    if (!this.sw.isEnabled) return;
    this.sw.versionUpdates.subscribe((e) => {
      if (e.type === 'VERSION_READY') this.updateReady.set(true);
    });
    // Cache incohérent (version supprimée du serveur) : seule issue, recharger
    this.sw.unrecoverable.subscribe(() => location.reload());
    // Appli rouverte depuis l'écran d'accueil : chercher une nouvelle version
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sw.checkForUpdate().catch(() => undefined);
    });
  }

  reload(): void {
    location.reload();
  }
}
