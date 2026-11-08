import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Activity } from '../core/models';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { addDays, inRange, isoDay, parseDay, startOfWeek, summarize } from '../core/stats';
import { clock, duration, km, num, pace } from '../core/format';
import { PeriodNavComponent } from '../ui/period-nav';
import { ScienceService } from '../core/science.service';
import { SESSION_TYPES } from '../core/science';
import { MorphDirective, MotionService } from '../ui/motion';

type SortKey = 'date' | 'distanceKm' | 'durationSec' | 'pace' | 'elevGain' | 'avgHr' | 'trainingLoad';

const KIND: Record<string, string> = { road: 'Route', trail: 'Trail', indoor: 'Tapis', track: 'Piste', other: 'Autre' };
const dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/** Filtres, tri et vue du journal : gardés quand on ouvre une sortie puis qu'on revient. */
@Injectable({ providedIn: 'root' })
export class JournalState {
  readonly view = signal<'list' | 'log'>('list');
  readonly kind = signal('all');
  readonly minKm = signal(0);
  readonly query = signal('');
  readonly sessionType = signal('all');
  readonly sort = signal<SortKey>('date');
  readonly asc = signal(false);
  readonly limit = signal(50);
}

@Component({
  selector: 'app-activities',
  imports: [PeriodNavComponent, RouterLink, MorphDirective],
  template: `
    <app-period-nav />

    <div class="toolbar">
      <div class="seg">
        <button type="button" [class.active]="view() === 'list'" (click)="view.set('list')">Liste</button>
        <button type="button" [class.active]="view() === 'log'" (click)="view.set('log')">Semaines</button>
      </div>
      <div class="chips">
        @for (k of kinds; track k.key) {
          <button type="button" class="chip" [class.active]="kind() === k.key" (click)="kind.set(k.key)">{{ k.label }}</button>
        }
      </div>
      <select id="min-km" [value]="minKm()" (change)="minKm.set(+$any($event.target).value)" aria-label="Distance minimale">
        <option value="0">Toutes distances</option>
        <option value="5">≥ 5 km</option>
        <option value="10">≥ 10 km</option>
        <option value="15">≥ 15 km</option>
        <option value="21">≥ 21 km</option>
      </select>
      <select id="session-type" [value]="sessionType()" (change)="sessionType.set($any($event.target).value)" aria-label="Type de séance">
        <option value="all">Tous types</option>
        @for (t of typeList; track t.key) {
          <option [value]="t.key">{{ t.icon }} {{ t.label }}</option>
        }
      </select>
      <input id="search" type="search" placeholder="Rechercher une séance…" [value]="query()" (input)="query.set($any($event.target).value)" />
    </div>

    <p class="totals">
      <b>{{ filtered().length }}</b> sortie{{ filtered().length > 1 ? 's' : '' }} ·
      <b>{{ km(totals().km) }}</b> · <b>{{ duration(totals().sec) }}</b> · <b>{{ num(totals().elev) }} m</b> D+ ·
      allure moy. <b>{{ pace(totals().avgPaceSec) }}</b>
    </p>

    @if (view() === 'list') {
      <!-- Téléphone : une carte par sortie, qui ouvre la fiche de la sortie -->
      <div class="mlist">
        @for (a of shown(); track a.id) {
          <div class="card mrun" [appMorph]="'run:' + a.id" [class.fresh]="motion.fresh().has(a.id)">
            <a class="mrun-head" [routerLink]="['/sortie', a.id]">
              <span class="m-top">
                <span class="muted m-date">{{ fmtDate(a.date) }}</span>
                <span class="muted m-kind"><span [title]="typeOf(a.id).label">{{ typeOf(a.id).icon }}</span> {{ kindLabel(a.kind) }}</span>
              </span>
              <span class="m-name">{{ a.name || 'Sortie' }}</span>
              <span class="m-stats">
                <span><b>{{ num(a.distanceKm, 2) }}</b> km</span>
                <span>{{ clock(a.durationSec) }}</span>
                <span>{{ pace(a.durationSec / a.distanceKm) }} /km</span>
                @if (a.avgHr) { <span class="muted">{{ a.avgHr }} bpm</span> }
                @if (a.elevGain) { <span class="muted">{{ a.elevGain }} m D+</span> }
              </span>
            </a>
          </div>
        } @empty {
          <p class="muted empty">Aucune sortie ne correspond.</p>
        }
        @if (sorted().length > limit()) {
          <button type="button" class="more" (click)="limit.set(limit() + 50)">Afficher plus ({{ sorted().length - limit() }} restantes)</button>
        }
      </div>

      <div class="card table-card">
        <div class="scroll">
          <table>
            <thead>
              <tr>
                @for (c of columns; track c.key) {
                  <th [class.num]="c.num" [class.sortable]="!!c.sort" (click)="c.sort && sortBy(c.sort)">
                    {{ c.label }}
                    @if (c.sort && sort() === c.sort) {
                      <span class="arrow">{{ asc() ? '▲' : '▼' }}</span>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (a of shown(); track a.id) {
                <tr class="row" (click)="open(a.id)" [appMorph]="'run:' + a.id" [class.fresh]="motion.fresh().has(a.id)">
                  <td>{{ fmtDate(a.date) }}</td>
                  <td class="name"><a [routerLink]="['/sortie', a.id]" (click)="$event.stopPropagation()">{{ a.name || 'Sortie' }}</a></td>
                  <td class="muted"><span class="t-icon" [title]="typeOf(a.id).label">{{ typeOf(a.id).icon }}</span> {{ kindLabel(a.kind) }}</td>
                  <td class="num">{{ num(a.distanceKm, 2) }} km</td>
                  <td class="num">{{ clock(a.durationSec) }}</td>
                  <td class="num">{{ pace(a.durationSec / a.distanceKm) }}</td>
                  <td class="num">{{ a.elevGain != null ? a.elevGain + ' m' : '–' }}</td>
                  <td class="num">{{ a.avgHr ?? '–' }}</td>
                  <td class="num">{{ a.trainingLoad ?? '–' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="9" class="muted empty">Aucune sortie ne correspond.</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (sorted().length > limit()) {
          <button type="button" class="more" (click)="limit.set(limit() + 50)">
            Afficher plus ({{ sorted().length - limit() }} restantes)
          </button>
        }
      </div>
    } @else {
      <div class="card log">
        <div class="log-head">
          <span></span>
          @for (d of days; track d) {
            <span class="muted">{{ d }}</span>
          }
          <span class="muted total-h">Semaine</span>
        </div>
        @for (w of weeks(); track w.start.getTime()) {
          <div class="log-row">
            <span class="week-label muted">{{ shortFmt(w.start) }}</span>
            @for (d of w.days; track d.date.getTime()) {
              <div class="log-day" [class.out]="d.out">
                @for (a of d.acts; track a.id) {
                  <button
                    type="button"
                    class="bubble"
                    [class.trail]="a.kind === 'trail'"
                    [style.--s]="bubble(a.distanceKm)"
                    [title]="a.name + ' · ' + num(a.distanceKm, 1) + ' km'"
                    (click)="open(a.id)"
                  >
                    {{ num(a.distanceKm, 0) }}
                  </button>
                }
              </div>
            }
            <span class="week-total"><b>{{ num(w.km, 1) }}</b> km</span>
          </div>
        }
        <p class="muted legend">Taille des bulles proportionnelle à la distance · <span class="leg-trail">●</span> trail · clique sur une bulle pour ouvrir la sortie</p>
      </div>
    }
  `,
  styleUrl: './activities.scss',
})
export class ActivitiesPage {
  private readonly store = inject(DataService);
  protected readonly motion = inject(MotionService);
  private readonly ps = inject(PeriodService);
  private readonly sci = inject(ScienceService);
  protected typeOf = (id: string) => SESSION_TYPES[this.sci.types().get(id) ?? 'easy'];
  protected readonly typeList = Object.entries(SESSION_TYPES).map(([key, t]) => ({ key, ...t }));

  protected readonly km = km;
  protected readonly num = num;
  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly duration = duration;
  protected readonly days = DAYS;
  protected fmtDate = (iso: string) => dateFmt.format(parseDay(iso));
  protected shortFmt = (d: Date) => shortFmt.format(d);
  protected kindLabel = (k: string) => KIND[k] ?? k;

  protected readonly kinds = [
    { key: 'all', label: 'Tout' },
    { key: 'road', label: 'Route' },
    { key: 'trail', label: 'Trail' },
    { key: 'indoor', label: 'Tapis' },
  ];
  protected readonly columns: { key: string; label: string; num?: boolean; sort?: SortKey }[] = [
    { key: 'date', label: 'Date', sort: 'date' },
    { key: 'name', label: 'Séance' },
    { key: 'kind', label: 'Type' },
    { key: 'dist', label: 'Distance', num: true, sort: 'distanceKm' },
    { key: 'dur', label: 'Durée', num: true, sort: 'durationSec' },
    { key: 'pace', label: 'Allure', num: true, sort: 'pace' },
    { key: 'elev', label: 'D+', num: true, sort: 'elevGain' },
    { key: 'hr', label: 'FC', num: true, sort: 'avgHr' },
    { key: 'load', label: 'Charge', num: true, sort: 'trainingLoad' },
  ];

  private readonly router = inject(Router);
  private readonly state = inject(JournalState);
  protected readonly view = this.state.view;
  protected readonly kind = this.state.kind;
  protected readonly minKm = this.state.minKm;
  protected readonly query = this.state.query;
  protected readonly sessionType = this.state.sessionType;
  protected readonly sort = this.state.sort;
  protected readonly asc = this.state.asc;
  protected readonly limit = this.state.limit;

  private readonly inPeriod = computed(() => inRange(this.store.activities(), this.ps.period().start, this.ps.period().end));

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.inPeriod().filter(
      (a) =>
        (this.kind() === 'all' || a.kind === this.kind()) &&
        (this.sessionType() === 'all' || this.sci.types().get(a.id) === this.sessionType()) &&
        a.distanceKm >= this.minKm() &&
        (!q || a.name.toLowerCase().includes(q)),
    );
  });

  protected readonly totals = computed(() => summarize(this.filtered()));

  protected readonly sorted = computed(() => {
    const key = this.sort();
    const value = (a: Activity): number =>
      key === 'date' ? (a.start ?? 0) : key === 'pace' ? a.durationSec / a.distanceKm : ((a[key] as number | null | undefined) ?? -Infinity);
    const dir = this.asc() ? 1 : -1;
    return [...this.filtered()].sort((a, b) => (value(a) - value(b)) * dir);
  });

  protected readonly shown = computed(() => this.sorted().slice(0, this.limit()));

  protected readonly weeks = computed(() => {
    const p = this.ps.period();
    const byDay = new Map<string, Activity[]>();
    for (const a of this.filtered()) {
      if (!byDay.has(a.date)) byDay.set(a.date, []);
      byDay.get(a.date)!.push(a);
    }
    const first = startOfWeek(p.start);
    const weeks = [];
    for (let w = first; w < p.end; w = addDays(w, 7)) {
      const days = Array.from({ length: 7 }, (_, i) => {
        const date = addDays(w, i);
        return { date, out: date < p.start || date >= p.end, acts: byDay.get(isoDay(date)) ?? [] };
      });
      weeks.push({ start: w, days, km: days.flatMap((d) => d.acts).reduce((s, a) => s + a.distanceKm, 0) });
    }
    return weeks.reverse();
  });

  protected sortBy(key: SortKey): void {
    if (this.sort() === key) this.asc.set(!this.asc());
    else {
      this.sort.set(key);
      this.asc.set(key === 'pace');
    }
  }

  protected open(id: string): void {
    void this.router.navigate(['/sortie', id]);
  }

  /** Diamètre de bulle (rem) proportionnel à la racine de la distance */
  protected bubble(distanceKm: number): string {
    return `${Math.min(3.2, 1.3 + Math.sqrt(distanceKm) * 0.32)}rem`;
  }
}
