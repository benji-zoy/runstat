import { Component, computed, inject, input } from '@angular/core';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { Activity, RaceResult } from '../core/models';
import {
  FFA_DISTANCE_LABELS, FFA_LEVELS, FfaLevel, RacePerformance, confirmedLevel, ffaLimits, ffaTier, levelRank, racePerformances,
} from '../core/ffa';
import { goalResult } from '../core/goals';
import { clock, day, num } from '../core/format';
import { parseDay } from '../core/stats';
import { EntriesService } from '../core/entries.service';
import { ResultFormComponent } from '../ui/forms/result-form';

const BAREME_URL = { M: 'https://www.athle.fr/asp.net/main.html/html.aspx?htmlid=125', F: 'https://www.athle.fr/asp.net/main.html/html.aspx?htmlid=122' };

interface Row {
  activity: Activity;
  result: RaceResult | null;
  perf: RacePerformance | null;
  sec: number;
}

/** « Top 12 % » : part des arrivants devant ou à égalité */
export function topPct(rank: number | null, count: number | null): number | null {
  return rank && count ? (rank / count) * 100 : null;
}

/** Records › Se situer : niveau du barème FFA et classement dans chaque course, à la manière de MyDataRun. */
@Component({
  selector: 'app-race-standing',
  imports: [ResultFormComponent],
  template: `
    @if (compact()) {
      <p class="verdict">{{ verdict() }}</p>
    } @else {
    <app-result-form #resultForm />
    <section class="section">
      <h2>Se situer <small>barème FFA · classements officiels de tes courses</small></h2>
      <details class="method">
        <summary>Méthode et sources</summary>
        <p>Niveau : <a [href]="baremeUrl()" target="_blank" rel="noopener">barème FFA des courses sur route</a> (classement des
        clubs, en vigueur depuis 2010, toutes catégories d'âge), de D7 (départemental) à IA (international) ; c'est l'échelle
        reprise par MyDataRun. Classements : relevés sur la page de résultats officielle de chaque course (seuls les
        effectifs sont gardés). Le « Top X % » se lit sur les arrivants de ta course, pas sur toute la France.
        <b class="txt">À recopier</b> : chronométreurs qui interdisent les robots (Chrono-Start, TimeTo) ; ouvre le lien et
        reporte rang et effectifs avec « Saisir » (ou dans <code>data-raw/results/&lt;id&gt;.json</code>, puis <code>npm run data</code>).</p>
      </details>

      @if (best().length) {
        <div class="grid cards">
          @if (confirmed(); as c) {
            <div class="card stat">
              <span class="label">Niveau acquis (règle FFA)</span>
              <span class="display big">{{ c }}</span>
              <span class="muted small">{{ tier(c) }} · deux performances de ce niveau sur les 12 derniers mois</span>
            </div>
          }
          @for (b of best(); track b.distM) {
            <div class="card stat">
              <span class="label">{{ distLabel(b.distM) }} · meilleur niveau</span>
              <span class="display big">{{ b.grade.level ?? '< D7' }}</span>
              <span class="muted small">
                {{ clock(b.sec) }} le {{ fmt(b.activity.date) }}
                @if (b.grade.next && b.grade.nextSec) {
                  · {{ b.grade.next }} en {{ clock(b.grade.nextSec) }} (−{{ clock(b.sec - b.grade.nextSec) }})
                }
              </span>
            </div>
          }
        </div>
      }

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Course</th>
                <th class="num">Temps</th>
                <th>Niveau FFA</th>
                <th class="num">Scratch</th>
                <th class="num">{{ sexLabel() }}</th>
                <th class="num">Catégorie</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.activity.id) {
                <tr>
                  <td>{{ fmt(r.activity.date) }}</td>
                  <td class="wrap">
                    {{ r.result?.event ?? r.activity.name }}
                    @if (r.result?.course; as c) {
                      <span class="muted small"> · {{ c }}</span>
                    }
                  </td>
                  <td class="num txt">
                    {{ clock(r.sec) }}
                    @if (r.perf && r.perf.timeSource !== 'officiel') {
                      <span class="muted small"> ({{ r.perf.timeSource }})</span>
                    }
                  </td>
                  <td>
                    @if (r.perf) {
                      <b class="txt">{{ r.perf.grade.level ?? '< D7' }}</b>
                      <span class="muted small"> {{ r.perf.grade.tier ?? '' }}</span>
                    } @else {
                      <span class="muted small">{{ r.activity.kind === 'trail' ? 'trail : hors barème' : 'distance hors barème' }}</span>
                    }
                  </td>
                  <td class="num">{{ place(r.result?.rank, r.result?.finishers) }}</td>
                  <td class="num">{{ place(r.result?.sexRank, r.result?.sexCount) }}</td>
                  <td class="num">
                    {{ place(r.result?.catRank, r.result?.catCount) }}
                    @if (r.result?.category; as cat) {
                      <span class="muted small"> {{ cat }}</span>
                    }
                  </td>
                  <td>
                    @if (r.result; as res) {
                      @if (res.pending) {
                        <a [href]="res.source" target="_blank" rel="noopener" class="small pending" [attr.title]="res.note ?? ''">à recopier ↗</a>
                      } @else {
                        <a [href]="res.source" target="_blank" rel="noopener" class="small" [attr.title]="res.note ?? res.timing ?? ''">résultats ↗</a>
                      }
                    } @else if (!entries.available()) {
                      <span class="muted small">pas de classement</span>
                    }
                    @if (entries.available()) {
                      <button type="button" class="btn small edit" (click)="resultForm.open(r.activity)">{{ r.result ? 'Modifier' : 'Saisir' }}</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="muted">Aucune course {{ year() ? 'en ' + year() : '' }}.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <details class="card">
        <summary>Barème FFA {{ sexLabel().toLowerCase() }} complet</summary>
        <div class="table-wrap">
          <table class="bareme">
            <thead>
              <tr>
                <th>Niveau</th>
                @for (d of baremeDistances; track d) {
                  <th class="num">{{ distLabel(d) }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (l of levels; track l; let i = $index) {
                <tr [class.mine]="l === bestLevel()">
                  <td><b>{{ l }}</b> <span class="muted small">{{ tier(l) }}</span></td>
                  @for (d of baremeDistances; track d) {
                    <td class="num" [class.hit]="isMine(d, l)">{{ limit(d, i) }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="muted small">Case surlignée : ton meilleur niveau sur la distance. Un niveau s'obtient avec un temps inférieur ou égal à la limite.</p>
      </details>
    </section>
    }
  `,
  styles: `
    :host { display: block; }
    .small { font-size: 0.82rem; margin: 0; }
    .txt { color: var(--text-primary); }
    .intro { max-width: 75ch; }
    .intro a, td a { color: var(--accent); }
    td a.pending { color: var(--warning); }
    td .edit { margin-left: 0.5rem; vertical-align: middle; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); }
    .stat { display: grid; gap: 0.35rem; align-content: start; }
    .label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .big { font-size: 2.2rem; }
    details summary { cursor: pointer; font-weight: 600; color: var(--text-secondary); }
    details[open] summary { margin-bottom: 0.8rem; }
    table.bareme td.hit { color: var(--accent); font-weight: 700; }
    table.bareme tr.mine td:first-child b { color: var(--accent); }
  `,
})
export class RaceStandingSection {
  /** Carte de Comprendre : le constat en une phrase et une vignette, sans le détail */
  readonly compact = input(false);
  /** Filtre d'année de la page Records */
  readonly year = input<number | null>(null);

  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  private readonly today = inject(PeriodService).today;

  protected readonly clock = clock;
  protected readonly levels = FFA_LEVELS;
  protected readonly baremeDistances = [5000, 10000, 21097, 42195];
  protected readonly tier = ffaTier;
  protected readonly distLabel = (d: number) => FFA_DISTANCE_LABELS[d] ?? `${d} m`;
  protected readonly fmt = (iso: string) => day(parseDay(iso));
  protected readonly place = (rank: number | null | undefined, count: number | null | undefined) => {
    const top = topPct(rank ?? null, count ?? null);
    return top === null ? '–' : `${rank} / ${count} · Top ${num(Math.max(1, Math.ceil(top)))} %`;
  };

  private readonly sex = computed(() => this.sci.athlete().sex);
  protected readonly sexLabel = computed(() => (this.sex() === 'F' ? 'Femmes' : 'Hommes'));
  protected readonly baremeUrl = computed(() => BAREME_URL[this.sex()]);

  /** Courses : sorties classées « course » ou qui ont un classement officiel */
  private readonly races = computed(() => {
    const types = this.sci.types();
    return this.store.activities().filter((a) => types.get(a.id) === 'race' || a.result);
  });

  /** Temps puce notés dans les bilans d'objectifs */
  private readonly chip = computed(() => {
    const acts = this.store.activities();
    const out = new Map<string, number>();
    for (const g of this.store.data()?.goals ?? []) {
      const r = goalResult(g, acts);
      if (r && g.debrief?.chipSec) out.set(r.id, g.debrief.chipSec);
    }
    return out;
  });

  private readonly perfs = computed(() => racePerformances(this.races(), this.sex(), this.chip()));

  protected readonly rows = computed<Row[]>(() => {
    const y = this.year();
    const perf = new Map(this.perfs().map((p) => [p.activity.id, p]));
    return this.races()
      .filter((a) => y === null || parseDay(a.date).getFullYear() === y)
      .map((a) => {
        const p = perf.get(a.id) ?? null;
        return { activity: a, result: a.result ?? null, perf: p, sec: p?.sec ?? a.result?.officialSec ?? this.chip().get(a.id) ?? a.durationSec };
      })
      .reverse();
  });

  /** Meilleure performance par distance du barème */
  protected readonly best = computed(() => {
    const y = this.year();
    const out = new Map<number, RacePerformance>();
    for (const p of this.perfs()) {
      if (y !== null && parseDay(p.activity.date).getFullYear() !== y) continue;
      const cur = out.get(p.distM);
      if (!cur || p.sec < cur.sec) out.set(p.distM, p);
    }
    return [...out.values()].sort((a, b) => a.distM - b.distM);
  });

  protected readonly confirmed = computed(() => (this.year() === null ? confirmedLevel(this.perfs(), this.today) : null));

  protected readonly bestLevel = computed<FfaLevel | null>(() => {
    const ranks = this.best().map((b) => levelRank(b.grade.level));
    return ranks.length && Math.min(...ranks) < FFA_LEVELS.length ? FFA_LEVELS[Math.min(...ranks)] : null;
  });

  protected isMine(distM: number, level: FfaLevel): boolean {
    return this.best().find((b) => b.distM === distM)?.grade.level === level;
  }

  protected limit(distM: number, i: number): string {
    const l = ffaLimits(this.sex(), distM);
    return l ? clock(l[i]) : '–';
  }

  /** Phrase de la carte : niveau FFA acquis (2 perfs sur 12 mois) ou meilleur niveau atteint */
  protected readonly verdict = computed(() => {
    const confirmed = this.confirmed(), best = this.bestLevel();
    if (confirmed) return `Niveau FFA acquis : ${confirmed}${best && best !== confirmed ? `, déjà ${best} sur une course` : ''}.`;
    if (best) return `Meilleur niveau FFA : ${best} (il faut 2 courses sur 12 mois pour l'acquérir).`;
    return 'Pas encore de course au barème FFA.';
  });
}
