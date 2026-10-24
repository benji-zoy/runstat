import { Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { RaceDebrief } from '../core/debrief';
import { GoalEvaluation } from '../core/goals';
import { clock, fixed, num, pace } from '../core/format';
import { parseDay } from '../core/stats';
import { ChartComponent } from '../ui/chart';
import { C, alpha } from '../ui/palette';

const dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** Bilan d'un objectif terminé : résultat, déroulé km par km face au plan, analyse et leçons. */
@Component({
  selector: 'app-race-debrief',
  imports: [ChartComponent],
  template: `
    @let d = debrief();
    @let g = ev().goal;
    <section class="card debrief">
      <header>
        <div>
          <h3>{{ g.name }}</h3>
          <p class="muted">
            {{ longDate(g.date) }}{{ g.startTime ? ' · départ ' + startLabel(g.startTime) : '' }} · {{ num(g.distanceKm, 1) }} km
            {{ g.elevGain ? ' · ' + num(g.elevGain) + ' m D+' : '' }}
          </p>
        </div>
        @if (record()) {
          <span class="badge">🏆 Record</span>
        }
      </header>

      <div class="hero">
        <div class="time">
          <span class="label">Temps {{ d.fromChip ? 'officiel' : 'montre' }}</span>
          <span class="display big">{{ clock(d.official) }}</span>
          <span class="muted">
            {{ pace(d.pace) }} /km{{ g.kind === 'trail' ? '-effort' : '' }}
            @if (d.fromChip) {
              · montre {{ clock(d.activity.durationSec) }} pour {{ num(d.activity.distanceKm, 2) }} km
            }
          </span>
        </div>
        <div class="tiles">
          @if (g.targetSec) {
            <div class="tile" [attr.data-tone]="d.targetGap! <= 0 ? 'good' : 'warning'">
              <span class="label">Objectif {{ clock(g.targetSec) }}</span>
              <b>{{ d.targetGap! <= 0 ? 'Atteint · ' + gap(d.targetGap!) : 'Manqué de ' + clock(d.targetGap!) }}</b>
              @if (d.probability !== null) {
                <small class="muted">{{ round(d.probability * 100) }} % de chances la veille</small>
              }
            </div>
          }
          <div class="tile" [attr.data-tone]="d.predictedGap <= 0 ? 'good' : 'warning'">
            <span class="label">Prédiction de la veille {{ clock(ev().predicted) }}</span>
            <b>{{ gap(d.predictedGap) }}</b>
            <small class="muted">mieux que {{ round(d.beatShare * 100) }} % des scénarios</small>
          </div>
          @if (d.previous; as p) {
            @let diff = d.official - p.seconds;
            <div class="tile" [attr.data-tone]="diff <= 0 ? 'good' : 'warning'">
              <span class="label">{{ p.name }} · {{ shortDate(p.date) }}</span>
              <b>{{ gap(diff) }}</b>
              <small class="muted">{{ clock(p.seconds) }} · {{ signedPct(diff / p.seconds) }}</small>
            </div>
          }
          @if (d.equivalents.length) {
            <div class="tile">
              <span class="label">VDOT de Daniels</span>
              <b>{{ fixed(d.vdot, 1) }}</b>
              <small class="muted">{{ equivalents() }}</small>
            </div>
          }
        </div>
      </div>

      @if (d.kms.length >= 3) {
        <div class="charts">
          <div>
            <h4>Kilomètre par kilomètre <small class="muted">· allure réelle (corrigée de l'écart GPS) et FC</small></h4>
            <app-chart [config]="kmChart()" style="--chart-h: 260px" />
          </div>
          <div>
            <h4>Avance ou retard sur le plan <small class="muted">· cumulé, en secondes</small></h4>
            <app-chart [config]="gapChart()" style="--chart-h: 260px" />
          </div>
        </div>
      }

      @if (d.segments.length) {
        <h4>Tronçons du plan</h4>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tronçon</th>
                @if (g.targetSec) {
                  <th class="num">Objectif</th>
                }
                <th class="num">Probable</th>
                <th class="num">Réalisé</th>
              </tr>
            </thead>
            <tbody>
              @for (s of d.segments; track s.label) {
                <tr>
                  <td><b>{{ s.label }}</b><small class="muted seg-km">km {{ num(s.from, 1) }} → {{ num(s.to, 1) }}</small></td>
                  @if (s.target !== null) {
                    <td class="num">{{ pace(s.target) }}</td>
                  }
                  <td class="num">{{ pace(s.predicted) }}</td>
                  <td class="num"><b [class.faster]="s.target !== null && s.actual <= s.target + 0.5">{{ pace(s.actual) }}</b></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <div class="blocks">
        @for (b of d.blocks; track b.title) {
          <div class="block">
            <h5>{{ b.title }}</h5>
            <ul>
              @for (i of b.items; track $index) {
                <li>{{ i }}</li>
              }
            </ul>
          </div>
        }
        @if (d.notes.length) {
          <div class="block">
            <h5>Ton ressenti</h5>
            <ul>
              @for (n of d.notes; track $index) {
                <li>{{ n }}</li>
              }
            </ul>
          </div>
        }
      </div>

      <h4>Leçons pour la suite</h4>
      <ul class="lessons">
        @for (l of d.lessons; track $index) {
          <li>{{ l }}</li>
        }
      </ul>

      <div class="cols">
        <div>
          <h4>Les modèles de la veille face au résultat</h4>
          <div class="table-wrap">
            <table>
              <tbody>
                @for (m of d.models; track m.label) {
                  <tr>
                    <td>{{ m.label }}<small class="muted note-inline">{{ m.note }}</small></td>
                    <td class="num">{{ clock(m.seconds) }}</td>
                    <td class="num" [class.close]="Math.abs(m.error) < 0.01">{{ signedPct(m.error) }}</td>
                  </tr>
                }
                <tr class="total">
                  <td>Prédiction (consensus ajusté)</td>
                  <td class="num">{{ clock(ev().predicted) }}</td>
                  <td class="num">{{ signedPct(ev().predicted / d.official - 1) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted small">Écart positif : le modèle te voyait plus lent que tu ne l'as été.</p>
        </div>

        <details class="kms">
          <summary>Détail des {{ d.kms.length }} km</summary>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Km</th>
                  <th class="num">Montre</th>
                  <th class="num">Réelle</th>
                  <th class="num">FC</th>
                  <th class="num">Cad.</th>
                  <th class="num">Foulée</th>
                  <th class="num">W</th>
                  @if (g.targetSec) {
                    <th class="num">vs obj.</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (k of d.kms; track k.km) {
                  <tr>
                    <td>{{ k.dist < 900 ? num(d.activity.distanceKm, 2) : k.km }}@if (k.gel) { <span title="Gel">🍌</span>}</td>
                    <td class="num">{{ pace(k.watchPace) }}</td>
                    <td class="num">{{ pace(k.realPace) }}</td>
                    <td class="num" [class.muted]="k.hrDoubtful" [title]="k.hrDoubtful ? 'Décrochage du capteur' : ''">{{ k.hr ?? '–' }}{{ k.hrDoubtful ? ' ?' : '' }}</td>
                    <td class="num">{{ k.cadence ?? '–' }}</td>
                    <td class="num">{{ k.stride ? fixed(k.stride, 2) : '–' }}</td>
                    <td class="num">{{ k.power ?? '–' }}</td>
                    @if (k.vsTarget !== null) {
                      <td class="num" [class.faster]="k.vsTarget <= 0">{{ gap(k.vsTarget) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .debrief { display: grid; gap: 1.1rem; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    header h3 { color: var(--text-primary); font-family: var(--font-display); font-weight: 800; text-transform: uppercase; font-size: 1.8rem; line-height: 1; }
    header p { margin: 0.2rem 0 0; }
    .badge { padding: 0.3rem 0.7rem; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 700; white-space: nowrap; }
    h4 { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    h4 small { text-transform: none; letter-spacing: 0; }
    .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .hero { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.5rem; align-items: center; }
    @media (max-width: 800px) { .hero { grid-template-columns: minmax(0, 1fr); } }
    .time { display: grid; gap: 0.2rem; }
    .big { font-size: 3.4rem; color: var(--accent); line-height: 1; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 0.6rem; }
    .tile { display: grid; gap: 0.2rem; padding: 0.7rem 0.85rem; border-radius: 10px; background: var(--surface-2); border-left: 3px solid var(--series-1); }
    .tile[data-tone='good'] { border-left-color: var(--good); }
    .tile[data-tone='warning'] { border-left-color: var(--warning); }
    .tile b { font-size: 1.15rem; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .tile small { font-size: 0.78rem; }
    .charts { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1.5rem; }
    @media (max-width: 900px) { .charts { grid-template-columns: minmax(0, 1fr); } }
    .charts > div { display: grid; gap: 0.5rem; min-width: 0; }
    td { padding: 0.4rem 0.5rem; }
    tr.total td { font-weight: 700; border-bottom: none; }
    .seg-km { margin-left: 0.45rem; white-space: nowrap; }
    .faster { color: var(--good); }
    .close { color: var(--good); font-weight: 700; }
    .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 0.8rem; }
    .block { padding: 0.9rem 1rem; border-radius: 10px; background: var(--surface-2); display: grid; gap: 0.5rem; align-content: start; }
    .block h5 { margin: 0; font-size: 0.95rem; color: var(--text-primary); }
    .block ul { margin: 0; padding-left: 1.1rem; display: grid; gap: 0.35rem; font-size: 0.88rem; color: var(--text-secondary); line-height: 1.4; }
    .lessons { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.5rem; color: var(--text-secondary); line-height: 1.45; }
    .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; align-items: start; }
    @media (max-width: 900px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    .cols > div { display: grid; gap: 0.5rem; min-width: 0; }
    .note-inline { display: block; font-size: 0.78rem; margin-top: 0.1rem; white-space: normal; }
    .small { font-size: 0.8rem; margin: 0; }
    .kms summary { cursor: pointer; font-weight: 600; margin-bottom: 0.5rem; }
  `,
})
export class RaceDebriefComponent {
  readonly ev = input.required<GoalEvaluation>();
  readonly debrief = input.required<RaceDebrief>();

  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly round = Math.round;
  protected readonly Math = Math;
  protected longDate = (iso: string) => dateFmt.format(parseDay(iso));
  protected shortDate = (iso: string) => shortFmt.format(parseDay(iso));
  protected startLabel = (t: string) => (t === '00:00' ? 'à minuit' : `${Number(t.slice(0, 2))} h ${t.slice(3)}`);
  protected signedPct = (x: number) => `${x > 0 ? '+' : '−'}${fixed(Math.abs(x * 100), 1)} %`;
  /** Écart de temps signé : −1:22 = plus rapide */
  protected gap = (sec: number) => `${sec <= 0 ? '−' : '+'}${clock(Math.abs(sec))}`;

  protected readonly record = computed(() => {
    const d = this.debrief();
    return d.previousBest !== null && d.official < d.previousBest;
  });
  protected readonly equivalents = computed(() =>
    this.debrief().equivalents.filter((x) => x.label !== 'Semi' || this.ev().goal.distanceKm > 25).map((x) => `${x.label} ${clock(x.seconds)}`).join(' · '),
  );

  /** Allure réelle par km et allures du plan (en haut, axe inversé), FC (bande du bas, axe de droite) */
  protected readonly kmChart = computed<ChartConfiguration>(() => {
    const d = this.debrief();
    const labels = d.kms.map((k) => (k.dist < 900 ? num(d.activity.distanceKm, 1) : String(k.km)));
    const paces = d.kms.map((k) => k.realPace);
    const hasTarget = d.kms.some((k) => k.targetPace !== null);
    const all = [...paces, ...d.kms.map((k) => k.predictedPace), ...d.kms.map((k) => k.targetPace ?? k.predictedPace)];
    const pMin = Math.min(...all), pMax = Math.max(...all);
    const hr = d.kms.map((k) => (k.hrDoubtful ? null : k.hr));
    const hrVals = hr.filter((h): h is number => h !== null);
    const hMin = Math.min(...hrVals), hMax = Math.max(...hrVals);
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Allure réelle',
            data: paces,
            borderColor: C.s1,
            backgroundColor: C.s1,
            pointBackgroundColor: d.kms.map((k) => (k.gel ? C.s4 : C.s1)),
            pointBorderColor: d.kms.map((k) => (k.gel ? C.s4 : C.s1)),
            pointRadius: d.kms.map((k) => (k.gel ? 6 : 3.5)),
            borderWidth: 2.5,
            tension: 0.2,
            yAxisID: 'y',
          },
          ...(hasTarget
            ? [{
                label: 'Plan objectif',
                data: d.kms.map((k) => k.targetPace),
                borderColor: C.accent,
                borderDash: [5, 4],
                borderWidth: 1.5,
                pointRadius: 0,
                stepped: 'middle' as const,
                yAxisID: 'y',
              }]
            : []),
          {
            label: 'Plan probable',
            data: d.kms.map((k) => k.predictedPace),
            borderColor: C.muted,
            borderDash: [2, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            stepped: 'middle',
            yAxisID: 'y',
          },
          ...(hrVals.length
            ? [{
                label: 'FC',
                data: hr,
                borderColor: C.bad,
                backgroundColor: alpha(C.bad, 0.12),
                fill: 'start' as const,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
                spanGaps: true,
                yAxisID: 'hr',
              }]
            : []),
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkipPadding: 4, maxRotation: 0 } },
          // Allure dans les 60 % du haut, FC dans le tiers du bas
          y: {
            reverse: true,
            min: Math.floor(pMin - 4),
            max: Math.ceil(pMax + (pMax - pMin + 8) * 0.8),
            ticks: { callback: (v) => pace(Number(v)), maxTicksLimit: 6 },
          },
          ...(hrVals.length
            ? { hr: { position: 'right' as const, min: hMin - 3, max: hMax + (hMax - hMin + 3) * 2, grid: { display: false }, ticks: { stepSize: 10, autoSkip: false, callback: (v: string | number) => (Number(v) <= hMax + 2 ? v : '') } } }
            : {}),
        },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (i) => `Km ${i[0].label}${d.kms[i[0].dataIndex].gel ? ' · gel' : ''}`,
              label: (c) => (c.dataset.label === 'FC' ? ` FC : ${c.parsed.y} bpm` : ` ${c.dataset.label} : ${pace(c.parsed.y ?? 0)} /km`),
            },
          },
        },
      },
    };
  });

  /** Écart cumulé aux temps de passage du plan (positif = retard) */
  protected readonly gapChart = computed<ChartConfiguration>(() => {
    const d = this.debrief();
    const labels = ['0', ...d.kms.map((k) => (k.dist < 900 ? num(d.activity.distanceKm, 1) : String(k.km)))];
    const hasTarget = d.kms.some((k) => k.vsTarget !== null);
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          ...(hasTarget
            ? [{
                label: 'vs objectif',
                data: [0, ...d.kms.map((k) => k.vsTarget)],
                borderColor: C.accent,
                backgroundColor: alpha(C.accent, 0.15),
                fill: 'origin' as const,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.25,
              }]
            : []),
          {
            label: 'vs chrono probable',
            data: [0, ...d.kms.map((k) => k.vsPredicted)],
            borderColor: C.s1,
            backgroundColor: alpha(C.s1, 0.12),
            fill: 'origin',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
          },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkipPadding: 6, maxRotation: 0 } },
          y: { reverse: true, ticks: { callback: (v) => this.gap(Number(v)), maxTicksLimit: 6 } },
        },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (i) => `Km ${i[0].label}`,
              label: (c) => ` ${c.dataset.label} : ${(c.parsed.y ?? 0) <= 0 ? 'avance' : 'retard'} ${clock(Math.abs(c.parsed.y ?? 0))}`,
            },
          },
        },
      },
    };
  });
}
