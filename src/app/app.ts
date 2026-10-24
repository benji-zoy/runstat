import { Component, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, take } from 'rxjs';
import { DataService } from './core/data.service';
import { ThemeService } from './core/theme.service';
import { SyncService } from './core/sync.service';
import { PwaService } from './core/pwa.service';
import { day } from './core/format';
import { CAPABILITIES, sourcesOf } from './core/sources';
import { levelFor } from './core/badges';
import { TABS, TAB_PARAMS } from './app.routes';
import { IconComponent } from './ui/icon';
import { AthleteFormComponent } from './ui/forms/athlete-form';
import { UsersFormComponent } from './ui/forms/users-form';
import { MeService } from './core/me.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, AthleteFormComponent, UsersFormComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly store = inject(DataService);
  protected readonly theme = inject(ThemeService);
  protected readonly sync = inject(SyncService);
  protected readonly pwa = inject(PwaService);
  protected readonly me = inject(MeService);
  protected readonly empty = this.store.empty;
  protected readonly data = this.store.data;
  protected readonly error = this.store.error;
  protected readonly tabs = TABS;
  protected readonly mobileTabs = TABS.filter((t) => !t.mobileHidden);
  protected readonly tabParams = TAB_PARAMS;

  protected readonly sourceLabel = computed(() => CAPABILITIES[sourcesOf(this.data()).activities].label);
  protected readonly updatedAt = computed(() => {
    const d = this.data();
    return d ? day(new Date(d.generatedAt)) : '';
  });

  constructor() {
    // Retour de la connexion Strava (?strava=ok|refus&raison=…) : message bref, puis paramètres retirés de l'adresse
    const router = inject(Router);
    router.events
      .pipe(filter((e) => e instanceof NavigationEnd), take(1), takeUntilDestroyed())
      .subscribe(() => {
        const q = router.routerState.snapshot.root.queryParamMap;
        const result = q.get('strava');
        if (!result) return;
        this.sync.stravaReturned(result, q.get('raison'));
        void router.navigate([], { queryParams: { strava: null, raison: null }, queryParamsHandling: 'merge', replaceUrl: true });
      });
  }

  /** Niveau façon Nike Run Club, affiché à côté du logo */
  protected readonly level = computed(() => levelFor(this.store.activities().reduce((s, a) => s + a.distanceKm, 0)).level);
}
