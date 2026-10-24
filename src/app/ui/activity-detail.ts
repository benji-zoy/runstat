import { Component, computed, inject, input } from '@angular/core';
import { Activity } from '../core/models';
import { DataService } from '../core/data.service';
import { ScienceService } from '../core/science.service';
import { notables } from '../core/insights';
import { SESSION_TYPES, kmEffort, trimp, wallAnalysis } from '../core/science';
import { ChartConfiguration } from 'chart.js';
import { ChartComponent } from './chart';
import { decodePolyline } from '../core/polyline';
import { durability } from '../core/durability';
import { clock, num, pace } from '../core/format';
import { RouteMapComponent } from './route-map';
import { C } from './palette';
import { ConditionsCardComponent } from './conditions-card';

const FOCUS: Record<string, string> = {
  Base: 'Endurance de base',
  Recovery: 'Récupération',
  Tempo: 'Tempo',
  Threshold: 'Seuil',
  'VO2 Max': 'VO2max',
  Anaerobic: 'Anaérobie',
};
const EFFORTS: [string, string][] = [
  ['1000', '1 km'], ['1609', '1 mile'], ['3000', '3 km'], ['5000', '5 km'], ['10000', '10 km'], ['21097', 'Semi'],
];

/** Fiche détaillée d'une sortie : métriques, « notables » façon Smashrun, coût des conditions, analyses FIT et tracé. */
@Component({
  selector: 'app-activity-detail',
  imports: [RouteMapComponent, ChartComponent, ConditionsCardComponent],
  template: `
    @let a = activity();
    <div class="tags">
      <span class="type" [style.--c]="type().color">{{ type().icon }} {{ type().label }}</span>
      @for (n of notes(); track n) {
        <span class="notable">⭐ {{ n }}</span>
      }
    </div>

    <div class="layout" [class.with-map]="track()">
      <div class="body">
        <dl class="metrics">
          @for (m of metrics(); track m.label) {
            <div>
              <dt>{{ m.label }}</dt>
              <dd>{{ m.value }}</dd>
            </div>
          }
        </dl>

        <app-conditions [activity]="a" />

        @if (wall()?.wall) {
          <p class="wall">
            🧱 Mur détecté au <b>{{ wall()!.wallKm }}e km</b> (jusqu'à +{{ num((wall()!.fade - 1) * 100) }} % sur 5 km).
            Sur la lancée des {{ wall()!.preWallKm }} premiers km : environ <b>{{ clock(wall()!.potential!) }}</b>.
          </p>
        }

        @if (dur(); as d) {
          <p class="dur">
            🔋 Durabilité : efficacité <b>{{ d.efLoss > 0 ? '−' : '+' }}{{ num(Math.abs(d.efLoss), 1) }} %</b> entre le premier et le dernier tiers
            @if (d.hrDrift !== null) {
              · dérive <b>{{ d.hrDrift >= 0 ? '+' : '−' }}{{ num(Math.abs(d.hrDrift), 1) }} bpm/h</b> à allure égale
            }
            @if (d.climb; as c) {
              · montées <b>{{ num(c[0]) }} → {{ num(c[1]) }} m/h</b>
            }
            @if (d.descent; as c) {
              · descentes <b>{{ num(c[0], 1) }} → {{ num(c[1], 1) }} km/h</b>
            }
            @if (d.onset !== null) {
              · dégradation à partir de {{ clock(d.onset) }}
            } @else {
              · l'efficacité tient jusqu'au bout
            }
          </p>
        }

        @if (splitsChart(); as sc) {
          <div class="splits">
            <span class="fit-title">Allure par kilomètre</span>
            <app-chart [config]="sc" style="--chart-h: 150px" />
          </div>
        }

        @if (a.fit; as f) {
          <div class="fit">
            <span class="fit-title">Analyse seconde par seconde</span>
            <div class="efforts">
              @for (e of efforts(); track e.label) {
                <span><small>{{ e.label }}</small>{{ e.time }}</span>
              }
            </div>
            <div class="zones" title="Temps passé dans les 3 zones de FC">
              @for (z of zones(); track $index) {
                <span [style.flex]="z.share" [attr.data-z]="$index">{{ z.share > 0.08 ? z.label : '' }}</span>
              }
            </div>
          </div>
        }
      </div>

      @if (track(); as t) {
        <app-route-map [tracks]="[t]" />
      }
    </div>
  `,
  styles: `
    :host { display: grid; gap: 0.9rem; padding: 0.9rem 0.25rem 1.1rem; }
    .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .type, .notable { padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.82rem; font-weight: 600; }
    .type { border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
    .notable { background: var(--accent-soft); color: var(--accent-text); }
    .layout { display: grid; gap: 1rem; }
    .layout.with-map { grid-template-columns: minmax(0, 3fr) minmax(240px, 2fr); }
    @media (max-width: 800px) { .layout.with-map { grid-template-columns: minmax(0, 1fr); } }
    .body { display: grid; gap: 0.8rem; align-content: start; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.5rem; margin: 0; }
    .metrics div { background: var(--surface-2); border-radius: 8px; padding: 0.5rem 0.7rem; }
    dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
    dd { margin: 0.1rem 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .fit, .splits { display: grid; gap: 0.5rem; }
    .wall { margin: 0; font-size: 0.85rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 40%, transparent); }
    .wall b, .dur b { color: var(--text-primary); }
    .dur { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
    .fit-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .efforts { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .efforts span { display: grid; padding: 0.35rem 0.6rem; background: var(--surface-2); border-radius: 8px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .efforts small { font-size: 0.68rem; font-weight: 400; color: var(--text-muted); }
    .zones { display: flex; height: 1.4rem; border-radius: 6px; overflow: hidden; gap: 2px; font-size: 0.72rem; }
    .zones span { display: grid; place-items: center; color: #fff; min-width: 2px; }
    .zones [data-z='0'] { background: var(--series-1); }
    .zones [data-z='1'] { background: var(--series-4); }
    .zones [data-z='2'] { background: var(--series-2); }
  `,
})
export class ActivityDetailComponent {
  readonly activity = input.required<Activity>();
  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);

  protected readonly num = num;
  protected readonly pace = pace;
  protected readonly clock = clock;

  protected readonly wall = computed(() => wallAnalysis(this.activity()));
  protected readonly dur = computed(() => durability(this.activity()));
  protected readonly Math = Math;

  protected readonly splitsChart = computed<ChartConfiguration | null>(() => {
    const s = this.activity().splits;
    if (!s || s.length < 3) return null;
    const w = this.wall();
    const avg = s.reduce((t, x) => t + x, 0) / s.length;
    return {
      type: 'bar',
      data: {
        labels: s.map((_, i) => String(i + 1)),
        datasets: [
          {
            label: 'Allure',
            data: s,
            backgroundColor: s.map((x, i) => (w?.wall && i + 1 >= w.preWallKm + 1 ? C.bad : x < avg * 0.97 ? C.s1Hover : C.s1)),
            borderRadius: 3,
            barPercentage: 0.9,
            categoryPercentage: 0.95,
          },
        ],
      },
      options: {
        scales: {
          x: { grid: { display: false }, ticks: { autoSkipPadding: 4, maxRotation: 0 } },
          y: { reverse: true, min: Math.floor(Math.min(...s) * 0.92), max: Math.ceil(Math.max(...s) * 1.04), ticks: { callback: (v) => pace(Number(v)), maxTicksLimit: 4 } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (i) => `Km ${i[0].label}`, label: (c) => ` ${pace(c.parsed.y)} /km` } },
        },
      },
    };
  });

  constructor() {
    this.store.loadRoutes();
  }

  protected readonly notes = computed(() => notables(this.activity(), this.store.activities()));
  protected readonly type = computed(() => SESSION_TYPES[this.sci.types().get(this.activity().id) ?? 'easy']);

  protected readonly track = computed(() => {
    const encoded = this.store.routes()?.[this.activity().id];
    return encoded ? decodePolyline(encoded) : null;
  });

  protected readonly efforts = computed(() => {
    const f = this.activity().fit;
    if (!f) return [];
    return EFFORTS.filter(([k]) => f.efforts[k]).map(([k, label]) => ({ label, time: clock(f.efforts[k]!) }));
  });

  protected readonly zones = computed(() => {
    const z = this.activity().fit?.zones3 ?? [0, 0, 0];
    const total = z.reduce((s, x) => s + x, 0) || 1;
    return ['Facile', 'Modéré', 'Intense'].map((label, i) => ({ label: `${label} ${Math.round((z[i] / total) * 100)} %`, share: z[i] / total }));
  });

  protected readonly metrics = computed(() => {
    const a = this.activity();
    const f = a.fit;
    const time = a.start ? new Date(a.start * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
    const tr = trimp(a, this.sci.athlete());
    const caps = this.sci.caps();
    const rows: { label: string; value: string }[] = [
      { label: 'Départ', value: time ?? '–' },
      { label: 'Distance', value: `${num(a.distanceKm, 2)} km` },
      { label: 'Durée', value: clock(a.durationSec) },
      { label: 'Allure', value: `${pace(a.durationSec / a.distanceKm)} /km` },
      ...(f ? [{ label: 'Allure plat équiv.', value: `${pace(a.durationSec / (f.gapDistance / 1000))} /km` }] : []),
      { label: 'Meilleur km', value: a.bestKmSec ? `${pace(a.bestKmSec)} /km` : '–' },
      { label: 'D+ / D−', value: a.elevGain != null ? `${a.elevGain} / ${a.elevLoss ?? '–'} m` : '–' },
      ...(a.kind === 'trail' || (a.elevGain ?? 0) > 300 ? [{ label: 'Km-effort', value: num(kmEffort(a), 1) }] : []),
      { label: 'FC moy. / max', value: a.avgHr ? `${a.avgHr}${f?.maxHr ? ' / ' + f.maxHr : ''} bpm` : '–' },
      { label: 'Cadence', value: a.cadence ? `${a.cadence} ppm` : '–' },
      { label: 'Foulée', value: a.stride ? `${num(a.stride, 2)} m` : '–' },
      { label: 'Puissance', value: a.power ? `${a.power} W` : '–' },
      // Sans COROS, la charge est déjà le TRIMP (build-data) : une seule ligne
      ...(caps.corosLoad ? [{ label: caps.loadLabel, value: a.trainingLoad != null ? String(a.trainingLoad) : '–' }] : []),
      { label: 'TRIMP', value: tr != null ? num(tr) : '–' },
      ...(f?.decoupling != null ? [{ label: 'Découplage', value: `${num(f.decoupling, 1)} %` }] : []),
      ...(caps.trainingEffect
        ? [
            { label: 'TE aéro / anaéro', value: a.aerobicTE != null ? `${num(a.aerobicTE, 1)} / ${num(a.anaerobicTE ?? 0, 1)}` : '–' },
            { label: 'Focus', value: a.focus ? (FOCUS[a.focus] ?? a.focus) : '–' },
          ]
        : []),
      { label: 'Calories', value: a.calories ? `${num(a.calories)} kcal` : '–' },
    ];
    return rows;
  });
}
