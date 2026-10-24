import { Component, inject, input } from '@angular/core';
import { PeriodService } from '../core/period.service';
import { Granularity } from '../core/stats';

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'all', label: 'Tout' },
];

/** Sélecteur de granularité + navigation précédent / suivant, partagé par les onglets. */
@Component({
  selector: 'app-period-nav',
  template: `
    <div class="bar">
      <div class="seg" role="tablist" aria-label="Granularité">
        @for (g of grans; track g.key) {
          <button type="button" role="tab" [attr.aria-selected]="g.key === ps.gran()" [class.active]="g.key === ps.gran()"
            (click)="ps.setGran(g.key)">{{ g.label }}</button>
        }
      </div>
      <div class="nav">
        <button type="button" class="arrow" (click)="ps.prev()" [disabled]="!ps.canPrev()" aria-label="Période précédente">‹</button>
        <span class="label display">{{ ps.period().label }}</span>
        <button type="button" class="arrow" (click)="ps.next()" [disabled]="!ps.canNext()" aria-label="Période suivante">›</button>
        @if (!ps.period().current) {
          <button type="button" class="today" (click)="ps.goToday()">Aujourd'hui</button>
        }
      </div>
      <ng-content />
    </div>
    @if (hint()) {
      <p class="hint muted">{{ hint() }}</p>
    }
  `,
  styles: `
    :host { display: block; margin-top: 1.25rem; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1.25rem; }
    .nav { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
    .label { font-size: 1.5rem; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .arrow {
      flex: none; width: 2.5rem; height: 2.5rem; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface-1); color: var(--text-primary); font-size: 1.4rem; line-height: 1; cursor: pointer;
    }
    .arrow:hover:not(:disabled) { background: var(--surface-2); }
    .arrow:disabled { opacity: 0.3; cursor: default; }
    .today {
      font: 600 0.8rem var(--font-body); color: var(--accent); background: var(--accent-soft); border: 0;
      border-radius: 8px; padding: 0.45rem 0.8rem; min-height: 36px; cursor: pointer;
    }
    .hint { margin: 0.4rem 0 0; font-size: 0.82rem; }
    @media (max-width: 600px) {
      .bar { gap: 0.5rem 0.75rem; }
      .seg { flex: 1 1 100%; }
      .seg button { flex: 1; padding-inline: 0.4rem; }
      .label { font-size: 1.3rem; flex: 1; text-align: center; }
      .nav { flex: 1 1 100%; }
    }
  `,
})
export class PeriodNavComponent {
  protected readonly ps = inject(PeriodService);
  protected readonly grans = GRANS;
  readonly hint = input<string>('');
}
