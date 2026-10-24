import { Component, computed, inject, signal } from '@angular/core';
import { Activity } from '../core/models';
import { DataService } from '../core/data.service';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { monthly, parseDay, weekly } from '../core/stats';
import { bestEfforts, vdot } from '../core/science';
import { EFFORT_DISTANCES, Effort, paceOf, topEfforts, topN } from '../core/insights';
import { clock, day, km, month, num, pace } from '../core/format';

interface Category {
  key: string;
  label: string;
  score: (a: Activity) => number | null;
  value: (a: Activity) => string;
}

const CATEGORIES: Category[] = [
  { key: 'dist', label: 'Plus longue sortie', score: (a) => a.distanceKm, value: (a) => km(a.distanceKm) },
  { key: 'time', label: 'Plus long effort', score: (a) => a.durationSec, value: (a) => clock(a.durationSec) },
  { key: 'elev', label: 'Plus gros D+', score: (a) => a.elevGain ?? null, value: (a) => `${num(a.elevGain ?? 0)} m` },
  {
    key: 'p5', label: 'Meilleure allure ≥ 5 km',
    score: (a) => (a.distanceKm >= 5 && a.kind !== 'indoor' ? -paceOf(a) : null),
    value: (a) => `${pace(paceOf(a))} /km`,
  },
  {
    key: 'p10', label: 'Meilleure allure ≥ 10 km',
    score: (a) => (a.distanceKm >= 10 && a.kind !== 'indoor' ? -paceOf(a) : null),
    value: (a) => `${pace(paceOf(a))} /km`,
  },
  {
    key: 'p21', label: 'Meilleure allure ≥ semi',
    score: (a) => (a.distanceKm >= 21.0975 && a.kind !== 'indoor' ? -paceOf(a) : null),
    value: (a) => `${pace(paceOf(a))} /km`,
  },
  { key: 'km', label: 'Kilomètre le plus rapide', score: (a) => (a.bestKmSec ? -a.bestKmSec : null), value: (a) => `${pace(a.bestKmSec)} /km` },
  { key: 'load', label: 'Plus grosse charge', score: (a) => a.trainingLoad ?? null, value: (a) => String(a.trainingLoad) },
  { key: 'cad', label: 'Cadence la plus élevée (≥ 3 km)', score: (a) => (a.distanceKm >= 3 ? (a.cadence ?? null) : null), value: (a) => `${a.cadence} ppm` },
];

const EFFORT_LABELS: Record<number, string> = {
  400: '400 m', 800: '800 m', 1000: '1 km', 1609: '1 mile', 3000: '3 km', 5000: '5 km', 10000: '10 km',
  15000: '15 km', 21097: 'Semi', 30000: '30 km', 42195: 'Marathon',
};

@Component({
  imports: [SubTabsComponent],
  selector: 'app-records',
  template: `
    <div class="toolbar">
      <app-subtabs #st [tabs]="subtabs" param="onglet" variant="segment" />
      @if (st.current() !== 'annees') {
        <div class="chips" role="group" aria-label="Année">
          <button type="button" class="chip" [class.active]="year() === null" (click)="year.set(null)">Depuis le début</button>
          @for (y of years(); track y) {
            <button type="button" class="chip" [class.active]="year() === y" (click)="year.set(y)">{{ y }}</button>
          }
        </div>
      }
    </div>

    @switch (st.current()) {
      @case ('sorties') {
    <section class="section">
      <h2>Records personnels <small>{{ year() ? 'en ' + year() : 'depuis le début' }}</small></h2>
      <div class="grid podiums">
        @for (c of podiums(); track c.key) {
          <div class="card podium">
            <h3>{{ c.label }}</h3>
            <ol>
              @for (r of c.top; track r.id; let i = $index) {
                <li [class.first]="i === 0">
                  <span class="rank" [attr.data-rank]="i">{{ i + 1 }}</span>
                  <span class="val display">{{ c.value(r) }}</span>
                  <span class="muted when">{{ r.name || 'Sortie' }} · {{ fmt(r.date) }}</span>
                </li>
              }
            </ol>
          </div>
        }
        @for (b of bucketPodiums(); track b.label) {
          <div class="card podium">
            <h3>{{ b.label }}</h3>
            <ol>
              @for (r of b.top; track r.label; let i = $index) {
                <li [class.first]="i === 0">
                  <span class="rank" [attr.data-rank]="i">{{ i + 1 }}</span>
                  <span class="val display">{{ km(r.km) }}</span>
                  <span class="muted when">{{ r.label }} · {{ r.count }} sorties</span>
                </li>
              }
            </ol>
          </div>
        }
      </div>
      <p class="muted note">
        Les allures sont des moyennes sur une sortie entière d'au moins la distance indiquée (hors tapis). Les meilleurs
        passages à l'intérieur d'une sortie sont dans « Segments ».
      </p>
    </section>
      }
      @case ('segments') {
    <section class="section">
      <div class="sec-head">
        <h2>Meilleurs efforts <small>{{ year() ? 'en ' + year() : 'depuis le début' }} · meilleur passage sur la distance, n'importe où dans une sortie</small></h2>
        <div class="seg" role="group" aria-label="Mesure">
          <button type="button" [class.active]="!adjusted()" (click)="adjusted.set(false)">Chrono</button>
          <button type="button" [class.active]="adjusted()" (click)="adjusted.set(true)">Ajusté à la pente</button>
        </div>
      </div>
      @if (adjusted()) {
      <div class="card">
        <div class="table-wrap"><table>
          <thead>
            <tr><th>Distance</th><th class="num">16 semaines</th><th class="num">{{ year() ? year() : 'Tous les FIT' }}</th><th class="num">VDOT</th><th>Sortie</th></tr>
          </thead>
          <tbody>
            @for (e of adjustedTable(); track e.m) {
              <tr>
                <td>{{ effortLabel(e.m) }}</td>
                <td class="num">{{ e.recent ? clock(e.recent.time) : '–' }}</td>
                <td class="num"><b>{{ clock(e.all.time) }}</b></td>
                <td class="num muted">{{ num(vdot(e.m, e.all.time), 1) }}</td>
                <td class="muted when-cell">{{ e.all.activity.name }} · {{ fmt(e.all.activity.date) }}</td>
              </tr>
            }
          </tbody>
        </table></div>
        <p class="muted note">
          Meilleurs passages sur les fichiers FIT, avec l'allure ajustée à la pente (GAP, Minetti) : une montée compte comme
          un effort sur le plat équivalent. La colonne 16 semaines alimente la vitesse critique (Performance › Potentiel).
        </p>
      </div>
      } @else {
      <div class="grid podiums">
        @for (p of effortPodiums(); track p.key) {
          <div class="card podium">
            <h3>{{ p.label }}</h3>
            <ol>
              @for (r of p.top; track r.activity.id; let i = $index) {
                <li [class.first]="i === 0">
                  <span class="rank" [attr.data-rank]="i">{{ i + 1 }}</span>
                  <span class="val display">{{ clock(r.time) }}<small class="pace">{{ pace(r.time / (p.m / 1000)) }} /km</small></span>
                  <span class="muted when">{{ r.activity.name || 'Sortie' }} · {{ fmt(r.activity.date) }}{{ sourceLabel(r) }}</span>
                </li>
              }
            </ol>
          </div>
        }
      </div>
      <p class="muted note">
        Temps mesurés sur la distance GPS de la montre, souvent 0,5 à 1 % trop longue en course : sur une course officielle,
        le passage est donc un peu flatteur par rapport au temps puce. {{ fitCount() }} sorties sur {{ total() }} ont leur
        fichier FIT{{ fitCount() < total() ? ' (les autres arrivent à 50 par jour)' : '' }} ; sans FIT, seuls comptent le
        meilleur km Coros et l'allure moyenne d'une sortie de la distance (jusqu'à +5 %).
      </p>
      }
    </section>
      }
      @case ('annees') {
    <section class="section">
      <h2>Année par année <small>le meilleur de chaque année, en orange le meilleur de tous</small></h2>
      <div class="card scroll">
        <table>
          <thead>
            <tr>
              <th>Record</th>
              @for (y of years(); track y) {
                <th class="num">{{ y }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of byYear(); track row.label) {
              <tr>
                <td>{{ row.label }}</td>
                @for (cell of row.cells; track $index) {
                  <td class="num" [class.best]="cell.best">{{ cell.text }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
      }
    }

    
  `,
  styles: `
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; margin-top: 1.25rem; }
    .toolbar app-subtabs { margin-top: 0; }
    .toolbar .chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; max-width: 100%; }
    .toolbar .chip { flex: none; }
    .sec-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.6rem 1rem; }
    .podiums { grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); }
    .podium { display: grid; gap: 0.6rem; align-content: start; }
    .podium h3 { font-size: 1.05rem; }
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
    li { display: grid; grid-template-columns: 1.6rem 1fr; align-items: baseline; column-gap: 0.5rem; }
    .rank {
      display: inline-grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 50%;
      font-size: 0.72rem; font-weight: 700; background: var(--surface-2); color: var(--text-muted); align-self: center;
    }
    .rank[data-rank='0'] { background: var(--accent); color: var(--on-accent); }
    .when-cell { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
    .val { font-size: 1.35rem; white-space: nowrap; }
    .pace { font-family: var(--font-body); font-size: 0.8rem; color: var(--text-muted); margin-left: 0.5rem; }
    li.first .val { font-size: 1.9rem; color: var(--text-primary); }
    li:not(.first) .val { color: var(--text-secondary); }
    .when { grid-column: 2; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note { font-size: 0.8rem; margin: 0; }
    .scroll { overflow-x: auto; padding: 0.5rem 0.75rem; }
    td.best { color: var(--accent); font-weight: 700; }
  `,
})
export class RecordsPage {
  protected readonly subtabs: SubTab[] = [
    { id: 'sorties', label: 'Sorties' },
    { id: 'segments', label: 'Segments' },
    { id: 'annees', label: 'Par année' },
  ];

  private readonly store = inject(DataService);
  private readonly ps = inject(PeriodService);
  private readonly sci = inject(ScienceService);
  protected readonly km = km;
  protected readonly num = num;
  protected readonly vdot = vdot;
  protected effortLabel = (m: number) => EFFORT_LABELS[m] ?? `${m} m`;

  /** Segments : chrono brut (toutes sorties) ou ajusté à la pente (fichiers FIT, ex-Labo › Prédictions) */
  protected readonly adjusted = signal(false);
  protected readonly adjustedTable = computed(() => {
    const recent = this.sci.recentEfforts();
    const all = bestEfforts(this.acts(), this.ps.today, null);
    return [...all.keys()].sort((a, b) => a - b).map((m) => ({ m, recent: recent.get(m) ?? null, all: all.get(m)! }));
  });
  protected fmt = (iso: string) => day(parseDay(iso));

  protected readonly year = signal<number | null>(null);
  protected readonly years = computed(() => [...new Set(this.store.activities().map((a) => Number(a.date.slice(0, 4))))].sort((a, b) => b - a));

  private readonly acts = computed(() => {
    const y = this.year();
    return y ? this.store.activities().filter((a) => a.date.startsWith(String(y))) : this.store.activities();
  });

  protected readonly podiums = computed(() =>
    CATEGORIES.map((c) => ({ ...c, top: topN(this.acts(), c.score, 3) })).filter((c) => c.top.length),
  );

  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly fitCount = computed(() => this.acts().filter((a) => a.fit).length);
  protected readonly total = computed(() => this.acts().filter((a) => a.kind !== 'indoor').length);
  protected readonly effortPodiums = computed(() =>
    EFFORT_DISTANCES.map((e) => ({ ...e, top: topEfforts(this.acts(), e, 3) })).filter((p) => p.top.length),
  );
  protected sourceLabel = (r: Effort & { activity: Activity }) =>
    r.source === 'segment' ? ` · sur ${num(r.activity.distanceKm, 1)} km`
      : r.source === 'coros' ? ' · meilleur km Coros'
      : r.source === 'moyenne' ? ' · allure moyenne (sans FIT)'
      : '';

  protected readonly bucketPodiums = computed(() => {
    const acts = this.acts();
    if (!acts.length) return [];
    const last = parseDay(acts.at(-1)!.date);
    const firstD = parseDay(acts[0].date);
    const nWeeks = Math.ceil((last.getTime() - firstD.getTime()) / (7 * 86_400_000)) + 2;
    const nMonths = (last.getFullYear() - firstD.getFullYear()) * 12 + last.getMonth() - firstD.getMonth() + 1;
    const weeks = weekly(acts, last, nWeeks)
      .filter((w) => w.count)
      .sort((a, b) => b.km - a.km)
      .slice(0, 3)
      .map((w) => ({ label: `Semaine du ${day(w.start)}`, km: w.km, count: w.count }));
    const months = monthly(acts, last, nMonths)
      .filter((m) => m.count)
      .sort((a, b) => b.km - a.km)
      .slice(0, 3)
      .map((m) => ({ label: month(m.start), km: m.km, count: m.count }));
    return [
      { label: 'Plus grosse semaine', top: weeks },
      { label: 'Plus gros mois', top: months },
    ];
  });

  protected readonly byYear = computed(() => {
    const all = this.store.activities();
    const years = this.years();
    const rows = CATEGORIES.map((c) => {
      const perYear = years.map((y) => topN(all.filter((a) => a.date.startsWith(String(y))), c.score, 1)[0] ?? null);
      const scores = perYear.map((a) => (a ? c.score(a) : null));
      const best = Math.max(...scores.map((s) => s ?? -Infinity));
      return {
        label: c.label,
        cells: perYear.map((a, i) => ({ text: a ? c.value(a) : '–', best: a !== null && scores[i] === best })),
      };
    });
    const totals = (label: string, f: (acts: Activity[]) => number, fmt: (n: number) => string) => {
      const vals = years.map((y) => f(all.filter((a) => a.date.startsWith(String(y)))));
      const best = Math.max(...vals);
      return { label, cells: vals.map((v) => ({ text: fmt(v), best: v === best })) };
    };
    const efforts = EFFORT_DISTANCES.map((e) => {
      const perYear = years.map((y) => topEfforts(all.filter((a) => a.date.startsWith(String(y))), e, 1)[0]?.time ?? null);
      const best = Math.min(...perYear.map((t) => t ?? Infinity));
      return { label: e.label, cells: perYear.map((t) => ({ text: t ? clock(t) : '–', best: t !== null && t === best })) };
    }).filter((r) => r.cells.some((c) => c.text !== '–'));
    return [
      totals('Distance totale', (as) => as.reduce((s, a) => s + a.distanceKm, 0), km),
      totals('Sorties', (as) => as.length, (n) => num(n)),
      totals('D+ total', (as) => as.reduce((s, a) => s + (a.elevGain ?? 0), 0), (n) => `${num(n)} m`),
      ...rows,
      ...efforts,
    ];
  });
}
