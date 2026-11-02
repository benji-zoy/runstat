import { Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { GoalEvaluation } from '../core/goals';
import { clock, fixed, num, pace } from '../core/format';
import { parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const TONE: Record<string, string> = { good: 'var(--good)', neutral: 'var(--series-1)', warning: 'var(--warning)', serious: 'var(--serious)' };

/**
 * Carte d'un objectif : indice de confiance, chrono probable, stratégie, préparation et conseils.
 * `archived` : objectif terminé (Objectifs › Archives) — l'indice est celui de la veille, sans en-tête ni conseils.
 */
@Component({
  selector: 'app-goal-card',
  imports: [ChartComponent],
  template: `
    @let e = ev();
    @let g = e.goal;
    <section class="card goal">
      @if (!archived()) {
        <header>
          <div>
            <h3>{{ g.name }}</h3>
            <p class="muted">
              {{ longDate(g.date) }}{{ g.startTime ? ' · départ ' + startLabel(g.startTime) : '' }} ·
              {{ num(g.distanceKm, 1) }} km{{ g.elevGain ? ' · ' + num(g.elevGain) + ' m D+' + (g.elevLoss ? ' / ' + num(g.elevLoss) + ' m D−' : '') : '' }}
              @if (g.kind === 'trail') {
                · {{ num(e.ke) }} km-effort
              }
            </p>
          </div>
          <span class="countdown display">{{ e.daysLeft > 0 ? 'J-' + e.daysLeft : e.daysLeft === 0 ? 'Jour J' : 'Terminé' }}</span>
        </header>
      }

      <div class="top">
        <div class="gauge" [style.--tone]="tone(e)">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="52" class="track" />
            <circle cx="60" cy="60" r="52" class="value" [attr.stroke-dasharray]="dash(e.index)" />
          </svg>
          <div class="gauge-text">
            <span class="display big">{{ e.index }}<small>{{ e.probability !== null ? '%' : '/100' }}</small></span>
            <span class="verdict">{{ e.verdict.label }}</span>
          </div>
          <p class="gauge-caption">
            @if (e.probability !== null) {
              de chances de passer sous <b>{{ clock(g.targetSec!) }}</b> ({{ pace(g.targetSec! / g.distanceKm) }} /km)
              @if (e.stretchProbability !== null) {
                <br />{{ round(e.stretchProbability * 100) }} % sous <b>{{ clock(g.stretchSec!) }}</b>
              }
              @if (g.kind === 'trail') {
                <br />préparation {{ round(e.readinessScore * 100) }}/100
                @if (e.daysLeft > 21 && e.readinessProjected > e.readinessScore + 0.01) {
                  → <b>{{ round(e.readinessProjected * 100) }}</b> si tu suis les conseils
                }
              }
            } @else {
              indice de préparation pour finir
              @if (e.daysLeft > 21 && e.readinessProjected > e.readinessScore + 0.01) {
                <br />→ <b>{{ round(e.readinessProjected * 100) }}/100</b> si tu suis les conseils d'ici l'affûtage
              }
            }
          </p>
        </div>

        <div class="prediction">
          <span class="label">Chrono le plus probable</span>
          <span class="display pred">{{ clock(e.predicted) }}</span>
          <span class="muted">{{ pace(e.predicted / g.distanceKm) }} /km · 8 chances sur 10 entre {{ clock(e.low) }} et {{ clock(e.high) }}</span>
          <app-chart [config]="chart()" style="--chart-h: 170px" />
        </div>
      </div>

      @if (e.raceRefs.length) {
        <h4>{{ g.kind === 'trail' ? 'Tes trails les plus proches' : 'Tes courses sur la distance' }} <small class="muted">· prises en compte dans l'indice</small></h4>
        <div class="table-wrap">
          <table class="refs">
            <thead>
              <tr>
                <th>Course</th>
                <th class="num">Temps</th>
                <th class="num">{{ g.kind === 'trail' ? 'Par km-effort' : 'Allure' }}</th>
                <th class="num">FC</th>
                <th class="num">Météo</th>
                @if (g.kind === 'road') {
                  <th class="num">2e moitié</th>
                  @if (g.targetSec) {
                    <th class="num">Objectif</th>
                  }
                }
              </tr>
            </thead>
            <tbody>
              @for (r of e.raceRefs; track r.activity.id) {
                <tr>
                  <td>{{ r.activity.name }} <small class="muted">· {{ shortDate(r.activity.date) }}</small></td>
                  <td class="num">{{ clock(r.activity.durationSec) }}</td>
                  <td class="num">{{ pace(r.pace) }}</td>
                  <td class="num">{{ r.activity.avgHr ?? '–' }}@if (r.hrPct) {<small class="muted"> · {{ round(r.hrPct * 100) }} %</small>}</td>
                  <td class="num">{{ r.activity.weather ? round(r.activity.weather.temp) + ' °C' : '–' }}</td>
                  @if (g.kind === 'road') {
                    <td class="num">{{ r.splitDiff === null ? '–' : (r.splitDiff >= 0 ? '+' : '−') + num(Math.abs(r.splitDiff)) + ' s/km' }}</td>
                    @if (g.targetSec) {
                      @let gap = r.activity.durationSec - g.targetSec;
                      <td class="num" [class.faster]="gap > 0">{{ gap > 0 ? '−' + clock(gap) : 'déjà fait' }}</td>
                    }
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if (e.progression; as p) {
        <div class="progression">
          <p class="prog-head">
            <b>Ton niveau projeté depuis {{ p.reference.name }}</b>
            <span class="muted">· la course donne la base, l'entraînement fait depuis la projette à aujourd'hui</span>
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th class="num">8 sem. avant</th>
                  <th class="num">8 dernières sem.</th>
                  <th class="num">Effet sur le temps</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Chrono de base <small class="muted">· sans la chaleur du jour</small></td>
                  <td class="num">{{ clock(p.reference.durationSec) }}</td>
                  <td></td>
                  <td class="num">{{ clock(p.neutral) }}</td>
                </tr>
                @for (r of p.rows; track r.label) {
                  <tr [class.ctx]="r.factor === null">
                    <td class="wrap">{{ r.label }} <small class="muted">· {{ r.note }}</small></td>
                    <td class="num">{{ r.before }}</td>
                    <td class="num">{{ r.now }}</td>
                    <td class="num" [class.better]="r.factor !== null && r.factor < 0.995">{{ r.factor === null ? 'contexte' : signedPct(r.factor - 1) }}</td>
                  </tr>
                }
                <tr class="total">
                  <td class="wrap">Niveau projeté <small class="muted">· volume × moyenne de l'allure et de l'efficacité (deux mesures du même progrès){{ p.factor === 0.9 || p.factor === 1.1 ? ', plafonné à ±10 %' : '' }}</small></td>
                  <td></td>
                  <td class="num">{{ signedPct(p.factor - 1) }}</td>
                  <td class="num">{{ clock(p.projected) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      }

      <h4>Stratégie de course</h4>
      <div class="pacing">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tronçon</th>
                @if (g.targetSec) {
                  <th class="num">Objectif</th>
                }
                <th class="num">Probable</th>
              </tr>
            </thead>
            <tbody>
              @for (s of e.plan.segments; track s.label) {
                <tr>
                  <td class="wrap">
                    <b>{{ s.label }}</b><small class="muted seg-km">km {{ num(s.from, 1) }} → {{ num(s.to, 1) }}</small>
                    <small class="muted tip">{{ s.tip }}</small>
                  </td>
                  @if (s.target !== null) {
                    <td class="num">{{ pace(s.target) }} /km</td>
                  }
                  <td class="num">{{ pace(s.realistic) }} /km</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Passage</th>
                @if (g.targetSec) {
                  <th class="num">{{ clock(g.targetSec) }}</th>
                }
                <th class="num">{{ clock(e.predicted) }}</th>
              </tr>
            </thead>
            <tbody>
              @for (c of e.plan.checkpoints; track c.km) {
                <tr>
                  <td>{{ $last ? 'Arrivée' : 'km ' + num(c.km) }}</td>
                  @if (c.target !== null) {
                    <td class="num">{{ clock(c.target) }}</td>
                  }
                  <td class="num">{{ clock(c.realistic) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      @if (e.plan.watch; as w) {
        <p class="watch">
          ⌚ Ta montre mesure environ <b>{{ fixed(w.drift * 100, 1) }} %</b> de trop sur la distance ({{ w.from }}). En croisière, l'allure affichée
          doit donc être <b>{{ pace(w.shown) }} /km</b> pour {{ pace(w.actual) }} /km réels.
          Fie-toi plutôt aux panneaux kilométriques.
        </p>
      } @else if (g.kind === 'trail') {
        <p class="muted small">Temps de passage indicatifs, en supposant le dénivelé réparti uniformément : recale-les sur le profil et les barrières horaires de la course.</p>
      }

      <div class="blocks">
        @for (b of e.plan.blocks; track b.title) {
          <div class="block">
            <h5>{{ b.title }}</h5>
            <ul>
              @for (i of b.items; track $index) {
                <li>{{ i }}</li>
              }
            </ul>
          </div>
        }
      </div>

      <div class="cols">
        <div>
          <h4>Modèles</h4>
          <div class="table-wrap">
            <table>
              <tbody>
                @for (m of e.models; track $index) {
                  <tr>
                    <td>{{ m.label }}@if (m.weight < 1) {<small class="muted"> · poids {{ fixed(m.weight, 2) }}</small>}<small class="muted note-inline">{{ m.note }}</small></td>
                    <td class="num">{{ clock(m.seconds) }}</td>
                    <td class="wrap small muted note">{{ m.note }}</td>
                  </tr>
                }
                <tr class="total">
                  <td>Consensus</td>
                  <td class="num">{{ clock(e.base) }}</td>
                  <td class="wrap small muted note">moyenne géométrique pondérée</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h4>Ajustements du jour J</h4>
          @for (a of e.adjustments; track a.label) {
            <div class="adj">
              <span>{{ a.label }}</span>
              <b [class.slower]="a.pct > 0.05">{{ a.pct > 0.05 ? '+' + fixed(a.pct, 1) + ' %' : 'neutre' }}</b>
              @if (a.pct > 0.05) {
                <span class="muted">+{{ clock(e.base * a.pct / 100) }}</span>
              }
              <p class="muted">{{ a.note }}</p>
            </div>
          } @empty {
            <p class="muted">Aucun : la fraîcheur, la récupération et la météo sont prises en compte dans les 3 semaines précédant la course (météo : 15 jours avant).</p>
          }
        </div>
      </div>

      <h4>Préparation <small class="muted">{{ round(e.readinessScore * 100) }}/100</small></h4>
      <div class="ready">
        @for (r of e.readiness; track r.label) {
          <div class="ready-row">
            <span class="ready-label">{{ r.label }}</span>
            <div class="bar" [title]="'Objectif : ' + r.target">
              <span class="proj" [style.width.%]="r.projected * 100"></span>
              <span class="now" [style.width.%]="r.score * 100" [attr.data-tone]="r.score >= 0.95 ? 'good' : r.score >= 0.6 ? 'warning' : 'serious'"></span>
            </div>
            <span class="ready-value">{{ r.value }} <small class="muted">/ {{ r.target }}</small></span>
          </div>
        }
        @if (e.daysLeft > 21) {
          <p class="muted legend"><span class="sw now"></span> aujourd'hui <span class="sw proj"></span> atteignable avant l'affûtage</p>
        }
      </div>

      @if (e.advice.length && !archived()) {
        <h4>Conseils</h4>
        <ul class="advice">
          @for (a of e.advice; track a) {
            <li>{{ a }}</li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .goal { display: grid; gap: 1.1rem; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    header h3 { color: var(--text-primary); font-family: var(--font-display); font-stretch: var(--display-stretch); font-weight: 800; text-transform: uppercase; font-size: 1.8rem; line-height: 1; }
    header p { margin: 0.2rem 0 0; }
    .countdown { font-size: 2.2rem; color: var(--accent); white-space: nowrap; }
    h4 { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .top { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 1.5rem; align-items: center; }
    @media (max-width: 700px) { .top { grid-template-columns: minmax(0, 1fr); } }
    .gauge { position: relative; display: grid; justify-items: center; gap: 0.4rem; }
    .gauge svg { width: 170px; height: 170px; transform: rotate(-90deg); }
    .gauge circle { fill: none; stroke-width: 10; }
    .gauge .track { stroke: var(--surface-3); }
    .gauge .value { stroke: var(--tone); stroke-linecap: round; transition: stroke-dasharray 0.6s; }
    .gauge-text { position: absolute; top: 0; height: 170px; display: grid; place-content: center; text-align: center; }
    .big { font-size: 3.2rem; }
    .big small { font-size: 1.2rem; margin-left: 2px; }
    .verdict { font-weight: 600; color: var(--tone); }
    .gauge-caption { margin: 0; text-align: center; font-size: 0.85rem; color: var(--text-secondary); }
    .prediction { display: grid; gap: 0.25rem; min-width: 0; }
    .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .pred { font-size: 2.6rem; }
    .cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1.5rem; }
    @media (max-width: 900px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    .cols > div { display: grid; gap: 0.5rem; align-content: start; min-width: 0; }
    td { padding: 0.4rem 0.5rem; }
    tr.total td { font-weight: 700; border-bottom: none; }
    .note-inline { display: none; }
    @media (max-width: 600px) {
      td.note { display: none; }
      td:first-child { white-space: normal; }
      .note-inline { display: block; font-size: 0.78rem; margin-top: 0.1rem; }
    }
    .adj { display: grid; grid-template-columns: 1fr auto auto; gap: 0 0.6rem; align-items: baseline; padding: 0.45rem 0; border-bottom: 1px solid var(--border); }
    .adj p { grid-column: 1 / -1; margin: 0.15rem 0 0; font-size: 0.8rem; }
    .adj .slower { color: var(--serious); }
    .ready { display: grid; gap: 0.55rem; }
    .ready-row { display: grid; grid-template-columns: 13rem minmax(0, 1fr) 15rem; gap: 0.8rem; align-items: center; font-size: 0.9rem; }
    @media (max-width: 700px) {
      .ready-row { grid-template-columns: minmax(0, 1fr) auto; }
      .ready-row .bar { grid-column: 1 / -1; grid-row: 2; }
    }
    .ready-value { font-variant-numeric: tabular-nums; }
    .bar { position: relative; height: 10px; border-radius: 5px; background: var(--surface-3); overflow: hidden; }
    .bar span { position: absolute; inset: 0 auto 0 0; border-radius: 5px; }
    .bar .proj { background: color-mix(in srgb, var(--good) 45%, var(--surface-3)); }
    .bar .now[data-tone='good'] { background: var(--good); }
    .bar .now[data-tone='warning'] { background: var(--warning); }
    .bar .now[data-tone='serious'] { background: var(--serious); }
    .legend { margin: 0; font-size: 0.78rem; display: flex; align-items: center; gap: 0.4rem; }
    .sw { display: inline-block; width: 12px; height: 8px; border-radius: 3px; background: var(--warning); }
    .sw.proj { background: color-mix(in srgb, var(--good) 45%, var(--surface-3)); margin-left: 0.6rem; }
    .advice { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.4rem; color: var(--text-secondary); }
    .refs .faster { color: var(--warning); }
    .progression { display: grid; gap: 0.4rem; padding: 0.8rem 1rem; border-radius: 10px; background: var(--surface-2); }
    .prog-head { margin: 0; font-size: 0.92rem; }
    .progression td.wrap { white-space: normal; }
    .progression tr.ctx td { color: var(--text-muted); }
    .progression .better { color: var(--good); }
    .pacing { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1.5rem; align-items: start; }
    @media (max-width: 900px) { .pacing { grid-template-columns: minmax(0, 1fr); } }
    .pacing td.wrap { white-space: normal; }
    .seg-km { margin-left: 0.45rem; white-space: nowrap; }
    .tip { display: block; margin-top: 0.15rem; font-size: 0.8rem; line-height: 1.35; }
    .watch { margin: 0; padding: 0.6rem 0.8rem; border-radius: 8px; background: var(--surface-2); font-size: 0.9rem; color: var(--text-secondary); }
    .watch b { color: var(--text-primary); }
    .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 0.8rem; }
    .block { padding: 0.9rem 1rem; border-radius: 10px; background: var(--surface-2); display: grid; gap: 0.5rem; align-content: start; }
    .block h5 { margin: 0; font-size: 0.95rem; color: var(--text-primary); }
    .block ul { margin: 0; padding-left: 1.1rem; display: grid; gap: 0.35rem; font-size: 0.88rem; color: var(--text-secondary); line-height: 1.4; }
  `,
})
export class GoalCardComponent {
  readonly ev = input.required<GoalEvaluation>();
  readonly archived = input(false);

  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly round = Math.round;
  protected readonly Math = Math;
  protected signedPct = (x: number) => `${x > 0 ? '+' : '−'}${fixed(Math.abs(x * 100), 1)} %`;
  protected shortDate = (iso: string) => parseDay(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  protected longDate = (iso: string) => dateFmt.format(parseDay(iso));
  protected startLabel = (t: string) => (t === '00:00' ? 'à minuit' : `${Number(t.slice(0, 2))} h ${t.slice(3)}`);
  protected tone = (e: GoalEvaluation) => TONE[e.verdict.tone];
  /** Arc de la jauge : circonférence 2π·52 ≈ 326,7 */
  protected dash = (pct: number) => `${(Math.max(0, Math.min(100, pct)) / 100) * 326.7} 326.7`;

  protected readonly chart = computed(() => this.buildChart(this.ev()));

  /** Densité log-normale du temps final, zone sous l'objectif colorée, modèles en points */
  private buildChart(e: GoalEvaluation): ChartConfiguration {
    const target = e.goal.targetSec ?? null;
    const lo = Math.min(e.low * 0.94, ...(target ? [target * 0.98] : []), ...e.models.map((m) => m.seconds * 0.98));
    const hi = Math.max(e.high * 1.06, ...(target ? [target * 1.02] : []), ...e.models.map((m) => m.seconds * 1.02));
    const pdf = (t: number) => Math.exp(-((Math.log(t / e.predicted) / e.sigma) ** 2) / 2) / (t * e.sigma * Math.sqrt(2 * Math.PI));
    const xs = Array.from({ length: 121 }, (_, i) => lo + ((hi - lo) * i) / 120);
    const peak = pdf(e.predicted);
    const pts = xs.map((x) => ({ x, y: pdf(x) / peak }));
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: target ? 'Sous l\'objectif' : 'Temps probable',
            data: pts.map((p) => ({ x: p.x, y: !target || p.x <= target ? p.y : null })),
            borderColor: C.accent,
            backgroundColor: alpha(C.accent, 0.35),
            fill: 'origin',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
          ...(target
            ? [{
                label: 'Au-delà',
                data: pts.map((p) => ({ x: p.x, y: p.x >= target ? p.y : null })),
                borderColor: C.muted,
                backgroundColor: alpha(C.muted, 0.18),
                fill: 'origin' as const,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.3,
              }, {
                label: 'Objectif',
                data: [{ x: target, y: 0 }, { x: target, y: 1.08 }],
                borderColor: C.text,
                borderDash: [4, 4],
                borderWidth: 1.5,
                pointRadius: 0,
              }]
            : []),
          {
            type: 'scatter' as const,
            label: 'Modèles',
            data: e.models.map((m) => ({ x: m.seconds, y: 0.04, name: m.label })),
            backgroundColor: C.s1,
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
          x: { type: 'linear', min: lo, max: hi, ticks: { callback: (v) => clock(Number(v)).replace(/:\d\d$/, ''), maxTicksLimit: 8 }, grid: { display: false } },
          y: { display: false, min: 0, max: 1.1 },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (i) => i.dataset.label === 'Modèles' || i.dataset.label === 'Objectif',
            callbacks: {
              title: () => '',
              label: (c) => {
                const raw = c.raw as { x: number; name?: string };
                return raw.name ? ` ${raw.name} : ${clock(raw.x)}` : ` Objectif : ${clock(raw.x)}`;
              },
            },
          },
        },
      },
    };
  }
}
