import { Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { GoalEvaluation, chanceVerdict } from '../core/goals';
import { courseProfile } from '../core/course';
import { clock, fixed, num, pace } from '../core/format';
import { parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const TONE: Record<string, string> = { good: 'var(--good)', neutral: 'var(--series-1)', warning: 'var(--warning)', serious: 'var(--serious)' };

/** Partie de la fiche d'un objectif (Courses › objectif) */
export type GoalPart = 'chrono' | 'references' | 'strategie' | 'modeles' | 'ajustements' | 'preparation' | 'conseils';

/**
 * Une partie de la fiche d'un objectif : indice et chrono probable, courses de référence, stratégie, modèles,
 * ajustements, préparation ou conseils. `archived` : objectif terminé, l'indice est celui de la veille.
 */
@Component({
  selector: 'app-goal-card',
  imports: [ChartComponent],
  template: `
    @let e = ev();
    @let g = e.goal;
    <section class="goal" [class.card]="framed()">
      @if (part() === 'chrono') {
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
                <br />{{ round(e.stretchProbability * 100) }} % sous <b>{{ clock(g.stretchSec!) }}</b> · {{ lower(chanceVerdict(e.stretchProbability).label) }}
              }
              @if (g.kind === 'trail') {
                <br />préparation {{ round(e.readinessScore * 100) }}/100
                @if ((e.daysLeft > 21 || e.plannedPrep) && e.readinessProjected > e.readinessScore + 0.01) {
                  → <b>{{ round(e.readinessProjected * 100) }}</b> {{ e.plannedPrep ? 'avec ton calendrier' : 'si tu suis les conseils' }}
                }
              }
            } @else {
              indice de préparation pour finir
              @if ((e.daysLeft > 21 || e.plannedPrep) && e.readinessProjected > e.readinessScore + 0.01) {
                <br />→ <b>{{ round(e.readinessProjected * 100) }}/100</b> {{ e.plannedPrep ? 'avec les séances prévues' : 'si tu suis les conseils' }} d'ici l'affûtage
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
      }

      @if (part() === 'references') {
      @if (e.raceRefs.length) {
        <h4>{{ g.kind === 'trail' ? 'Tes trails les plus proches' : 'Tes courses sur la distance' }} <small class="muted">· prises en compte dans l'indice</small></h4>
        <div class="table-wrap">
          <table class="refs">
            <thead>
              <tr>
                <th>Course</th>
                <th class="num">Temps</th>
                <th class="num">{{ g.kind === 'trail' ? 'Par km éq. plat' : 'Allure' }}</th>
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

      }

      @if (part() === 'strategie') {
      @if (profileChart(); as pc) {
        <app-chart [config]="pc" style="--chart-h: 150px" />
      }
      <div class="pacing" [class.stack]="g.kind === 'trail' && e.plan.fromGpx">
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
                    <b>{{ s.label }}</b><small class="muted seg-km">km {{ num(s.from, 1) }} → {{ num(s.to, 1) }}@if (s.gain !== undefined) { · +{{ num(s.gain) }} / −{{ num(s.loss ?? 0) }} m}</small>
                    <small class="muted tip">{{ s.tip }}</small>
                  </td>
                  @if (s.target !== null) {
                    <td class="num">@if (s.targetSec != null) {{{ hm(s.targetSec) }}<br /><small class="muted">{{ pace(s.target) }} /km</small>} @else {{{ pace(s.target) }} /km}</td>
                  }
                  <td class="num">@if (s.realisticSec != null) {{{ hm(s.realisticSec) }}<br /><small class="muted">{{ pace(s.realistic) }} /km</small>} @else {{{ pace(s.realistic) }} /km}</td>
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
                  <td class="wrap">{{ $last ? 'Arrivée' : c.name ?? 'km ' + num(c.km) }}@if (c.name && !$last) {<small class="muted"> · km {{ num(c.km, 1) }}</small>}</td>
                  @if (c.target !== null) {
                    <td class="num">{{ clock(c.target) }}@if (e.plan.startMin !== null) {<br /><small class="muted">{{ hourOf(e.plan.startMin, c.target) }}</small>}</td>
                  }
                  <td class="num">{{ clock(c.realistic) }}@if (e.plan.startMin !== null) {<br /><small class="muted">{{ hourOf(e.plan.startMin, c.realistic) }}</small>}</td>
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
      } @else if (e.plan.fromGpx) {
        <p class="muted small">
          Temps de passage calés sur le profil du tracé : chaque tronçon au coût de sa pente pour toi,
          @if (g.kind === 'trail') {
            avec ton usure, la nuit et les arrêts aux points de passage.
          } @else {
            avec le plan d’allure.
          }
          Compare-les aux barrières horaires.
        </p>
      } @else if (g.kind === 'trail') {
        <p class="muted small">Temps de passage indicatifs, dénivelé réparti uniformément : importe le GPX de la course (Modifier l'objectif) pour les caler sur le vrai profil et ses ravitaillements.</p>
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

      }

      @if (part() === 'modeles') {
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
          <p class="muted small">
            Incertitude ±{{ fixed(e.sigma * 100, 1) }} % (un écart-type) : modèles {{ fixed(e.uncertainty.models * 100, 1) }} %,
            jour de course {{ fixed(e.uncertainty.day * 100, 1) }} %@if (e.uncertainty.extrapolation > 0.001) {, au-delà de ta plus longue sortie {{ fixed(e.uncertainty.extrapolation * 100, 1) }} %}.
          </p>
          <details class="method">
            <summary>Méthode</summary>
            <p>{{ e.method }}</p>
            @if (g.kind === 'trail' && e.course.terrain.points.length) {
              <p>
                Ta courbe de pente ({{ e.course.terrain.trail ? 'trails' : 'toutes sorties' }}, {{ num(e.course.terrain.hours) }} h de FIT sur un an, à FC égale) :
                @for (pt of e.course.terrain.points; track pt.grade) {
                  {{ signedGrade(pt.grade) }} ×{{ fixed(pt.cost, 2) }}{{ $last ? '.' : ',' }}
                }
                Repère commun : Minetti en montée, GAP révisé de Strava en descente (le gain plafonne vers −9 %).
                @if (e.course.terrain.surface; as sf) {
                  Sur les sentiers, tu es {{ fixed((sf - 1) * 100, 0) }} % plus lent que sur route à FC égale.
                }
              </p>
            }
            <p>Probabilité : loi log-normale centrée sur le chrono le plus probable. Moins de 10 % : hors de portée ; 10 à 25 % : ambitieux ; 25 à 50 % : jouable ; 50 à 75 % : probable ; au-delà : très probable.</p>
          </details>
      }

      @if (part() === 'ajustements') {
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
      }

      @if (part() === 'preparation') {
      <div class="ready">
        @for (r of e.readiness; track r.label) {
          <div class="ready-row">
            <span class="ready-label">{{ r.label }}</span>
            <div class="bar" [title]="'Objectif : ' + r.target">
              <span class="proj" [style.width.%]="r.projected * 100"></span>
              <span class="now" [style.width.%]="r.score * 100" [attr.data-tone]="r.score >= 0.95 ? 'good' : r.score >= 0.6 ? 'warning' : 'serious'"></span>
            </div>
            <span class="ready-value">{{ r.value }} <small class="muted">/ {{ r.target }}</small>
              @if (r.planned) {
                <small class="planned">au calendrier : {{ r.planned }}</small>
              }
            </span>
          </div>
        }
        @if (e.daysLeft > 21 || e.plannedPrep) {
          <p class="muted legend"><span class="sw now"></span> aujourd'hui <span class="sw proj"></span>
            @if (e.plannedPrep) { avec les séances prévues, au début de l’affûtage } @else { atteignable avant l’affûtage }</p>
        }
      </div>
      @if (e.calendar?.sessions?.length) {
        <details class="method calendar">
          <summary>Séances prévues d'ici la course ({{ e.calendar!.sessions.length }})</summary>
          <table class="tbl">
            <tbody>
              @for (x of e.calendar!.sessions; track x.date + x.name) {
                <tr>
                  <td class="num">{{ dayLabel(x.date) }}</td>
                  <td>{{ x.name }}</td>
                  <td class="num">{{ x.distanceKm !== null ? fixed(x.distanceKm, 1) + ' km' : '' }}</td>
                  <td class="num">{{ x.durationSec ? hm(x.durationSec) : '' }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="muted small">Calendrier de la montre (COROS), relu à chaque synchro. Il sert à projeter ta fraîcheur le jour J
            et ce que ta préparation aura apporté au début de l'affûtage.</p>
        </details>
      }

      }

      @if (part() === 'conseils') {
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
    .ready-value .planned { display: block; color: var(--text-muted); }
    .calendar { margin-top: 0.8rem; }
    .calendar td { white-space: normal; }
    .calendar td.num { white-space: nowrap; }
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
    .pacing.stack { grid-template-columns: minmax(0, 1fr); }
    .pacing td.wrap { white-space: normal; }
    .seg-km { margin-left: 0.45rem; white-space: nowrap; }
    @media (max-width: 600px) {
      .pacing td.wrap { min-width: 0; }
      .seg-km { display: block; margin-left: 0; white-space: normal; }
    }
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
  readonly part = input.required<GoalPart>();
  /** Dans une carte à part (sinon : à l'intérieur d'une carte de la page) */
  readonly framed = input(false);

  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly round = Math.round;
  protected readonly Math = Math;
  protected signedPct = (x: number) => `${x > 0 ? '+' : '−'}${fixed(Math.abs(x * 100), 1)} %`;
  protected shortDate = (iso: string) => parseDay(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  protected tone = (e: GoalEvaluation) => TONE[e.verdict.tone];
  protected dayLabel = (iso: string) => parseDay(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  protected readonly chanceVerdict = chanceVerdict;
  protected lower = (s: string) => s.toLowerCase();
  protected signedGrade = (g: number) => `${g >= 0 ? '+' : '−'}${Math.abs(Math.round(g * 100))} %`;
  protected hm = (sec: number) => {
    const m = Math.round(sec / 60);
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  };
  /** Heure de passage : départ + temps écoulé */
  protected hourOf = (startMin: number, sec: number) => {
    const m = ((Math.round(startMin + sec / 60) % 1440) + 1440) % 1440;
    return `vers ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  };
  /** Arc de la jauge : circonférence 2π·52 ≈ 326,7 */
  protected dash = (pct: number) => `${(Math.max(0, Math.min(100, pct)) / 100) * 326.7} 326.7`;

  protected readonly chart = computed(() => this.buildChart(this.ev()));
  protected readonly profileChart = computed(() => this.buildProfile(this.ev()));

  /** Profil du tracé GPX, points de passage marqués */
  private buildProfile(e: GoalEvaluation): ChartConfiguration | null {
    const pts = courseProfile(e.goal);
    if (pts.length < 2) return null;
    const eleAt = (km: number) => pts[Math.min(pts.length - 1, Math.round((km / e.goal.distanceKm) * (pts.length - 1)))].ele;
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Altitude',
            data: pts.map((p) => ({ x: p.km, y: p.ele })),
            borderColor: C.accent,
            backgroundColor: alpha(C.accent, 0.18),
            fill: 'start',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            type: 'scatter' as const,
            label: 'Passages',
            data: e.course.waypoints.map((w) => ({ x: w.km, y: eleAt(w.km), name: w.name })),
            backgroundColor: C.s1,
            borderColor: C.surface,
            borderWidth: 2,
            pointRadius: 5,
          },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: e.goal.distanceKm, ticks: { callback: (v) => `${v} km`, maxTicksLimit: 9 }, grid: { display: false } },
          y: { ticks: { callback: (v) => `${v} m`, maxTicksLimit: 4 } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: () => '',
              label: (c) => {
                const raw = c.raw as { x: number; y: number; name?: string };
                return ` ${raw.name ? raw.name + ' · ' : ''}km ${num(raw.x, 1)} · ${Math.round(raw.y)} m`;
              },
            },
          },
        },
      },
    };
  }

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
