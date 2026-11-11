import { Component, computed, inject, input, signal } from '@angular/core';
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
      <span class="type" [style.--c]="type().color"><i class="dot" aria-hidden="true"></i>{{ type().label }}</span>
      @for (n of notes(); track n) {
        <span class="notable">⭐ {{ n }}</span>
      }
    </div>

    @if (track(); as t) {
      <app-route-map [tracks]="[t]" />
    }

    <div class="body">
      @if (groups().length) {
        <div class="groups">
          @for (g of groups(); track g.id) {
            @if (g.fold) {
              <details class="group fold" [open]="!compact()">
                <summary class="fit-title">{{ g.title }}</summary>
                <dl class="metrics">
                  @for (m of g.rows; track m.label) {
                    <div><dt>{{ m.label }}</dt><dd>{{ m.value }}</dd></div>
                  }
                </dl>
              </details>
            } @else {
              <section class="group">
                <h3 class="fit-title">{{ g.title }}</h3>
                <dl class="metrics">
                  @for (m of g.rows; track m.label) {
                    <div><dt>{{ m.label }}</dt><dd>{{ m.value }}</dd></div>
                  }
                </dl>
              </section>
            }
          }
        </div>
      }

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
  `,
  styles: `
    :host { display: grid; gap: 0.9rem; padding: 0.9rem 0.25rem 1.1rem; }
    .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .type, .notable { padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.82rem; font-weight: 600; }
    .type .dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--c); margin-right: 0.4rem; vertical-align: 0.05em; }
    .type { border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
    .notable { background: var(--accent-soft); color: var(--accent-text); }
    app-route-map { --map-h: 320px; }
    @media (max-width: 800px) { app-route-map { --map-h: 240px; } }
    .groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 0.9rem 1.25rem; align-items: start; }
    .group { display: grid; gap: 0.5rem; margin: 0; }
    h3.fit-title { margin: 0; font-weight: 400; }
    details.fold > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 0.4rem; min-height: 32px; }
    details.fold > summary::-webkit-details-marker { display: none; }
    details.fold > summary::after { content: ''; width: 0.4rem; height: 0.4rem; margin-left: auto; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(45deg); transition: transform var(--dur, 0.2s); }
    details.fold[open] > summary::after { transform: rotate(-135deg); }
    details.fold[open] > summary { margin-bottom: 0.5rem; }
    @media (min-width: 801px) {
      details.fold > summary { pointer-events: none; }
      details.fold > summary::after { display: none; }
    }
    .body { display: grid; gap: 0.8rem; align-content: start; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.5rem; margin: 0; }
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

  /** Téléphone : les groupes secondaires démarrent repliés */
  protected readonly compact = signal(typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches);

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

  /**
   * Chiffres regroupés. Distance (précise), durée et allure moyenne sont dans l'en-tête de la page, le départ dans sa date :
   * seule la distance au centième est gardée ici.
   */
  protected readonly groups = computed(() => {
    const a = this.activity();
    const f = a.fit;
    const tr = trimp(a, this.sci.athlete());
    const caps = this.sci.caps();
    type Row = { label: string; value: string };
    const groups: { id: string; title: string; fold: boolean; rows: Row[] }[] = [
      {
        id: 'allure', title: 'Allure', fold: false,
        rows: [
          { label: 'Distance', value: `${num(a.distanceKm, 2)} km` },
          ...(f ? [{ label: 'Allure plat équiv.', value: `${pace(a.durationSec / (f.gapDistance / 1000))} /km` }] : []),
          { label: 'Meilleur km', value: a.bestKmSec ? `${pace(a.bestKmSec)} /km` : '–' },
          { label: 'D+ / D−', value: a.elevGain != null ? `${a.elevGain} / ${a.elevLoss ?? '–'} m` : '–' },
          ...(a.kind === 'trail' || (a.elevGain ?? 0) > 300 ? [{ label: 'Km-effort', value: num(kmEffort(a), 1) }] : []),
        ],
      },
      {
        id: 'cardio', title: 'Cardio', fold: false,
        rows: [
          { label: 'FC moy. / max', value: a.avgHr ? `${a.avgHr}${f?.maxHr ? ' / ' + f.maxHr : ''} bpm` : '–' },
          ...(f?.decoupling != null ? [{ label: 'Découplage', value: `${num(f.decoupling, 1)} %` }] : []),
          { label: 'TRIMP', value: tr != null ? num(tr) : '–' },
        ],
      },
      {
        id: 'foulee', title: 'Foulée', fold: true,
        rows: [
          { label: 'Cadence', value: a.cadence ? `${a.cadence} ppm` : '–' },
          { label: 'Foulée', value: a.stride ? `${num(a.stride, 2)} m` : '–' },
          { label: 'Puissance', value: a.power ? `${a.power} W` : '–' },
        ],
      },
      {
        id: 'charge', title: 'Charge', fold: true,
        rows: [
          // Sans COROS, la charge est déjà le TRIMP (build-data) : une seule ligne
          ...(caps.corosLoad ? [{ label: caps.loadLabel, value: a.trainingLoad != null ? String(a.trainingLoad) : '–' }] : []),
          ...(caps.trainingEffect
            ? [
                { label: 'TE aéro / anaéro', value: a.aerobicTE != null ? `${num(a.aerobicTE, 1)} / ${num(a.anaerobicTE ?? 0, 1)}` : '–' },
                { label: 'Focus', value: a.focus ? (FOCUS[a.focus] ?? a.focus) : '–' },
              ]
            : []),
          { label: 'Calories', value: a.calories ? `${num(a.calories)} kcal` : '–' },
        ],
      },
    ];
    // Un groupe sans aucune valeur ne s'affiche pas
    return groups.filter((g) => g.rows.some((r) => r.value !== '–'));
  });
}
