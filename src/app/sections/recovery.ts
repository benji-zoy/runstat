import { Component, computed, inject } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { Baseline, Bucket, baselineSeries, efByRecovery, hrvAfterLoad, hrvStatus, rhrStatus, sleepDebt } from '../core/health';
import { efSeries } from '../core/science';
import { addDays, isoDay, parseDay } from '../core/stats';
import { fixed, num } from '../core/format';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const short = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const hm = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;

/** Récupération : VFC, FC de repos, sommeil et préparation (Google Health ou COROS ; absente sans source de santé). */
@Component({
  selector: 'app-recovery',
  imports: [ChartComponent],
  template: `
    @if (health(); as h) {
      <section class="section">
        <h2>Récupération <small>{{ sci.healthLabel() }} · {{ importedAt() }}</small></h2>

        <div class="grid cards">
          @if (today(); as t) {
            <div class="card stat">
              <span class="label">Préparation du jour</span>
              <span class="display big">{{ t.readiness ?? '–' }}<small>/100</small></span>
              <span class="muted small">
                Nuit : {{ t.sleepMin ? hm(t.sleepMin) : '–' }}
                @if (t.sleepScore) { · score {{ t.sleepScore }} }
              </span>
            </div>
          }
          <div class="card stat">
            <span class="label">VFC nocturne (7 j)</span>
            <span class="display big">{{ hrvNow()?.avg7 ? num(hrvNow()!.avg7!) : '–' }}<small> ms</small></span>
            @if (hrvState(); as s) {
              <span class="pill" [attr.data-tone]="s.tone">{{ s.label }}</span>
              <span class="muted small">{{ s.text }} Base : {{ num(hrvNow()!.mean!) }} ± {{ num(hrvNow()!.sd!) }} ms.</span>
            }
          </div>
          <div class="card stat">
            <span class="label">FC de repos (7 j)</span>
            <span class="display big">{{ rhrNow()?.avg7 ? fixed(rhrNow()!.avg7!, 1) : '–' }}<small> bpm</small></span>
            @if (rhrState(); as s) {
              <span class="pill" [attr.data-tone]="s.tone">{{ s.label }} vs base</span>
              <span class="muted small">{{ s.text }}</span>
            }
          </div>
          @if (debt(); as d) {
            <div class="card stat">
              <span class="label">Sommeil (7 nuits)</span>
              <span class="display big">{{ hm(d.avg) }}</span>
              <span class="muted small">en moyenne · dette de <b class="txt">{{ hm(d.debt) }}</b> par rapport à un objectif de 7 h 30</span>
            </div>
          }
        </div>

        <div class="two">
          <div class="card">
            <h3>VFC nocturne <small class="muted">· bande = ta base ± 1 écart-type</small></h3>
            <app-chart [config]="hrvChart()" />
          </div>
          <div class="card">
            <h3>FC de repos</h3>
            <app-chart [config]="rhrChart()" />
          </div>
        </div>

        <div class="card">
          <h3>Sommeil <small class="muted">· durée par nuit, dont sommeil profond</small></h3>
          <app-chart [config]="sleepChart()" />
        </div>

        <h3 class="sub">Ce qui influence ta forme <small class="muted">· analyse exploratoire sur {{ days() }} jours</small></h3>
        <div class="grid three">
          <div class="card">
            <h4>Efficacité selon la nuit précédente</h4>
            <app-chart [config]="bucketChart(effects().sleep, 'Efficacité vs habitude (%)')" style="--chart-h: 200px" />
          </div>
          <div class="card">
            <h4>Efficacité selon la VFC du matin</h4>
            <app-chart [config]="bucketChart(effects().hrv, 'Efficacité vs habitude (%)')" style="--chart-h: 200px" />
          </div>
          <div class="card">
            <h4>VFC du lendemain selon la charge</h4>
            <app-chart [config]="bucketChart(afterLoad(), 'VFC vs base (%)')" style="--chart-h: 200px" />
          </div>
        </div>
        <p class="muted small">
          Efficacité = vitesse / FC des sorties d'endurance comparables, en écart à leur référence habituelle (voir Labo).
          Les barres indiquent le nombre de jours (n) : avec quelques mois de données, ce sont des tendances, pas des
          certitudes.
        </p>

        @if (weightChart(); as w) {
          <div class="card">
            <h3>Poids <small class="muted">· moyenne mensuelle (Withings, Coros, Samsung)</small></h3>
            <app-chart [config]="w" style="--chart-h: 220px" />
          </div>
        }
      </section>
    }
  `,
  styles: `
    .cards { grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
    .stat { display: grid; gap: 0.35rem; align-content: start; }
    .card { display: grid; gap: 0.8rem; align-content: start; }
    .label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .big { font-size: 2.6rem; }
    .big small { font-size: 0.4em; color: var(--text-secondary); }
    .small { font-size: 0.82rem; margin: 0; }
    .txt { color: var(--text-primary); }
    h3 small, h4 small { font-family: var(--font-body); font-size: 0.8rem; font-weight: 400; text-transform: none; }
    h4 { margin: 0; font-family: var(--font-display); font-size: 1.05rem; text-transform: uppercase; color: var(--text-secondary); }
    .sub { margin-top: 0.5rem; }
    .two { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); }
    .three { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
    .pill {
      justify-self: start; padding: 0.2rem 0.7rem; border-radius: 999px; font-weight: 700; font-size: 0.85rem;
      background: var(--surface-2); border: 1px solid var(--surface-3);
    }
    .pill[data-tone='good'] { color: var(--good-text); border-color: var(--good); }
    .pill[data-tone='warning'] { color: var(--warning); border-color: var(--warning); }
    .pill[data-tone='critical'] { color: var(--critical-text); border-color: var(--critical); }
  `,
})
export class RecoveryComponent {
  private readonly store = inject(DataService);
  protected readonly sci = inject(ScienceService);
  private readonly todayDate = inject(PeriodService).today;

  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly hm = hm;

  protected readonly health = computed(() => this.store.data()?.health ?? null);
  protected readonly importedAt = computed(() => {
    const h = this.health();
    if (!h) return '';
    return h.syncedAt
      ? `synchronisé le ${short.format(new Date(h.syncedAt))}`
      : `importé le ${short.format(new Date(h.importedAt))}`;
  });
  /** Début de l'affichage : 120 derniers jours (les mesures ponctuelles plus anciennes écraseraient les graphiques) */
  private readonly first = computed(() => {
    const keys = Object.keys(this.health()?.days ?? {});
    if (!keys.length) return this.todayDate;
    const from = addDays(this.last(), -120);
    const first = parseDay(keys[0]);
    return first > from ? first : from;
  });
  /** Dernier jour disponible dans l'export (souvent aujourd'hui ou hier) */
  private readonly last = computed(() => {
    const keys = Object.keys(this.health()?.days ?? {});
    return keys.length ? parseDay(keys.at(-1)!) : this.todayDate;
  });
  protected readonly days = computed(() => Object.keys(this.health()?.days ?? {}).length);
  protected readonly today = computed(() => this.health()?.days[isoDay(this.last())] ?? null);

  private series(metric: 'hrv' | 'rhr') {
    const h = this.health();
    return h ? baselineSeries(h, metric, this.first(), this.last()) : [];
  }
  private readonly hrv = computed(() => this.series('hrv'));
  private readonly rhr = computed(() => this.series('rhr'));
  protected readonly hrvNow = computed(() => this.hrv().at(-1));
  protected readonly rhrNow = computed(() => this.rhr().at(-1));
  protected readonly hrvState = computed(() => hrvStatus(this.hrvNow()));
  protected readonly rhrState = computed(() => rhrStatus(this.rhrNow()));
  protected readonly debt = computed(() => (this.health() ? sleepDebt(this.health()!, this.last()) : null));

  private readonly hrvMap = computed(() => new Map(this.hrv().map((b) => [isoDay(b.date), b] as [string, Baseline])));
  protected readonly effects = computed(() =>
    efByRecovery(efSeries(this.store.activities(), this.sci.types()), this.health()!, this.hrvMap()),
  );
  protected readonly afterLoad = computed(() => hrvAfterLoad(this.store.activities(), this.health()!));

  private lineChart(series: Baseline[], unit: string, color: string): ChartConfiguration {
    const labels = series.map((b) => short.format(b.date));
    const band = (sign: number) => series.map((b) => (b.mean !== null && b.sd !== null ? Math.round((b.mean + sign * b.sd) * 10) / 10 : null));
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Base +1 σ', data: band(1), borderColor: 'transparent', backgroundColor: alpha(C.neutral, 0.12), pointRadius: 0, fill: '+1' },
          { label: 'Base −1 σ', data: band(-1), borderColor: 'transparent', pointRadius: 0, fill: false },
          { label: 'Par nuit', data: series.map((b) => b.value), borderColor: alpha(C.neutral, 0.5), backgroundColor: alpha(C.neutral, 0.5), borderWidth: 1, pointRadius: 1.5, spanGaps: true },
          { label: 'Moyenne 7 j', data: series.map((b) => (b.avg7 === null ? null : Math.round(b.avg7 * 10) / 10)), borderColor: color, backgroundColor: color, borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } }, y: { title: { display: true, text: unit } } },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { filter: (l) => !l.text.startsWith('Base') } },
          tooltip: { filter: (i) => i.datasetIndex >= 2, callbacks: { label: (c) => ` ${c.dataset.label} : ${num(c.parsed.y ?? 0, 1)} ${unit}` } },
        },
      },
    };
  }

  protected readonly hrvChart = computed(() => this.lineChart(this.hrv(), 'ms', C.s1));
  protected readonly rhrChart = computed(() => this.lineChart(this.rhr(), 'bpm', C.s2));

  protected readonly sleepChart = computed<ChartConfiguration>(() => {
    const h = this.health()!;
    const dates: Date[] = [];
    for (let d = this.first(); d <= this.last(); d = addDays(d, 1)) dates.push(d);
    const day = (d: Date) => h.days[isoDay(d)];
    return {
      type: 'bar',
      data: {
        labels: dates.map((d) => short.format(d)),
        datasets: [
          {
            label: 'Sommeil profond',
            data: dates.map((d) => (day(d)?.deepMin ? Math.round(day(d)!.deepMin! ) / 60 : null)),
            backgroundColor: C.seq2,
            stack: 's',
          },
          {
            label: 'Reste du sommeil',
            data: dates.map((d) => (day(d)?.sleepMin ? (day(d)!.sleepMin! - (day(d)!.deepMin ?? 0)) / 60 : null)),
            backgroundColor: C.s1Hover,
            borderColor: C.surface,
            borderWidth: { top: 0, bottom: 2 },
            borderSkipped: false,
            stack: 's',
          },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
          y: { stacked: true, title: { display: true, text: 'heures' }, suggestedMax: 9 },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              label: (c) => ` ${c.dataset.label} : ${hm((c.parsed.y ?? 0) * 60)}`,
              footer: (i) => {
                const d = day(dates[i[0].dataIndex]);
                return d?.sleepMin ? `Total ${hm(d.sleepMin)}${d.sleepScore ? ' · score ' + d.sleepScore : ''}` : '';
              },
            },
          },
        },
      },
    };
  });

  protected bucketChart(buckets: Bucket[], axis: string): ChartConfiguration {
    return {
      type: 'bar',
      data: {
        labels: buckets.map((b) => `${b.label} (n=${b.n})`),
        datasets: [
          {
            label: axis,
            data: buckets.map((b) => (b.mean === null || b.n < 3 ? null : Math.round(b.mean * 10) / 10)),
            backgroundColor: buckets.map((b) => ((b.mean ?? 0) >= 0 ? C.s1 : C.bad)),
            borderRadius: 4,
          },
        ],
      },
      options: {
        scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { title: { display: true, text: axis } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${(c.parsed.y ?? 0) >= 0 ? '+' : ''}${num(c.parsed.y ?? 0, 1)} %` } },
        },
      },
    };
  }

  protected readonly weightChart = computed<ChartConfiguration | null>(() => {
    const w = this.health()?.weight ?? [];
    if (w.length < 5) return null;
    const months = new Map<string, number[]>();
    for (const p of w) {
      const k = p.date.slice(0, 7);
      months.set(k, [...(months.get(k) ?? []), p.kg]);
    }
    const keys = [...months.keys()].sort();
    return {
      type: 'line',
      data: {
        labels: keys.map((k) => new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' }).format(new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1))),
        datasets: [
          {
            label: 'Poids',
            data: keys.map((k) => Math.round((months.get(k)!.reduce((a, b) => a + b, 0) / months.get(k)!.length) * 10) / 10),
            borderColor: C.s3,
            backgroundColor: C.s3,
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: {
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } }, y: { title: { display: true, text: 'kg' } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${num(c.parsed.y ?? 0, 1)} kg` } } },
      },
    };
  });
}
