import { Component, computed, inject, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { inRange } from '../core/stats';
import { WEEKDAYS, daytimeStats, histogram, paceOf, punchcard, runnerProfile, weekdayStats } from '../core/insights';
import { km, num, pace } from '../core/format';
import { PeriodNavComponent } from '../ui/period-nav';
import { ChartComponent } from '../ui/chart';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { C } from '../ui/palette';

const DIST_EDGES = [0, 5, 8, 10, 12, 15, 18, 21, 25, 30, 42];
const PACE_EDGES = Array.from({ length: 15 }, (_, i) => 240 + i * 15); // 4:00 → 7:30 par pas de 15 s

const bar = (color: string = C.s1) => ({
  backgroundColor: color,
  borderRadius: { topLeft: 4, topRight: 4 },
  borderSkipped: 'bottom' as const,
  categoryPercentage: 0.85,
  barPercentage: 0.9,
});

@Component({
  selector: 'app-habits',
  imports: [PeriodNavComponent, ChartComponent, SubTabsComponent],
  template: `
    @if (compact()) {
      <p class="verdict">{{ acts().length ? profile().title : 'Pas encore de sortie sur la période.' }}</p>
      @if (acts().length) {
        <app-chart [config]="weekdayChart()" [mini]="true" />
      }
    } @else {
    <app-period-nav />

    @if (acts().length) {
      <section class="section">
        <div class="card profile">
          <span class="label">Ton profil {{ ps.period().phrase }}</span>
          <span class="display title">{{ profile().title }}</span>
          <ul>
            @for (t of profile().traits; track t) {
              <li>{{ t }}</li>
            }
          </ul>
        </div>
      </section>

      <app-subtabs #st [tabs]="subtabs" param="onglet" variant="segment" />

      @switch (st.current()) {
        @case ('quand') {
      <section class="section">
        <h2>Quand cours-tu ?</h2>
        <div class="card">
          <h3>Heure de départ × jour de la semaine</h3>
          <div class="punch-wrap">
            <div class="punch">
              <span></span>
              @for (h of hours; track h) {
                <span class="hour muted">{{ h % 3 === 0 ? h + 'h' : '' }}</span>
              }
              @for (row of punch(); track $index; let d = $index) {
                <span class="wd muted">{{ weekdays[d].slice(0, 3) }}</span>
                @for (n of row; track $index; let h = $index) {
                  <span class="slot" [title]="weekdays[d] + ' ' + h + 'h : ' + n + ' sortie' + (n > 1 ? 's' : '')">
                    @if (n) {
                      <i [style.--r]="dot(n)"></i>
                    }
                  </span>
                }
              }
            </div>
          </div>
        </div>

        <div class="moments">
          @for (m of daytimes(); track m.key) {
            <div class="card moment" [class.top]="m.count === maxDaytime()">
              <span class="display m-val">{{ pct(m.count) }}</span>
              <span class="m-label">{{ m.label }} <span class="muted">· {{ m.range }}</span></span>
              <span class="muted small">{{ m.count }} sorties · {{ km(m.km) }}</span>
            </div>
          }
        </div>

        <div class="card">
          <h3>Jours de la semaine</h3>
          <app-chart [config]="weekdayChart()" />
        </div>
      </section>
        }
        @case ('comment') {
      <section class="section">
        <h2>Comment cours-tu ?</h2>
        <div class="two">
          <div class="card">
            <h3>Distribution des distances</h3>
            <app-chart [config]="distChart()" />
          </div>
          <div class="card">
            <h3>Distribution des allures <small class="muted">· hors tapis</small></h3>
            <app-chart [config]="paceChart()" />
          </div>
        </div>
        <div class="card">
          <h3>Distance × allure <small class="muted">· chaque point est une sortie</small></h3>
          <app-chart [config]="scatter()" style="--chart-h: 320px" />
        </div>
      </section>
        }
      }
    } @else {
      <p class="muted empty">Aucune sortie sur cette période.</p>
    }
    }
  `,
  styles: `
    :host { --chart-h: 240px; }
    .profile { display: grid; gap: 0.4rem; background: linear-gradient(135deg, var(--surface-1), var(--accent-soft)); }
    .profile .title { font-size: clamp(2rem, 7vw, 2.6rem); color: var(--accent); }
    .profile ul { margin: 0.3rem 0 0; padding-left: 1.1rem; color: var(--text-secondary); display: grid; gap: 0.2rem; }
    .card { display: grid; gap: 0.9rem; }
    h3 small { font-family: var(--font-body); font-size: 0.8rem; font-weight: 400; text-transform: none; }
    .punch-wrap { overflow-x: auto; }
    .punch { display: grid; grid-template-columns: 2.4rem repeat(24, minmax(18px, 1fr)); gap: 2px; min-width: 560px; align-items: center; }
    .hour, .wd { font-size: 0.7rem; }
    .slot { aspect-ratio: 1; display: grid; place-items: center; background: var(--surface-2); border-radius: 4px; }
    .slot i { width: var(--r); height: var(--r); border-radius: 50%; background: var(--series-1); }
    .moments { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; }
    .moment { gap: 0.2rem; }
    .moment.top { border-color: var(--accent); }
    .m-val { font-size: 2.2rem; }
    .m-label { font-weight: 600; font-size: 0.9rem; }
    .small { font-size: 0.8rem; }
    .two { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
    @media (max-width: 600px) { :host { --chart-h: 210px; } .punch { min-width: 520px; } }
    .empty { margin-top: 3rem; }
  `,
})
export class HabitsPage {
  /** Carte de Comprendre : le constat en une phrase et une vignette, sans le détail */
  readonly compact = input(false);
  private readonly store = inject(DataService);
  protected readonly subtabs: SubTab[] = [
    { id: 'quand', label: 'Quand' },
    { id: 'comment', label: 'Comment' },
  ];

  protected readonly ps = inject(PeriodService);
  protected readonly km = km;
  protected readonly weekdays = WEEKDAYS;
  protected readonly hours = Array.from({ length: 24 }, (_, i) => i);

  protected readonly acts = computed(() => inRange(this.store.activities(), this.ps.period().start, this.ps.period().end));
  protected readonly profile = computed(() => runnerProfile(this.acts()));
  protected readonly punch = computed(() => punchcard(this.acts()));
  private readonly punchMax = computed(() => Math.max(1, ...this.punch().flat()));
  protected readonly daytimes = computed(() => daytimeStats(this.acts()));
  protected readonly maxDaytime = computed(() => Math.max(...this.daytimes().map((d) => d.count)));

  protected dot(n: number): string {
    return `${Math.round(25 + 75 * Math.sqrt(n / this.punchMax()))}%`;
  }

  protected pct(n: number): string {
    return `${num((n / Math.max(1, this.acts().length)) * 100)} %`;
  }

  protected readonly weekdayChart = computed<ChartConfiguration>(() => {
    const w = weekdayStats(this.acts());
    const max = Math.max(...w.map((d) => d.count));
    return {
      type: 'bar',
      data: {
        labels: w.map((d) => d.day.slice(0, 3)),
        datasets: [{ label: 'Sorties', data: w.map((d) => d.count), ...bar(), backgroundColor: w.map((d) => (d.count === max ? C.accent : C.s1)) }],
      },
      options: {
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (i) => w[i[0].dataIndex].day,
              label: (c) => {
                const d = w[c.dataIndex];
                return ` ${d.count} sorties · ${km(d.km)} · ${d.count ? num(d.km / d.count, 1) : 0} km en moyenne`;
              },
            },
          },
        },
      },
    };
  });

  protected readonly distChart = computed<ChartConfiguration>(() => {
    const counts = histogram(this.acts().map((a) => a.distanceKm), DIST_EDGES);
    const labels = DIST_EDGES.map((e, i) => (i === DIST_EDGES.length - 1 ? `${e}+` : `${e}–${DIST_EDGES[i + 1]}`));
    return {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Sorties', data: counts, ...bar() }] },
      options: {
        scales: { x: { grid: { display: false }, title: { display: true, text: 'km' } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => `${i[0].label} km`, label: (c) => ` ${c.parsed.y} sorties` } } },
      },
    };
  });

  protected readonly paceChart = computed<ChartConfiguration>(() => {
    const outdoor = this.acts().filter((a) => a.kind !== 'indoor' && a.distanceKm >= 1);
    const counts = histogram(outdoor.map(paceOf), PACE_EDGES);
    const labels = PACE_EDGES.map((e, i) => (i === PACE_EDGES.length - 1 ? `${pace(e)}+` : pace(e)));
    return {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Sorties', data: counts, ...bar(C.s3) }] },
      options: {
        scales: { x: { grid: { display: false }, title: { display: true, text: 'min/km' } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (i) => {
                const k = i[0].dataIndex;
                return k === PACE_EDGES.length - 1 ? `Plus lent que ${pace(PACE_EDGES[k])}` : `${pace(PACE_EDGES[k])} à ${pace(PACE_EDGES[k] + 15)} /km`;
              },
              label: (c) => ` ${c.parsed.y} sorties`,
            },
          },
        },
      },
    };
  });

  protected readonly scatter = computed<ChartConfiguration>(() => {
    const point = (kind: string) =>
      this.acts()
        .filter((a) => a.kind === kind && a.distanceKm >= 1)
        .map((a) => ({ x: Math.round(a.distanceKm * 100) / 100, y: Math.round(paceOf(a)), name: a.name, date: a.date }));
    const ds = (label: string, data: ReturnType<typeof point>, color: string) => ({
      label,
      data,
      backgroundColor: color,
      borderColor: C.surface,
      borderWidth: 1,
      pointRadius: 4,
      pointHoverRadius: 7,
    });
    return {
      type: 'scatter',
      data: { datasets: [ds('Route', point('road'), C.s1), ds('Trail', point('trail'), C.s2)] },
      options: {
        scales: {
          x: { title: { display: true, text: 'Distance (km)' }, beginAtZero: true },
          y: { reverse: true, title: { display: true, text: 'Allure (min/km)' }, ticks: { callback: (v) => pace(Number(v)) } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              label: (c) => {
                const p = c.raw as { x: number; y: number; name: string; date: string };
                return ` ${p.name} (${p.date}) : ${num(p.x, 1)} km à ${pace(p.y)} /km`;
              },
            },
          },
        },
      },
    };
  });
}
