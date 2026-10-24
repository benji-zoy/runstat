import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, take } from 'rxjs';
import { DataService } from './core/data.service';
import { ThemeService } from './core/theme.service';
import { CONNECT_SOURCES, SyncService } from './core/sync.service';
import { PwaService } from './core/pwa.service';
import { day } from './core/format';
import { CAPABILITIES, sourcesOf } from './core/sources';
import { levelFor } from './core/badges';
import { TABS, TAB_PARAMS } from './app.routes';
import { IconComponent } from './ui/icon';
import { AthleteFormComponent } from './ui/forms/athlete-form';
import { UsersFormComponent } from './ui/forms/users-form';
import { MeService } from './core/me.service';
import { EntriesService } from './core/entries.service';
import { LocalService } from './core/local.service';
import { LOCAL_MODE } from './core/runtime';

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
  protected readonly entries = inject(EntriesService);
  protected readonly localService = inject(LocalService);
  /** Appli publique (local-first) : données sur l'appareil */
  protected readonly local = LOCAL_MODE;
  /** iPhone / iPad hors appli installée : Safari efface les données d'un site après 7 jours sans visite */
  protected readonly iosHint = signal(LOCAL_MODE && iosBrowser() && !dismissed('runstat-ios-hint'));
  protected hideIosHint(): void {
    this.iosHint.set(false);
    try {
      localStorage.setItem('runstat-ios-hint', '1');
    } catch {}
  }
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
    // Retour d'une connexion (?strava|coros|google=ok|refus&raison=…) : message bref, puis paramètres retirés de l'adresse
    const router = inject(Router);
    router.events
      .pipe(filter((e) => e instanceof NavigationEnd), take(1), takeUntilDestroyed())
      .subscribe(() => {
        const q = router.routerState.snapshot.root.queryParamMap;
        const source = CONNECT_SOURCES.find((s) => q.get(s));
        if (!source) return;
        this.sync.connectionReturned(source, q.get(source)!, q.get('raison'));
        void router.navigate([], { queryParams: { [source]: null, raison: null }, queryParamsHandling: 'merge', replaceUrl: true });
      });
  }

  /** Niveau façon Nike Run Club, affiché à côté du logo */
  protected readonly level = computed(() => levelFor(this.store.activities().reduce((s, a) => s + a.distanceKm, 0)).level);
}

function iosBrowser(): boolean {
  const standalone = matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone;
}

function dismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
