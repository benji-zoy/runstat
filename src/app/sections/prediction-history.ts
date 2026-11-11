import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { DistanceKey, REFERENCE_DISTANCES, sampleDates } from '../core/history';
import { HistoryService } from '../core/history.service';
import { raceDistance } from '../core/science';
import { clock } from '../core/format';
import { addDays, parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const PERIODS = [
  { key: '3m', label: '3 mois', days: 91 },
  { key: '6m', label: '6 mois', days: 182 },
  { key: '1a', label: '1 an', days: 365 },
  { key: '2a', label: '2 ans', days: 730 },
  { key: 'tout', label: 'Tout', days: null },
] as const;
type PeriodKey = (typeof PERIODS)[number]['key'];

/** Graduation d'un axe de temps : « h:mm » au-delà d'une heure, sinon « m:ss » */
export const axisClock = (sec: number) => (sec >= 3600 ? clock(sec).replace(/:\d\d$/, '') : clock(sec));

/** Pas de graduation rond (15 s … 1 h) pour 4 à 6 graduations */
export function timeStep(range: number): number {
  return [15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => range / s <= 5) ?? 3600;
}

const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Courbe du chrono estimé sur une distance de référence : consensus des modèles recalculé à chaque date avec les seules
 * données connues ce jour-là, et les courses faites sur la distance en points.
 */
@Component({
  selector: 'app-prediction-history',
  imports: [ChartComponent],
  template: `
    <div class="controls">
      <div class="chips" role="group" aria-label="Distance">
        @for (d of distances; track d.key) {
          <button type="button" class="chip" [class.active]="distance() === d.key" (click)="distance.set(d.key)">{{ d.label }}</button>
        }
      </div>
      <div class="seg" role="group" aria-label="Période">
        @for (p of periods; track p.key) {
          <button type="button" [class.active]="period() === p.key" (click)="period.set(p.key)">{{ p.label }}</button>
        }
      </div>
    </div>
    @if (loading()) {
      <p class="muted loading">Calcul des estimations passées…</p>
    } @else if (summary(); as s) {
      <p class="summary">
        <span class="display now">{{ clock(s.now) }}</span>
        <span class="muted">
          estimé aujourd'hui sur {{ label() }}
          @if (s.delta !== null) {
            · <b [class.better]="s.delta < 0" [class.worse]="s.delta > 0">{{ s.delta < 0 ? '−' : '+' }}{{ clock(Math.abs(s.delta)) }}</b> depuis le {{ s.since }}
          }
          @if (s.best; as b) {
            · meilleure estimation {{ clock(b.sec) }} le {{ b.date }}
          }
        </span>
      </p>
      <app-chart label="Évolution des chronos estimés" [config]="chart()!" style="--chart-h: 240px" />
    } @else {
      <p class="muted">Pas assez de courses ni d'efforts mesurés sur la période pour estimer un chrono.</p>
    }
  `,
  styles: `
    :host { display: grid; gap: 0.75rem; min-width: 0; }
    .controls { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; justify-content: space-between; align-items: center; }
    .seg { overflow-x: auto; }
    .seg button { padding-inline: 0.65rem; }
    .summary { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; }
    .now { font-size: 2rem; }
    .loading { margin: 0; min-height: 240px; display: grid; place-items: center; }
    .better { color: var(--good-text, var(--good)); }
    .worse { color: var(--serious); }
  `,
})
export class PredictionHistoryComponent {
  /** Distance affichée au départ (celle du prochain objectif, sinon 10 km) */
  readonly initial = input<DistanceKey | null>(null);

  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);
  private readonly hist = inject(HistoryService);
  private readonly today = inject(PeriodService).today;

  protected readonly distances = REFERENCE_DISTANCES;
  protected readonly periods = PERIODS;
  protected readonly clock = clock;
  protected readonly Math = Math;

  protected readonly distance = linkedSignal<DistanceKey>(() => this.initial() ?? '10k');
  protected readonly period = signal<PeriodKey>('1a');
  protected readonly label = computed(() => REFERENCE_DISTANCES.find((d) => d.key === this.distance())!.label);

  private readonly from = computed(() => {
    const p = PERIODS.find((x) => x.key === this.period())!;
    const first = this.store.activities()[0];
    const start = p.days === null && first ? parseDay(first.date) : addDays(this.today, -(p.days ?? 365));
    return start > this.today ? this.today : start;
  });

  /** Toutes les distances d'un coup : changer de distance ne recalcule rien ; null pendant le calcul */
  private readonly history = computed(() => this.hist.predictions(sampleDates(this.from(), this.today, 40)));
  protected readonly loading = computed(() => this.history() === null);

  private readonly series = computed(() => {
    const key = this.distance();
    return (this.history() ?? [])
      .filter((p) => p.times[key] !== undefined)
      .map((p) => ({ x: parseDay(p.date).getTime(), y: p.times[key]! }));
  });

  /** Courses officielles sur la distance pendant la période */
  private readonly races = computed(() => {
    const km = REFERENCE_DISTANCES.find((d) => d.key === this.distance())!.km;
    const types = this.sci.types();
    const from = this.from();
    return this.store.activities()
      .filter((a) => types.get(a.id) === 'race' && a.kind === 'road' && parseDay(a.date) >= from && raceDistance(a) === km * 1000)
      .map((a) => ({ x: parseDay(a.date).getTime(), y: a.result?.officialSec ?? a.durationSec, name: a.result?.event ?? a.name }));
  });

  protected readonly summary = computed(() => {
    const s = this.series();
    if (!s.length) return null;
    const now = s.at(-1)!.y;
    const best = s.reduce((b, p) => (p.y < b.y ? p : b));
    return {
      now,
      delta: s.length > 1 ? now - s[0].y : null,
      since: dayFmt.format(new Date(s[0].x)),
      best: best.y < now - 0.5 ? { sec: best.y, date: dayFmt.format(new Date(best.x)) } : null,
    };
  });

  protected readonly chart = computed<ChartConfiguration | null>(() => {
    const s = this.series();
    if (!s.length) return null;
    const races = this.races();
    const ys = [...s.map((p) => p.y), ...races.map((r) => r.y)];
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const step = timeStep(Math.max(60, (hi - lo) * 1.2));
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Chrono estimé',
            data: s,
            borderColor: C.accent,
            backgroundColor: alpha(C.accent, 0.12),
            fill: 'start',
            borderWidth: 2,
            pointRadius: s.length > 30 ? 0 : 2,
            pointHoverRadius: 4,
            tension: 0.25,
          },
          {
            type: 'scatter' as const,
            label: 'Courses',
            data: races,
            backgroundColor: C.s2,
            borderColor: C.surface,
            borderWidth: 2,
            pointRadius: 6,
            pointHoverRadius: 8,
          },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: this.from().getTime(),
            max: this.today.getTime(),
            ticks: { callback: (v) => monthFmt.format(new Date(Number(v))), maxTicksLimit: 7 },
            grid: { display: false },
          },
          y: {
            // Plus rapide en haut
            reverse: true,
            min: Math.max(0, Math.floor((lo - step / 4) / step) * step),
            max: Math.ceil((hi + step / 4) / step) * step,
            ticks: { stepSize: step, callback: (v) => axisClock(Number(v)) },
          },
        },
        plugins: {
          legend: { display: races.length > 0, position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (items) => dayFmt.format(new Date((items[0].raw as { x: number }).x)),
              label: (c) => {
                const raw = c.raw as { y: number; name?: string };
                return raw.name ? ` ${raw.name} : ${clock(raw.y)}` : ` Estimé : ${clock(raw.y)}`;
              },
            },
          },
        },
      },
    };
  });
}
