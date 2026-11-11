import { Component, DestroyRef, ViewContainerRef, Type, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { DataService } from './core/data.service';
import { ThemeService } from './core/theme.service';
import { CONNECT_SOURCES, SyncService } from './core/sync.service';
import { PwaService } from './core/pwa.service';
import { day } from './core/format';
import { CAPABILITIES, sourcesOf } from './core/sources';
import { levelFor } from './core/badges';
import { TABS, TAB_PARAMS } from './app.routes';
import { IconComponent } from './ui/icon';
import { AccountService } from './core/account.service';
import { MeService } from './core/me.service';
import { EntriesService } from './core/entries.service';
import { LocalService } from './core/local.service';
import { LOCAL_MODE } from './core/runtime';
import { ShellForm, ShellService } from './core/shell.service';
import { km } from './core/format';
import { installSlidingIndicators } from './ui/motion';

const FORM_LOADERS: Record<ShellForm, () => Promise<Type<{ open(): unknown }>>> = {
  athlete: () => import('./ui/forms/athlete-form').then((m) => m.AthleteFormComponent),
  users: () => import('./ui/forms/users-form').then((m) => m.UsersFormComponent),
  account: () => import('./ui/forms/account-form').then((m) => m.AccountFormComponent),
};

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
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
  protected readonly account = inject(AccountService);
  /** Appli publique (local-first) : données sur l'appareil */
  protected readonly local = LOCAL_MODE;
  /** Pages sans données (arrivée, connexion) : affichées même quand le compte est vide */
  protected readonly standalone = signal(false);
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
  protected readonly tabParams = TAB_PARAMS;

  protected readonly sourceLabel = computed(() => CAPABILITIES[sourcesOf(this.data()).activities].label);
  protected readonly updatedAt = computed(() => {
    const d = this.data();
    return d ? day(new Date(d.generatedAt)) : '';
  });

  /** Synchro terminée sans problème : la rotation laisse place à une coche qui se dessine */
  protected readonly synced = signal(false);

  constructor() {
    installSlidingIndicators(inject(DestroyRef));
    let wasRunning = false;
    let syncedTimer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const running = this.sync.running();
      if (wasRunning && !running && !untracked(this.sync.problems).length) {
        this.synced.set(true);
        clearTimeout(syncedTimer);
        syncedTimer = setTimeout(() => this.synced.set(false), 1800);
      }
      wasRunning = running;
    });

    // Les pages (Moi) ouvrent les fenêtres de saisie posées une seule fois ici
    const shell = inject(ShellService);
    shell.register('athlete', () => void this.openForm('athlete'));
    shell.register('users', () => void this.openForm('users'));
    shell.register('account', () => void this.openForm('account'));

    // Retour d'une connexion (?strava|coros|google=ok|refus&raison=…) : message bref, puis paramètres retirés de l'adresse
    const router = inject(Router);
    router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe((e) => this.standalone.set(/^\/(rejoindre|connexion|confidentialite)\b/.test((e as NavigationEnd).urlAfterRedirects)));
    router.events
      // À chaque navigation : le retour d'une connexion faite sur l'appareil arrive après /connexion/<source>
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => {
        const q = router.routerState.snapshot.root.queryParamMap;
        const source = CONNECT_SOURCES.find((s) => q.get(s));
        if (!source) return;
        this.sync.connectionReturned(source, q.get(source)!, q.get('raison'));
        void router.navigate([], { queryParams: { [source]: null, raison: null }, queryParamsHandling: 'merge', replaceUrl: true });
      });
  }

  private readonly formHost = viewChild.required('formHost', { read: ViewContainerRef });
  private readonly forms = new Map<ShellForm, Promise<{ open(): unknown }>>();

  /** Fenêtres de saisie chargées à la première ouverture : elles restent hors du bundle initial */
  protected openForm(name: ShellForm): Promise<unknown> {
    let form = this.forms.get(name);
    if (!form) {
      form = FORM_LOADERS[name]().then((type) => {
        const ref = this.formHost().createComponent(type);
        ref.changeDetectorRef.detectChanges();
        return ref.instance;
      });
      this.forms.set(name, form);
      form.catch(() => this.forms.delete(name));
    }
    return form.then((f) => f.open());
  }

  /** Prénom connu : compte du NAS, sinon athlète Strava connecté ; sans lui, « Moi » */
  protected readonly firstName = computed(() => this.me.me()?.name?.trim() || this.sync.athleteName() || '');
  protected readonly initial = computed(() => (this.firstName()[0] ?? 'M').toUpperCase());
  /** Sous le nom (barre latérale) : niveau façon Nike Run Club et distance cumulée */
  protected readonly meLine = computed(() => {
    const total = this.store.activities().reduce((s, a) => s + a.distanceKm, 0);
    return total ? `Niveau ${levelFor(total).level.name} · ${km(total)}` : 'Profil et réglages';
  });
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
