import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { MeService } from '../core/me.service';
import { EntriesService } from '../core/entries.service';
import { AccountService } from '../core/account.service';
import { ThemeService } from '../core/theme.service';
import { SyncService } from '../core/sync.service';
import { ShellService } from '../core/shell.service';
import { LOCAL_MODE } from '../core/runtime';
import { CAPABILITIES, sourcesOf } from '../core/sources';
import { levelFor } from '../core/badges';
import { day, km, num } from '../core/format';
import { IconComponent } from '../ui/icon';

/** Moi : profil (niveau, distance), amis, souvenirs et tous les réglages, rangés derrière l'avatar de l'en-tête. */
@Component({
  selector: 'app-me',
  imports: [RouterLink, IconComponent],
  template: `
    <header class="profile">
      <span class="avatar" aria-hidden="true">{{ initial() }}</span>
      <div>
        <h1>{{ name() }}</h1>
        <p class="lede">{{ lede() }}</p>
      </div>
    </header>

    @if (total(); as t) {
      <div class="stats">
        <a class="card stat" routerLink="/souvenirs" [queryParams]="{ section: 'badges' }">
          <span class="v level"><i [style.background]="level().level.color"></i>{{ level().level.name }}</span>
          <span class="muted">niveau{{ level().next ? ' · ' + km(level().next!.min - t) + ' avant ' + level().next!.name : '' }}</span>
        </a>
        <div class="card stat"><span class="v">{{ num(yearKm()) }}</span><span class="muted">km en {{ year }}</span></div>
        <div class="card stat"><span class="v">{{ num(t) }}</span><span class="muted">km depuis le début</span></div>
      </div>
    }

    <section class="section">
      <h2>Amis</h2>
      <div class="card soon">
        <app-icon name="users" />
        <div>
          <b>Bientôt : compare-toi à tes amis</b>
          <p class="muted">
            Invite-les par lien ou QR code, puis comparez vos chronos à âge égal, vos volumes et vos profils.
            Tu choisis ce que chaque ami voit ; ta santé, tes tracés et tes horaires ne sont jamais partagés.
          </p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Souvenirs</h2>
      <a class="card row-link" routerLink="/souvenirs">
        <app-icon name="star" />
        <span><b>Récap, badges, jalons, équivalences</b><small class="muted">Ton année en images et tes distances en voyages</small></span>
        <app-icon name="arrow" />
      </a>
    </section>

    <section class="section">
      <h2>Réglages</h2>
      <div class="card list">
        @if (entries.available()) {
          <button type="button" class="row" (click)="shell.open('athlete')">
            <app-icon name="settings" />
            <span><b>Athlète et sources</b><small class="muted">FC, seuils, morphologie · {{ sourceLabel() }}</small></span>
            <app-icon name="arrow" />
          </button>
        }
        @if (local) {
          <button type="button" class="row" [class.warn]="!!account.lastError()" (click)="shell.open('account')">
            <app-icon name="cloud" />
            <span>
              <b>Compte et sauvegarde</b>
              <small class="muted">{{ account.lastError() ?? (account.connected() ? 'Sauvegarde chiffrée active' : 'Aucune sauvegarde : tes données ne sont que sur cet appareil') }}</small>
            </span>
            <app-icon name="arrow" />
          </button>
        }
        @if (me.admin()) {
          <button type="button" class="row" (click)="shell.open('users')">
            <app-icon name="users" />
            <span><b>Proches</b><small class="muted">Comptes hébergés sur ce serveur et invitations</small></span>
            <app-icon name="arrow" />
          </button>
        }
        <button type="button" class="row" (click)="theme.toggle()" [attr.aria-pressed]="theme.theme() === 'light'">
          <app-icon [name]="theme.theme() === 'dark' ? 'moon' : 'sun'" />
          <span><b>Apparence</b><small class="muted">Thème {{ theme.theme() === 'dark' ? 'sombre' : 'clair' }} · touche pour passer au {{ theme.theme() === 'dark' ? 'clair' : 'sombre' }}</small></span>
          <span class="switch" [class.on]="theme.theme() === 'light'" aria-hidden="true"><i></i></span>
        </button>
        <a class="row" routerLink="/confidentialite">
          <app-icon name="shield" />
          <span><b>Confidentialité et mes données</b><small class="muted">Ce qui va où, export, suppression</small></span>
          <app-icon name="arrow" />
        </a>
      </div>
      @if (updatedAt()) {
        <p class="muted small">Données {{ sourceLabel() }} du {{ updatedAt() }}@if (sync.available()) { · {{ sync.title() }}}</p>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .profile { display: flex; align-items: center; gap: 1rem; margin-top: 1.75rem; }
    .profile .avatar {
      flex: none; display: grid; place-items: center; width: 4rem; height: 4rem; border-radius: 50%;
      background: var(--accent-fill); color: var(--on-accent);
      font: 800 1.9rem var(--font-display); font-stretch: var(--display-stretch);
    }
    .profile h1 { text-transform: none; }
    .lede { margin: 0.3rem 0 0; color: var(--text-muted); font-size: 0.9rem; }
    .stats { display: grid; gap: 0.75rem; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 1.5rem; }
    .stat { display: grid; gap: 0.15rem; color: inherit; text-decoration: none; }
    a.stat:hover { border-color: var(--accent); }
    .stat .v { font: 600 1.45rem var(--font-mono); }
    .stat .level { display: flex; align-items: center; gap: 0.5rem; font: 800 1.6rem var(--font-display); font-stretch: var(--display-stretch); }
    .stat .level i { width: 0.8rem; height: 0.8rem; border-radius: 50%; box-shadow: 0 0 0 2px var(--border); }
    .stat .muted { font-size: 0.8rem; }
    .soon { display: flex; gap: 0.9rem; align-items: flex-start; --icon: 1.4rem; color: var(--text-secondary); }
    .soon b { color: var(--text-primary); }
    .soon p { margin: 0.3rem 0 0; font-size: 0.88rem; }
    .row-link, .row {
      display: flex; align-items: center; gap: 0.9rem; width: 100%; min-height: 3.5rem; color: var(--text-primary);
      text-decoration: none; text-align: left; font: inherit; --icon: 1.2rem;
    }
    .row-link > span, .row > span:not(.switch) { flex: 1; display: grid; gap: 0.1rem; min-width: 0; }
    .row-link small, .row small { font-size: 0.8rem; }
    .row-link:hover { border-color: var(--accent); }
    .list { display: grid; padding: 0.25rem 1.25rem; }
    .row { padding: 0.5rem 0; border: none; border-bottom: 1px solid var(--border); background: none; cursor: pointer; }
    .row:last-child { border-bottom: none; }
    .row > app-icon:first-child { color: var(--text-muted); }
    .row:hover b { color: var(--accent-text); }
    .row.warn small { color: var(--critical-text); }
    .switch { flex: none; width: 2.6rem; height: 1.5rem; border-radius: 1rem; background: var(--surface-3); position: relative; transition: background 0.15s; }
    .switch i { position: absolute; top: 0.2rem; left: 0.2rem; width: 1.1rem; height: 1.1rem; border-radius: 50%; background: var(--text-primary); transition: transform 0.15s; }
    .switch.on { background: var(--accent-fill); }
    .switch.on i { transform: translateX(1.1rem); background: var(--on-accent); }
    .small { font-size: 0.8rem; margin: 0.6rem 0 0; }
    @media (max-width: 600px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats .stat:first-child { grid-column: 1 / -1; }
      .list { padding: 0.25rem 1rem; }
    }
  `,
})
export class MePage {
  private readonly store = inject(DataService);
  private readonly today = inject(PeriodService).today;
  protected readonly me = inject(MeService);
  protected readonly entries = inject(EntriesService);
  protected readonly account = inject(AccountService);
  protected readonly theme = inject(ThemeService);
  protected readonly sync = inject(SyncService);
  protected readonly shell = inject(ShellService);
  protected readonly local = LOCAL_MODE;
  protected readonly num = num;
  protected readonly km = km;
  protected readonly year = this.today.getFullYear();

  protected readonly name = computed(() => this.me.me()?.name?.trim() || 'Moi');
  protected readonly initial = computed(() => (this.me.me()?.name?.trim()[0] ?? 'M').toUpperCase());
  protected readonly total = computed(() => this.store.activities().reduce((s, a) => s + a.distanceKm, 0));
  protected readonly yearKm = computed(() =>
    this.store.activities().filter((a) => a.date.startsWith(String(this.year))).reduce((s, a) => s + a.distanceKm, 0),
  );
  protected readonly level = computed(() => levelFor(this.total()));
  protected readonly lede = computed(() => {
    const n = this.store.activities().length;
    return n ? `${num(n)} sortie${n > 1 ? 's' : ''} depuis le ${day(new Date(this.store.activities()[0].date + 'T00:00:00'))}` : 'Profil, amis, souvenirs et réglages';
  });
  protected readonly sourceLabel = computed(() => CAPABILITIES[sourcesOf(this.store.data()).activities].label);
  protected readonly updatedAt = computed(() => {
    const d = this.store.data();
    return d ? day(new Date(d.generatedAt)) : '';
  });
}
