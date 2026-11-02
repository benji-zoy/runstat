import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { DataService } from '../core/data.service';
import { parseDay } from '../core/stats';
import { clock, num, pace } from '../core/format';
import { ActivityDetailComponent } from '../ui/activity-detail';
import { IconComponent } from '../ui/icon';

const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Fiche d'une sortie, avec sa propre adresse : liens depuis Aujourd'hui, le journal, les records */
@Component({
  selector: 'app-run',
  imports: [ActivityDetailComponent, IconComponent, RouterLink],
  template: `
    <button type="button" class="back" (click)="back()"><app-icon name="back" />Retour</button>
    @if (activity(); as a) {
      <header class="page-head">
        <h1>{{ a.name || 'Sortie' }}</h1>
        <p class="lede">{{ when() }}</p>
      </header>
      <div class="figures">
        <div><span class="v">{{ num(a.distanceKm, 1) }}</span><span class="muted">km</span></div>
        <div><span class="v">{{ clock(a.durationSec) }}</span><span class="muted">durée</span></div>
        <div><span class="v">{{ pace(a.durationSec / a.distanceKm) }}</span><span class="muted">min/km</span></div>
        @if (a.avgHr) {
          <div><span class="v">{{ a.avgHr }}</span><span class="muted">FC moy.</span></div>
        }
      </div>
      <div class="card detail">
        <app-activity-detail [activity]="a" />
      </div>
    } @else {
      <div class="card missing">
        <p>Cette sortie n'existe pas (ou plus) dans tes données.</p>
        <a class="btn" routerLink="/journal">Ouvrir le journal</a>
      </div>
    }
  `,
  styles: `
    :host { display: grid; gap: 1.25rem; }
    .back {
      justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; min-height: 44px; margin: 1rem 0 -1rem;
      padding: 0 0.4rem 0 0; border: none; background: none; color: var(--accent-text); font: 600 0.95rem var(--font-body); cursor: pointer;
    }
    .figures { display: flex; flex-wrap: wrap; gap: 1.5rem 2.25rem; }
    .figures div { display: grid; }
    .figures .v { font: 600 1.5rem var(--font-mono); }
    .figures .muted { font-size: 0.8rem; }
    .missing { display: grid; gap: 0.75rem; justify-items: start; }
  `,
})
export class RunPage {
  private readonly store = inject(DataService);
  private readonly location = inject(Location);
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);
  protected readonly num = num;
  protected readonly clock = clock;
  protected readonly pace = pace;

  protected readonly activity = computed(() => {
    const id = this.params()?.get('id');
    return this.store.activities().find((a) => a.id === id) ?? null;
  });
  protected readonly when = computed(() => {
    const a = this.activity();
    if (!a) return '';
    const d = longDate.format(parseDay(a.date));
    const time = a.start ? new Date(a.start * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
    return d.charAt(0).toUpperCase() + d.slice(1) + (time ? ` · ${time}` : '');
  });

  protected back(): void {
    this.location.back();
  }
}
