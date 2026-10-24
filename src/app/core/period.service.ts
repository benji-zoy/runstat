import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { DataService } from './data.service';
import { Granularity, addDays, isoDay, parseDay, periodFor, periodStart, shiftPeriod, startOfDay } from './stats';

const GRAN_PARAM: Record<Granularity, string> = { week: 'semaine', month: 'mois', year: 'annee', all: 'tout' };
const PARAM_GRAN = Object.fromEntries(Object.entries(GRAN_PARAM).map(([k, v]) => [v, k])) as Record<string, Granularity>;

/**
 * Période sélectionnée (granularité + date), partagée par tous les onglets.
 * La source de vérité est l'URL (?vue=mois&date=2026-10-01) : le bouton retour et les liens fonctionnent.
 */
@Injectable({ providedIn: 'root' })
export class PeriodService {
  private readonly router = inject(Router);
  private readonly store = inject(DataService);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);

  readonly today = startOfDay(new Date());

  readonly gran = computed<Granularity>(() => PARAM_GRAN[this.params()?.get('vue') ?? ''] ?? 'year');

  readonly anchor = computed(() => {
    const raw = this.params()?.get('date');
    const d = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDay(raw) : this.today;
    return d > this.today ? this.today : d;
  });

  readonly period = computed(() => periodFor(this.gran(), this.anchor(), this.today, this.store.firstDay()));

  readonly canPrev = computed(() => {
    const p = this.period();
    return p.gran !== 'all' && p.start > periodStart(p.gran, this.store.firstDay());
  });

  readonly canNext = computed(() => this.period().gran !== 'all' && !this.period().current);

  setGran(gran: Granularity): void {
    // On garde la date affichée : passer de « mars 2025 » à « Année » montre 2025.
    const p = this.period();
    const anchor = p.current || p.gran === 'all' ? this.today : p.start;
    this.go(gran, anchor);
  }

  prev(): void {
    if (this.canPrev()) this.go(this.gran(), shiftPeriod(this.gran(), this.period().start, -1));
  }

  next(): void {
    if (this.canNext()) this.go(this.gran(), shiftPeriod(this.gran(), this.period().start, 1));
  }

  goToday(): void {
    this.go(this.gran() === 'all' ? 'year' : this.gran(), this.today);
  }

  go(gran: Granularity, date: Date): void {
    const start = gran === 'all' ? null : periodStart(gran, date);
    const isCurrent = start !== null && addDays(shiftPeriod(gran, start, 1), -1) >= this.today;
    this.router.navigate([this.router.url.split('?')[0]], {
      queryParams: { vue: GRAN_PARAM[gran], date: start && !isCurrent ? isoDay(start) : null },
      queryParamsHandling: 'merge',
    });
  }
}
