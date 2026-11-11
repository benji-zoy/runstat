import { Component, computed, inject, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { GoalEvaluation } from '../core/goals';
import { HistoryService } from '../core/history.service';
import { clock } from '../core/format';
import { indexTrend } from '../core/freshness';
import { parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { axisClock, timeStep } from './prediction-history';
import { C, alpha } from '../ui/palette';

const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Évolution de l'indice de confiance d'un objectif : l'évaluation rejouée chaque semaine avec les données connues ce
 * jour-là (6 mois au plus avant la course), et le chrono probable sur un second axe.
 */
@Component({
  selector: 'app-confidence-history',
  imports: [ChartComponent],
  template: `
    @if (loading()) {
      <p class="muted loading">Calcul de l'indice semaine après semaine…</p>
    } @else if (points().length > 1) {
      <p class="summary">
        @if (trend(); as t) {
          <b [class.up]="t.diff > 0" [class.down]="t.diff < 0">{{ t.diff > 0 ? '+' : t.diff < 0 ? '−' : '±' }}{{ Math.abs(t.diff) }} pts</b>
          en {{ t.weeks }} semaines (de {{ t.from }} à {{ t.to }}{{ ev().probability !== null ? ' %' : '/100' }}) ;
        }
        depuis le {{ day(points()[0].date) }}, de {{ Math.round(points()[0].index) }} à {{ Math.round(points().at(-1)!.index) }}{{ ev().probability !== null ? ' %' : '/100' }}
        · chrono probable {{ clock(points()[0].predicted) }} → <b>{{ clock(points().at(-1)!.predicted) }}</b>
      </p>
      <app-chart [config]="chart()" style="--chart-h: 240px" />
      <p class="muted small">Chaque point recalcule l'indice avec les seules sorties connues ce jour-là (sans la prédiction de la montre, qui n'est
        qu'un instantané du jour) : les hausses viennent de l'entraînement, des courses et de la fraîcheur à l'approche du jour J.</p>
    } @else {
      <p class="muted">Pas encore assez d'historique pour tracer l'évolution.</p>
    }
  `,
  styles: `
    :host { display: grid; gap: 0.6rem; min-width: 0; }
    .summary { margin: 0; color: var(--text-secondary); }
    .summary b { color: var(--text-primary); }
    .summary .up { color: var(--good-text, var(--good)); }
    .summary .down { color: var(--serious); }
    .small { margin: 0; font-size: 0.82rem; }
    .loading { margin: 0; min-height: 240px; display: grid; place-items: center; }
  `,
})
export class ConfidenceHistoryComponent {
  readonly ev = input.required<GoalEvaluation>();

  private readonly hist = inject(HistoryService);
  protected readonly clock = clock;
  protected readonly Math = Math;
  protected day = (iso: string) => dayFmt.format(parseDay(iso));

  /** null pendant le calcul */
  private readonly history = computed(() => this.hist.confidence(this.ev()));
  protected readonly loading = computed(() => this.history() === null);
  protected readonly points = computed(() => this.history() ?? []);

  /** Écart sur les 4 dernières semaines */
  protected readonly trend = computed(() => indexTrend(this.points().map((x) => x.index), 4));

  protected readonly chart = computed<ChartConfiguration>(() => {
    const e = this.ev();
    const p = this.points();
    const xs = p.map((x) => parseDay(x.date).getTime());
    const times = p.map((x) => x.predicted);
    const target = e.goal.targetSec ?? null;
    const lo = Math.min(...times, ...(target ? [target] : [])), hi = Math.max(...times, ...(target ? [target] : []));
    const step = timeStep(Math.max(60, (hi - lo) * 1.3));
    const chance = e.probability !== null;
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: chance ? 'Indice de confiance (%)' : 'Préparation (/100)',
            data: p.map((x, i) => ({ x: xs[i], y: x.index, daysLeft: x.daysLeft })),
            borderColor: C.accent,
            backgroundColor: alpha(C.accent, 0.15),
            fill: 'origin',
            borderWidth: 2.5,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            tension: 0.25,
          },
          {
            label: 'Chrono probable',
            yAxisID: 'y1',
            data: p.map((x, i) => ({ x: xs[i], y: x.predicted, daysLeft: x.daysLeft })),
            borderColor: C.s1,
            borderDash: [5, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
          },
          ...(target
            ? [{
                label: 'Objectif',
                yAxisID: 'y1',
                data: [{ x: xs[0], y: target }, { x: xs.at(-1)!, y: target }],
                borderColor: C.muted,
                borderDash: [2, 3],
                borderWidth: 1,
                pointRadius: 0,
                pointHoverRadius: 0,
              }]
            : []),
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: xs[0],
            max: xs.at(-1),
            ticks: { callback: (v) => dayFmt.format(new Date(Number(v))), maxTicksLimit: 7 },
            grid: { display: false },
          },
          y: { min: 0, max: 100, ticks: { stepSize: 25 } },
          // Plus rapide en haut, comme l'indice
          y1: {
            position: 'right',
            reverse: true,
            min: Math.max(0, Math.floor(lo / step) * step),
            max: Math.ceil(hi / step) * step,
            grid: { display: false },
            ticks: { stepSize: step, callback: (v) => axisClock(Number(v)) },
          },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            filter: (i) => i.dataset.label !== 'Objectif',
            callbacks: {
              title: (items) => {
                const raw = items[0].raw as { x: number; daysLeft: number };
                return `${dayFmt.format(new Date(raw.x))} · ${'J-' + raw.daysLeft}`;
              },
              label: (c) => c.dataset.yAxisID === 'y1'
                ? ` Chrono probable : ${clock((c.raw as { y: number }).y)}`
                : ` ${chance ? 'Indice' : 'Préparation'} : ${(c.raw as { y: number }).y}${chance ? ' %' : '/100'}`,
            },
          },
        },
      },
    };
  });
}
