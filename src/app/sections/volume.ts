import { Component, computed, inject, signal } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { cumulativeByYear, dailyGrid, inRange, periodBuckets, shiftPeriod, streaks, summarize, weekly } from '../core/stats';
import { day, duration, km, num } from '../core/format';
import { activeDays, eddington, weekStreaks, yearProjection } from '../core/insights';
import { ChartComponent } from '../ui/chart';
import { PeriodNavComponent } from '../ui/period-nav';
import { Brief, BriefComponent } from '../ui/brief';
import { HeroComponent } from './hero';
import { C, SERIES } from '../ui/palette';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const short = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/** Paliers de la heatmap (km / jour) */
const LEVELS = [0, 5, 10, 15, 21];

/** Entraînement › Volume : la période choisie (ex-Aperçu), puis le volume sur la durée (ex-Progression) et la régularité (ex-Records). */
@Component({
  selector: 'app-volume',
  imports: [ChartComponent, PeriodNavComponent, BriefComponent, HeroComponent],
  template: `
    <app-period-nav />
    <app-brief [brief]="brief()" />
    <app-hero [period]="period()" [summary]="summary()" [prev]="prevSummary()" />

    <section class="section">
      <h2>{{ chartTitle() }}
        @if (period().gran !== 'week') {
          <small>Touche une barre pour zoomer</small>
        }
      </h2>
      <div class="card">
        <app-chart [config]="periodChart()" style="--chart-h: 280px" />
      </div>
    </section>

    <section class="section">
      <h2>Sur la durée</h2>
      <div class="card">
        <h3>Kilomètres cumulés, année par année <small class="muted">· pointillés : projection de fin d'année</small></h3>
        <app-chart [config]="cumulative()" style="--chart-h: 320px" />
      </div>

      <div class="card">
        <h3>Volume hebdomadaire <small class="muted">· 52 dernières semaines</small></h3>
        <app-chart [config]="weeklyChart()" />
      </div>

      <div class="card">
        <h3>Calendrier <small class="muted">· 12 derniers mois</small></h3>
        <div class="heatmap-wrap">
          <div class="heatmap" role="img" aria-label="Kilomètres courus par jour sur les 12 derniers mois">
            <div class="days muted">
              <span></span><span>lun</span><span></span><span>mer</span><span></span><span>ven</span><span></span><span>dim</span>
            </div>
            @for (week of grid(); track $index) {
              <div class="week">
                <span class="month muted">{{ monthLabel(week[0].date, $index) }}</span>
                @for (c of week; track c.date.getTime()) {
                  <span
                    class="cell"
                    [class.future]="c.future"
                    [attr.data-level]="level(c.km)"
                    (mouseenter)="hovered.set(c)"
                    (click)="hovered.set(c)"
                    (mouseleave)="hovered.set(null)"
                  ></span>
                }
              </div>
            }
          </div>
        </div>
        <div class="heat-foot">
          <span class="muted hover-info">
            @if (hovered(); as h) {
              <b>{{ day(h.date) }}</b> — {{ h.km ? km(h.km) : 'repos' }}
            } @else {
              Survole ou touche une case pour voir le détail
            }
          </span>
          <span class="legend muted">
            Repos
            @for (l of legendLevels; track l) {
              <span class="cell" [attr.data-level]="l"></span>
            }
            21 km +
          </span>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Régularité <small>depuis le début</small></h2>
      <div class="grid reg">
        <div class="card stat edd">
          <span class="label">Nombre d'Eddington</span>
          <span class="display big">{{ edd().e }}</span>
          <span class="muted small">
            Tu as couru au moins <b>{{ edd().e }} km</b> sur au moins <b>{{ edd().e }} jours</b> différents.
            Pour passer à {{ edd().e + 1 }}, il te faut encore <b>{{ edd().nextNeeded }}</b> jour{{ edd().nextNeeded > 1 ? 's' : '' }} à {{ edd().e + 1 }} km ou plus.
          </span>
        </div>
        <div class="card stat">
          <span class="label">Plus longue série</span>
          <span class="display big">{{ dayStreak().longest }}<small> jours</small></span>
          <span class="muted small">
            @if (dayStreak().longestEnd; as end) { d'affilée, jusqu'au {{ day(end) }} · }
            série en cours : {{ dayStreak().current }} j
          </span>
        </div>
        <div class="card stat">
          <span class="label">Semaines consécutives</span>
          <span class="display big">{{ weekStreak().longest }}<small> sem.</small></span>
          <span class="muted small">avec au moins une sortie · en cours : {{ weekStreak().current }} sem.</span>
        </div>
        <div class="card stat">
          <span class="label">Jours actifs</span>
          <span class="display big">{{ days() }}</span>
          <span class="muted small">jours avec au moins une sortie</span>
        </div>
      </div>
    </section>
  `,
  styleUrl: './volume.scss',
})
export class VolumeSection {
  private readonly store = inject(DataService);
  protected readonly ps = inject(PeriodService);
  protected readonly activities = this.store.activities;
  private readonly todayDate = this.ps.today;
  protected readonly today = () => this.todayDate;

  // -------------------------------------------------------------------------
  // Période choisie (ex-Aperçu)
  // -------------------------------------------------------------------------

  protected readonly period = this.ps.period;
  private readonly periodActs = computed(() => inRange(this.activities(), this.period().start, this.period().end));
  protected readonly summary = computed(() => summarize(this.periodActs()));
  protected readonly prevSummary = computed(() => {
    const prev = this.period().prev;
    return prev ? summarize(inRange(this.activities(), prev.start, prev.end)) : null;
  });
  private readonly projection = computed(() =>
    this.period().gran === 'year' && this.period().current ? yearProjection(this.activities(), this.todayDate) : null,
  );

  protected readonly brief = computed<Brief | null>(() => {
    const p = this.period();
    const s = this.summary();
    if (!s.count) return null;
    const prev = this.prevSummary();
    const points: string[] = [`${s.count} sortie${s.count > 1 ? 's' : ''}, ${duration(s.sec)} de course et ${num(s.elev)} m de D+.`];
    if (prev && p.prev && prev.km) {
      const diff = s.km - prev.km;
      points.push(`${diff >= 0 ? '+' : '−'}${km(Math.abs(diff))} par rapport à ${p.prev.label} (${diff >= 0 ? '+' : '−'}${num(Math.abs(diff / prev.km) * 100)} %).`);
    }
    const pr = this.projection();
    if (pr) {
      const y = p.start.getFullYear();
      const last = this.activities().filter((a) => a.date.startsWith(String(y - 1))).reduce((t, a) => t + a.distanceKm, 0);
      points.push(
        `À ce rythme, tu finiras ${y} vers ${km(pr.projected)}` +
          (last ? (pr.projected > last ? `, au-delà des ${km(last)} de ${y - 1}.` : `, il manquerait ${km(last - pr.projected)} pour battre ${y - 1}.`) : '.'),
      );
    }
    const st = streaks(this.activities(), this.todayDate);
    if (st.current > 1) points.push(`Série en cours : ${st.current} jours d'affilée.`);
    const title =
      prev && p.prev && prev.km
        ? s.km >= prev.km
          ? `Plus de volume que ${p.prev.label}`
          : `Moins de volume que ${p.prev.label}`
        : `${km(s.km)} ${p.phrase}`;
    return { title, points };
  });

  protected readonly chartTitle = computed(
    () => ({ all: 'Année par année', year: 'Mois par mois', month: 'Jour par jour', week: 'Jour par jour' })[this.period().gran],
  );

  protected readonly periodChart = computed<ChartConfiguration>(() => {
    const p = this.period();
    const buckets = periodBuckets(this.activities(), p, this.store.firstDay());
    // En vue année, on superpose l'année précédente en fantôme pour comparer
    const prev =
      p.gran === 'year' && p.prev
        ? periodBuckets(this.activities(), { ...p, start: p.prev.start, end: shiftPeriod('year', p.prev.start, 1) }, this.store.firstDay())
        : null;
    const bars = { borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' as const, categoryPercentage: 0.8, barPercentage: 0.9 };
    return {
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [
          ...(prev ? [{ label: String(p.start.getFullYear() - 1), data: prev.map((b) => Math.round(b.km * 10) / 10), backgroundColor: C.ghost, ...bars }] : []),
          {
            label: p.gran === 'year' ? String(p.start.getFullYear()) : 'Distance',
            data: buckets.map((b) => Math.round(b.km * 10) / 10),
            backgroundColor: C.s1,
            hoverBackgroundColor: C.s1Hover,
            ...bars,
          },
        ],
      },
      options: {
        onClick: (_e, elements) => {
          const b = buckets[elements[elements.length - 1]?.index ?? -1];
          if (b?.drill) this.ps.go(b.drill, b.start);
        },
        onHover: (e, elements) => {
          const target = e.native?.target as HTMLElement | undefined;
          if (target) target.style.cursor = elements.length && buckets[elements[0].index]?.drill ? 'pointer' : 'default';
        },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 6 } },
          y: { beginAtZero: true, ticks: { callback: (v) => `${v} km` } },
        },
        plugins: {
          legend: { display: !!prev, position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (items) => buckets[items[0]?.dataIndex ?? 0]?.title ?? '',
              label: (c) => {
                const src = prev && c.datasetIndex === 0 ? prev : buckets;
                const b = src[c.dataIndex];
                const who = prev ? `${c.dataset.label} : ` : '';
                return b.count ? ` ${who}${km(b.km)} · ${b.count} sortie${b.count > 1 ? 's' : ''} · ${duration(b.sec)}` : ` ${who}repos`;
              },
            },
          },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Régularité (ex-Records), sur tout l'historique
  // -------------------------------------------------------------------------

  protected readonly edd = computed(() => eddington(this.activities()));
  protected readonly dayStreak = computed(() => streaks(this.activities(), this.todayDate));
  protected readonly weekStreak = computed(() => weekStreaks(this.activities(), this.todayDate));
  protected readonly days = computed(() => activeDays(this.activities()));

  // -------------------------------------------------------------------------
  // Volume sur la durée (ex-Progression)
  // -------------------------------------------------------------------------

  protected readonly legendLevels = [0, 1, 2, 3, 4, 5];
  protected readonly day = day;
  protected readonly km = km;
  protected readonly hovered = signal<{ date: Date; km: number } | null>(null);

  protected readonly grid = computed(() => dailyGrid(this.activities(), this.today(), 53));

  /** 0 = repos, puis un palier par seuil franchi (0, 5, 10, 15, 21 km) */
  protected level(dayKm: number): number {
    return LEVELS.filter((min) => dayKm > min).length;
  }

  protected monthLabel(d: Date, index: number): string {
    // Libellé du mois sur la première semaine qui le contient
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
    if (index === 0) return MONTHS[d.getMonth()];
    return end.getDate() <= 7 ? MONTHS[end.getMonth()] : '';
  }

  protected readonly cumulative = computed<ChartConfiguration>(() => {
    const years = cumulativeByYear(this.activities(), this.today()).reverse().slice(0, SERIES.length);
    const labels = Array.from({ length: 366 }, (_, i) => short.format(new Date(2024, 0, 1 + i)));
    // Projection de l'année en cours : droite d'aujourd'hui jusqu'au 31 décembre
    const t = this.today();
    const current = years.find((y) => y.year === t.getFullYear());
    const projection: (number | null)[] = new Array(366).fill(null);
    if (current) {
      const i0 = current.values.reduce<number>((last, v, i) => (v !== null ? i : last), 0);
      const { projected } = yearProjection(this.activities(), t);
      const v0 = current.values[i0] as number;
      for (let i = i0; i < 366; i++) projection[i] = v0 + ((projected - v0) * (i - i0)) / (365 - i0);
    }
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          ...(current
            ? [
                {
                  label: `Projection ${current.year}`,
                  data: projection,
                  borderColor: SERIES[0],
                  backgroundColor: SERIES[0],
                  borderWidth: 2,
                  borderDash: [6, 5],
                  pointRadius: 0,
                  pointHoverRadius: 0,
                  tension: 0,
                },
              ]
            : []),
          ...years.map((y, i) => ({
          label: String(y.year),
          data: y.values,
          borderColor: SERIES[i],
          backgroundColor: SERIES[i],
          borderWidth: i === 0 ? 3 : 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: C.surface,
          tension: 0.2,
        })),
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { callback: (v) => `${num(Number(v))} km` } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (items) => items[0]?.label ?? '',
              label: (c) => (c.parsed.y == null ? '' : ` ${c.dataset.label} : ${km(c.parsed.y)}`),
            },
          },
        },
      },
    };
  });

  protected readonly weeklyChart = computed<ChartConfiguration>(() => {
    const weeks = weekly(this.activities(), this.today(), 52);
    return {
      type: 'bar',
      data: {
        labels: weeks.map((w) => short.format(w.start)),
        datasets: [
          {
            label: 'Km',
            data: weeks.map((w) => Math.round(w.km * 10) / 10),
            backgroundColor: weeks.map((_, i) => (i === weeks.length - 1 ? C.accent : C.s1)),
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: 'bottom',
            barPercentage: 0.85,
            categoryPercentage: 0.9,
          },
        ],
      },
      options: {
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 13, maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { callback: (v) => `${v} km` } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `Semaine du ${items[0]?.label}`,
              label: (c) => {
                const w = weeks[c.dataIndex];
                return ` ${km(w.km)} · ${w.count} sortie${w.count > 1 ? 's' : ''}`;
              },
            },
          },
        },
      },
    };
  });
}
