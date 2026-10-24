import { Component, computed, inject, signal } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { ScienceService } from '../core/science.service';
import {
  BranchId, BranchScore, GRID_DURATIONS, MatrixCell, MetricScore, MetricUnit, REF_TEMP, Sample, WINDOW_DAYS, WORLD_RECORDS, worldLevel,
  worldVdot,
} from '../core/matrix';
import { day, fixed, num, pace } from '../core/format';
import { parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const short = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
const signed = (x: number, d: 0 | 1 = 0) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), d)}`;
const hm = (h: number) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const DUR_LABELS: Record<number, string> = { 300: '5 min', 1200: '20 min', 3600: '1 h', 7200: '2 h', 10800: '3 h' };
const TODAY_COLOR = C.s1;
const THEN_COLOR = C.muted;

/** Valeur d'une métrique dans son unité */
export function formatValue(v: number | null, unit: MetricUnit): string {
  if (v === null) return '–';
  switch (unit) {
    case 'pace': return `${pace(1000 / v)} /km`;
    case 'vam': return `${num(v)} m/h`;
    case 'hours': return hm(v);
    case 'pct': return `${signed(v, 1)} %`;
    case 'bpmh': return `${signed(v, 1)} bpm/h`;
    case 'ef': return fixed(v, 2);
    case 'vo2': return fixed(v, 1);
    case 'bpm': return `${fixed(v, 1)} bpm`;
    case 'ms': return `${num(v)} ms`;
    case 'ratio': return fixed(v, 2);
  }
}

/** Runner Matrix : radar des six branches, détail des métriques et grille durée × terrain (Performance › Profil). */
@Component({
  selector: 'app-runner-matrix',
  imports: [ChartComponent],
  template: `
    @let m = sci.matrix();
    <section class="section">
      <h2>Runner Matrix <small>six branches · par rapport à ton propre historique</small></h2>
      <details class="method">
        <summary>Comment lire les notes</summary>
        <p>Chaque note est le <b class="txt">rang de ta forme actuelle parmi toutes tes périodes</b> depuis
        {{ firstDate() }} : 0 = ta période la plus faible, 100 = la meilleure. Elle te compare à toi-même, pas aux
        autres : 80 en montée et 60 en vitesse ne veut pas dire que tu montes mieux que tu ne cours vite. Les
        performances sont la meilleure valeur des {{ windowDays }} derniers jours : un effort que tu n'as pas refait
        récemment fait baisser la note.</p>
        <p><b class="txt">Lecture absolue</b> : pourcentage du niveau mondial, comme le classement par âge des vétérans
        (60 % = classe locale, 70 % régionale, 80 % nationale, 90 % mondiale). Étalon : la courbe des records du monde
        ({{ records() }}), qui retrouve ceux du 5 000 m au semi à ± 2 % ; la physiologie compare ta VO₂max au VDOT du record
        du marathon ({{ num(worldVdot()) }}). Montée, descente et résilience n'ont pas d'étalon mondial fiable.</p>
      </details>

      <div class="layout">
        <div class="card radar">
          <div class="mode" role="group" aria-label="Lecture du radar">
            <button type="button" [class.on]="mode() === 'rel'" [attr.aria-pressed]="mode() === 'rel'" (click)="mode.set('rel')">
              Relatif · ton historique
            </button>
            <button type="button" [class.on]="mode() === 'abs'" [attr.aria-pressed]="mode() === 'abs'" (click)="mode.set('abs')">
              Absolu · % du niveau mondial
            </button>
          </div>
          <app-chart [config]="radarChart()" />
          <p class="muted small legend-note">
            <span class="key" [style.background]="todayColor"></span> Aujourd'hui
            <span class="key dashed"></span> Il y a six mois ({{ fmtDate(m.then) }})
            @if (mode() === 'abs') {
              <span>· {{ noStandard() }} : pas d'étalon mondial</span>
            }
          </p>
        </div>

        <div class="branches" role="list">
          @for (b of m.branches; track b.id) {
            <button
              type="button"
              role="listitem"
              class="branch card"
              [class.active]="selected() === b.id"
              [attr.aria-pressed]="selected() === b.id"
              (click)="selected.set(b.id)"
            >
              <span class="b-name">{{ b.label }}</span>
              <span class="b-score display">{{ b.score === null ? '–' : num(b.score) }}</span>
              <span class="b-delta small">
                @if (b.score !== null && b.scoreThen !== null) {
                  {{ arrow(b.score - b.scoreThen) }} {{ signed(b.score - b.scoreThen) }} en 6 mois
                } @else {
                  <span class="muted">pas de comparaison</span>
                }
              </span>
              <span class="b-abs small">
                @if (b.abs !== null) {
                  Absolu <b class="txt">{{ num(b.abs) }} %</b> · {{ level(b.abs) }}
                } @else {
                  <span class="muted">Absolu : pas d'étalon</span>
                }
              </span>
              <span class="b-spark"><app-chart [config]="spark(b.id)" /></span>
              @if (b.confidence !== 'solide') {
                <span class="b-conf small muted">données {{ b.confidence }}s</span>
              }
            </button>
          }
        </div>
      </div>

      @if (branch(); as b) {
        <div class="card">
          <h3>{{ b.label }} <small class="muted">· {{ b.text }}</small></h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Métrique</th>
                  <th class="num">Aujourd'hui</th>
                  <th class="num">Il y a 6 mois</th>
                  <th class="num">Meilleure période</th>
                  <th class="num">Rang</th>
                  <th class="num">Niveau mondial</th>
                  <th>Fenêtre</th>
                </tr>
              </thead>
              <tbody>
                @for (x of b.metrics; track x.def.id) {
                  <tr>
                    <td class="wrap">
                      {{ x.def.label }}
                      @if (x.def.heatSlope != null) {
                        <span class="muted small"> · corrigé de la chaleur ({{ heatText(x) }}, ramené à {{ refTemp }} °C)</span>
                      }
                    </td>
                    <td class="num txt">{{ fmt(x.now, x.def.unit) }}</td>
                    <td class="num">{{ fmt(x.then, x.def.unit) }}</td>
                    <td class="num">{{ fmt(x.best, x.def.unit) }}</td>
                    <td class="num txt">{{ x.score === null ? '–' : num(x.score) }}</td>
                    <td class="num">
                      @if (x.absNow !== null) {
                        {{ num(x.absNow) }} %
                        <span class="muted small">
                          {{ level(x.absNow) }}@if (x.absThen !== null) { · {{ signed(x.absNow - x.absThen, 1) }} pt en 6 mois }
                        </span>
                      } @else {
                        <span class="muted">–</span>
                      }
                    </td>
                    <td class="wrap small muted">{{ windowText(x) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="muted small">Lecture absolue : {{ b.absolute }}</p>
        </div>
      }
    </section>

    <section class="section">
      <h2>Matrice durée × terrain <small>meilleur effort des {{ windowDays }} derniers jours face à ton record · fichiers FIT</small></h2>
      <p class="muted small">
        Plat : meilleure allure ajustée à la pente (Minetti) tenue pendant la durée. Montée et descente : plus grand D+ / D−
        cumulé pendant la durée, en mètres par heure (altimètre lissé, seuil d'1 m contre le bruit). La couleur donne
        le pourcentage de ton record ; sur le plat jusqu'à 2 h, la dernière ligne situe l'allure face aux records du
        monde. Survole une case pour voir les sorties.
      </p>
      <div class="card">
        <div class="table-wrap">
          <table class="matrix">
            <thead>
              <tr>
                <th></th>
                @for (d of durations; track d) {
                  <th class="num">{{ durLabel(d) }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of m.grid; track r.id) {
                <tr>
                  <th scope="row">{{ r.label }}</th>
                  @for (c of r.cells; track c.duration) {
                    <td class="cell" [attr.data-step]="step(c)" [attr.title]="cellTitle(c, r.unit)">
                      @if (c.best) {
                        <b>{{ fmt(c.now?.value ?? null, r.unit) }}</b>
                        <span class="pct">{{ c.ratio === null ? 'rien de récent' : num(c.ratio * 100) + ' % du record' }}</span>
                        @if (c.world != null) {
                          <span class="pct">{{ num(c.world) }} % mondial</span>
                        }
                      } @else {
                        <span class="pct">–</span>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="ramp small muted" aria-label="Légende des couleurs">
          @for (s of steps; track s.step) {
            <span class="swatch" [attr.data-step]="s.step"></span> {{ s.label }}
          }
        </p>
      </div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .small { font-size: 0.82rem; margin: 0; }
    .txt { color: var(--text-primary); }
    .intro { max-width: 70ch; }
    h3 small { font-family: var(--font-body); font-size: 0.8rem; font-weight: 400; text-transform: none; }
    .layout { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
    .radar { --chart-h: 360px; display: grid; gap: 0.5rem; align-content: start; }
    .legend-note { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.5rem; }
    .key { display: inline-block; width: 18px; height: 3px; border-radius: 2px; }
    .key.dashed { background: repeating-linear-gradient(90deg, ${THEN_COLOR} 0 4px, transparent 4px 7px); margin-left: 0.6rem; }
    .branches { display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); align-content: start; }
    .branch {
      display: grid; grid-template-columns: 1fr auto; gap: 0.2rem 0.5rem; text-align: left; cursor: pointer;
      color: inherit; font: inherit; padding: 0.8rem 0.9rem; transition: border-color 0.15s;
    }
    .branch:hover { border-color: var(--surface-3); }
    .branch.active { border-color: var(--accent); background: var(--accent-soft); }
    .b-name { font-weight: 600; font-size: 0.9rem; color: var(--text-secondary); }
    .b-score { font-size: 2rem; grid-row: span 2; align-self: center; }
    .b-delta { color: var(--text-secondary); }
    .b-abs { grid-column: 1 / -1; color: var(--text-secondary); }
    .b-spark { grid-column: 1 / -1; --chart-h: 44px; }
    .mode { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .mode button {
      font: inherit; font-size: 0.82rem; font-weight: 600; padding: 0.35rem 0.75rem; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-secondary);
    }
    .mode button.on { color: var(--text-primary); border-color: var(--accent); background: var(--accent-soft); }
    .b-conf { grid-column: 1 / -1; }
    table.matrix th[scope='row'] { text-transform: none; font-size: 0.85rem; color: var(--text-secondary); letter-spacing: 0; }
    td.cell { text-align: right; border: 2px solid var(--surface-1); border-radius: 8px; padding: 0.5rem 0.65rem; }
    td.cell b { display: block; font-size: 0.95rem; }
    td.cell .pct { display: block; font-size: 0.75rem; opacity: 0.85; }
    [data-step='1'] { background: var(--seq-1); color: var(--on-seq-lo); }
    [data-step='2'] { background: var(--seq-2); color: var(--on-seq-lo); }
    [data-step='3'] { background: var(--seq-3); color: var(--on-seq-lo); }
    [data-step='4'] { background: var(--seq-4); color: var(--on-seq-hi); }
    [data-step='5'] { background: var(--seq-5); color: var(--on-seq-hi); }
    [data-step='0'] { background: var(--surface-2); color: var(--text-muted); }
    .ramp { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.4rem; margin-top: 0.8rem; }
    .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 4px; margin-left: 0.5rem; }
  `,
})
export class RunnerMatrixSection {
  protected readonly sci = inject(ScienceService);
  protected readonly selected = signal<BranchId>('endurance');
  /** Radar : rang dans ton historique ou pourcentage du niveau mondial */
  protected readonly mode = signal<'rel' | 'abs'>('rel');
  protected readonly level = worldLevel;
  protected readonly noStandard = computed(() =>
    this.sci.matrix().branches.filter((b) => b.abs === null && b.absThen === null).map((b) => b.label).join(', '),
  );
  protected readonly records = computed(() => WORLD_RECORDS[this.sci.athlete().sex].map((r) => r.label).join(' ; '));
  protected readonly worldVdot = computed(() => worldVdot(this.sci.athlete().sex));
  protected readonly windowDays = WINDOW_DAYS;
  protected readonly refTemp = REF_TEMP;
  protected readonly durations = GRID_DURATIONS;
  protected readonly todayColor = TODAY_COLOR;
  protected readonly num = num;
  protected readonly signed = signed;
  protected readonly fmt = formatValue;
  protected readonly fmtDate = (d: Date) => day(d);
  protected readonly durLabel = (d: number) => DUR_LABELS[d] ?? `${d} s`;
  protected readonly arrow = (d: number) => (d >= 5 ? '▲' : d <= -5 ? '▼' : '▶');
  protected readonly steps = [
    { step: 1, label: '< 80 %' },
    { step: 2, label: '80–90 %' },
    { step: 3, label: '90–95 %' },
    { step: 4, label: '95–98 %' },
    { step: 5, label: '≥ 98 % du record' },
  ];

  protected readonly branch = computed<BranchScore | null>(() => this.sci.matrix().branches.find((b) => b.id === this.selected()) ?? null);
  protected readonly firstDate = computed(() => {
    const h = this.sci.matrix().history;
    return h.length ? day(h[0].date) : '–';
  });

  protected readonly radarChart = computed<ChartConfiguration>(() => {
    const abs = this.mode() === 'abs';
    // En absolu, seulement les branches qui ont un étalon : relier les autres dessinerait une forme fausse
    const bs = this.sci.matrix().branches.filter((b) => !abs || b.abs !== null || b.absThen !== null);
    const round = (x: number | null) => (x === null ? null : Math.round(x));
    const now = (b: BranchScore) => round(abs ? b.abs : b.score);
    const then = (b: BranchScore) => round(abs ? b.absThen : b.scoreThen);
    return {
      type: 'radar',
      data: {
        labels: bs.map((b) => b.label),
        datasets: [
          {
            label: 'Il y a six mois',
            data: bs.map(then),
            borderColor: THEN_COLOR,
            backgroundColor: 'transparent',
            borderDash: [4, 3],
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: THEN_COLOR,
            spanGaps: true,
          },
          {
            label: "Aujourd'hui",
            data: bs.map(now),
            borderColor: TODAY_COLOR,
            backgroundColor: alpha(C.s1, 0.18),
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: TODAY_COLOR,
            pointBorderColor: C.surface,
            pointBorderWidth: 2,
            spanGaps: true,
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label} : ${c.formattedValue}${abs ? ' % du niveau mondial' : ' / 100'}` } },
        },
        onClick: (_e, els) => {
          if (els.length) this.selected.set(bs[els[0].index].id);
        },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { stepSize: 25, backdropColor: 'transparent', color: C.muted, font: { size: 10 } },
            grid: { color: C.border },
            angleLines: { color: C.border },
            pointLabels: { color: C.neutral, font: { size: 13, weight: 600 } },
          },
        },
      },
    };
  });

  /** Évolution de la note d'une branche sur deux ans */
  private readonly sparks = computed(() => {
    const h = this.sci.matrix().history.slice(-104);
    const out = new Map<BranchId, ChartConfiguration>();
    for (const b of this.sci.matrix().branches) {
      out.set(b.id, {
        type: 'line',
        data: {
          labels: h.map((p) => short.format(p.date)),
          datasets: [
            {
              label: b.label,
              data: h.map((p) => (p.scores[b.id] === null ? null : Math.round(p.scores[b.id]!))),
              borderColor: TODAY_COLOR,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHitRadius: 6,
              tension: 0.3,
              spanGaps: false,
            },
          ],
        },
        options: {
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { label: (c) => `Note ${c.formattedValue}` } } },
          scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
        },
      });
    }
    return out;
  });
  protected spark = (id: BranchId) => this.sparks().get(id)!;

  /** Pente de chaleur dans l'unité de la métrique : « +0,24 %/°C » */
  protected heatText(x: MetricScore): string {
    const v = x.def.heatSlope ?? 0;
    const units: Partial<Record<MetricUnit, string>> = { pct: ' pt', bpmh: ' bpm/h', vo2: ' ml/kg/min' };
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), Math.abs(v) < 0.1 ? 3 : 2)}${units[x.def.unit] ?? ''} par °C`;
  }

  protected windowText(x: MetricScore): string {
    const d = x.def;
    const what = d.agg === 'best' ? `meilleure valeur sur ${d.windowDays} j` : `médiane sur ${d.windowDays} j`;
    if (x.now === null) return `${what} · pas assez de données (${x.n}/${d.minSamples})`;
    const src = x.source ? ` · ${x.source.name || 'sortie'}, ${day(parseDay(x.source.date))}` : ` · ${x.n} valeurs`;
    return what + src;
  }

  protected step(c: MatrixCell): number {
    if (c.ratio === null) return 0;
    const r = c.ratio;
    return r >= 0.98 ? 5 : r >= 0.95 ? 4 : r >= 0.9 ? 3 : r >= 0.8 ? 2 : 1;
  }

  protected cellTitle(c: MatrixCell, unit: MetricUnit): string {
    const line = (label: string, s: Sample | null) =>
      s ? `${label} : ${formatValue(s.value, unit)} — ${s.activity?.name || 'sortie'}, ${day(new Date(s.t))}` : `${label} : –`;
    const world = c.world != null ? `\nNiveau mondial : ${num(c.world)} % (${worldLevel(c.world)})` : '';
    return `${line(`${WINDOW_DAYS} derniers jours`, c.now)}\n${line('Record', c.best)}${world}`;
  }
}
