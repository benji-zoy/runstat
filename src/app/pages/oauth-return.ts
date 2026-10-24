import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DeviceSyncService, type DeviceSource } from '../core/device-sync.service';
import { LOCAL_MODE } from '../core/runtime';

const SOURCES: DeviceSource[] = ['coros', 'strava', 'google'];

/**
 * Retour d'une autorisation lancée depuis Réglages en local-first (/connexion/coros|strava|google?code=…&state=…) : state
 * vérifié, code échangé sur l'appareil (Google : par le relais du NAS), puis /aujourdhui?<source>=ok|refus&raison=… comme sur
 * le NAS (message, synchro). Le code est retiré de l'adresse dès la lecture.
 */
@Component({
  selector: 'app-oauth-return',
  imports: [RouterLink],
  template: `
    <section class="card back">
      <h1>Connexion</h1>
      <p role="status">{{ message() }}</p>
      @if (failed()) {
        <a class="btn" routerLink="/aujourdhui">Retour</a>
      }
    </section>
  `,
  styles: `
    .back { max-width: 560px; margin: 1.5rem auto; display: grid; gap: 0.8rem; }
    .back h1 { margin: 0; font-family: var(--font-display); font-size: 1.6rem; }
    .back p { margin: 0; }
  `,
})
export class OAuthReturnPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly device = inject(DeviceSyncService);
  protected readonly message = signal('Connexion en cours…');
  protected readonly failed = signal(false);

  async ngOnInit(): Promise<void> {
    const source = this.route.snapshot.paramMap.get('source') as DeviceSource;
    const params = new URLSearchParams(location.search);
    history.replaceState(history.state, '', location.pathname);
    if (!LOCAL_MODE || !SOURCES.includes(source)) {
      this.message.set('Adresse inconnue.');
      return this.failed.set(true);
    }
    try {
      const r = await this.device.finish(source, params);
      await this.router.navigate(['/aujourdhui'], { queryParams: { [source]: r.result, raison: r.reason ?? null }, replaceUrl: true });
    } catch (e) {
      this.message.set(`Connexion impossible : ${(e as Error).message}`);
      this.failed.set(true);
    }
  }
}
