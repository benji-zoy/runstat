import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { Activity } from '../core/models';
import { addDays, fastestOver, inRange, maxBy, parseDay, startOfWeek, summarize, weekly } from '../core/stats';
import { freshnessState, pmc, yearProjection } from '../core/insights';
import { healthNow, hrvStatus, rhrStatus } from '../core/health';
import { clock, day, duration, fixed, km, num, pace } from '../core/format';
import { Brief, BriefComponent } from '../ui/brief';
import { IconComponent } from '../ui/icon';
import { ConditionsCardComponent } from '../ui/conditions-card';

const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const runDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const DAY_MS = 86_400_000;

/** Aujourd'hui : où j'en suis. Le résumé du jour, la prochaine course, la forme, l'année et les dernières sorties. */
@Component({
  selector: 'app-today',
  imports: [RouterLink, BriefComponent, IconComponent, ConditionsCardComponent],
  template: `
    <header class="page-head">
      <h1>{{ title() }}</h1>
      <p class="lede">{{ lede() }}</p>
    </header>

    <app-brief [brief]="brief()" />

    <div class="row">
      @if (nextGoal(); as e) {
        <a class="card race" routerLink="/courses">
          <span class="label head">Prochaine course <span class="go">Plan de course <app-icon name="arrow" /></span></span>
          <div class="race-id">
            <span class="display days">{{ e.daysLeft ? 'J-' + e.daysLeft : 'Jour J' }}</span>
            <div>
              <b class="name">{{ e.goal.name }}</b>
              <span class="muted small">
                {{ fmtDay(e.goal.date) }} · {{ num(e.goal.distanceKm, e.goal.distanceKm % 1 ? 1 : 0) }} km
                @if (e.goal.elevGain) { · {{ num(e.goal.elevGain) }} m D+ }
              </span>
            </div>
          </div>
          <div class="race-stats">
            <div><span class="display v">{{ clock(e.predicted) }}</span><span class="muted small">chrono probable</span></div>
            @if (e.probability !== null) {
              <div><span class="display v">{{ e.index }}<small> %</small></span><span class="muted small">sous {{ clock(e.goal.targetSec!) }}</span></div>
            } @else {
              <div><span class="display v">{{ e.index }}<small>/100</small></span><span class="muted small">préparation</span></div>
            }
          </div>
          <div class="progress" aria-hidden="true"><span [style.width.%]="e.index"></span></div>
        </a>
      }

      <a class="card vitals" routerLink="/forme">
        <span class="label head">Forme du jour
          @if (health(); as h) { <span class="muted src">{{ sci.healthLabel() }} · {{ shortDay(h.date) }}</span> }
        </span>
        <div class="grid4">
          @if (health()?.day?.readiness; as r) {
            <div class="vital"><span class="display v">{{ r }}<small>/100</small></span><span class="muted small">préparation</span></div>
          }
          @if (health()?.hrv?.avg7; as hrv) {
            <div class="vital">
              <span class="display v">{{ num(hrv) }}<small> ms</small></span>
              @if (hrvState(); as s) { <span class="pill" [attr.data-tone]="s.tone">VFC {{ s.label.toLowerCase() }}</span> }
            </div>
          }
          @if (health()?.rhr?.avg7; as rhr) {
            <div class="vital">
              <span class="display v">{{ fixed(rhr, 1) }}<small> bpm</small></span>
              @if (rhrState(); as s) { <span class="pill" [attr.data-tone]="s.tone">{{ s.label }} vs base</span> }
            </div>
          }
          @if (pmcNow(); as n) {
            <div class="vital">
              <span class="display v">{{ n.tsb > 0 ? '+' : '' }}{{ num(n.tsb) }}</span>
              <span class="pill" [attr.data-tone]="fresh().tone">fraîcheur {{ fresh().label.toLowerCase() }}</span>
            </div>
          }
        </div>
      </a>
    </div>

    <section class="section">
      <h2>{{ year }} <small>depuis le 1er janvier</small></h2>
      <a class="kpis" routerLink="/entrainement" [queryParams]="{ section: 'volume', vue: null, date: null }">
        <div class="kpi hero">
          <span class="display v">{{ num(ytd().km) }}<small>km</small></span>
          @if (ytdDiff(); as d) {
            <span class="delta" [class.down]="d < 0">{{ d >= 0 ? '+' : '−' }}{{ km(Math.abs(d)) }} sur {{ year - 1 }} à la même date</span>
          }
          @if (projection(); as p) {
            <span class="muted small">fin d'année vers {{ km(p.projected) }}</span>
          }
        </div>
        <div class="kpi"><span class="label">Sorties</span><span class="display v">{{ ytd().count }}</span></div>
        <div class="kpi"><span class="label">Temps</span><span class="display v">{{ duration(ytd().sec) }}</span></div>
        <div class="kpi"><span class="label">Dénivelé +</span><span class="display v">{{ num(ytd().elev) }}<small> m</small></span></div>
        <div class="kpi"><span class="label">Cette semaine</span><span class="display v">{{ num(week().km, 1) }}<small> km</small></span>
          <span class="muted small">{{ week().count }} sortie{{ week().count > 1 ? 's' : '' }}</span>
        </div>
      </a>
    </section>

    <div class="row row2">
      <section class="card runs">
        <span class="label head">Dernières sorties <a class="go" routerLink="/entrainement">Journal <app-icon name="arrow" /></a></span>
        @for (a of latest(); track a.id) {
          <div class="run">
            <span class="run-date muted">{{ fmtDate(a.date) }}</span>
            <span class="run-name">{{ a.name || 'Sortie' }}</span>
            <span class="run-stat"><b>{{ num(a.distanceKm, 1) }}</b> km</span>
            <span class="run-stat muted">{{ clock(a.durationSec) }}</span>
            <span class="run-stat muted">{{ pace(a.durationSec / a.distanceKm) }}</span>
          </div>
          @if ($first && hasConditions()) {
            <div class="last-cond">
              <span class="label">Coût des conditions</span>
              <app-conditions [activity]="a" [compact]="true" />
            </div>
          }
        } @empty {
          <p class="muted">Aucune sortie pour l'instant.</p>
        }
      </section>

      <section class="card highlights">
        <span class="label head">Moments forts {{ year }} <a class="go" routerLink="/performance">Records <app-icon name="arrow" /></a></span>
        @for (h of highlights(); track h.label) {
          <div class="hl">
            <span class="label">{{ h.label }}</span>
            <span class="display v">{{ h.value }}</span>
            <span class="muted small">{{ h.detail }}</span>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    :host { display: block; }
    .row { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); margin-top: 1rem; }
    .row2 { margin-top: 2.5rem; grid-template-columns: minmax(0, 3fr) minmax(min(100%, 280px), 2fr); }
    @media (max-width: 860px) { .row2 { grid-template-columns: minmax(0, 1fr); margin-top: 2rem; } }
    a.card { color: inherit; text-decoration: none; transition: border-color 0.15s; }
    a.card:hover, a.kpis:hover { border-color: var(--surface-3); }
    .card { display: grid; gap: 0.9rem; align-content: start; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
    .go { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--accent); text-transform: none; letter-spacing: 0; font-size: 0.8rem; text-decoration: none; }
    .src { text-transform: none; letter-spacing: 0; font-weight: 400; }
    .v { font-size: 2rem; font-variant-numeric: tabular-nums; }
    .v small { font-family: var(--font-body); font-size: 0.4em; font-weight: 600; color: var(--text-secondary); margin-left: 0.1em; }
    .small { font-size: 0.8rem; }

    .race-id { display: flex; align-items: center; gap: 1rem; }
    .days { font-size: 2.8rem; color: var(--accent); }
    .race-id > div { display: grid; gap: 0.15rem; min-width: 0; }
    .name { font-size: 1.1rem; }
    .race-stats { display: flex; gap: 2rem; flex-wrap: wrap; }
    .race-stats > div, .vital { display: grid; gap: 0.25rem; align-content: start; }

    .grid4 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 1.25rem; }
    .pill { justify-self: start; font-size: 0.72rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 999px; background: var(--surface-2); color: var(--text-secondary); }
    .pill[data-tone='good'] { color: var(--good-text); background: color-mix(in srgb, var(--good) 14%, transparent); }
    .pill[data-tone='warning'] { color: var(--warning); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .pill[data-tone='critical'] { color: var(--critical-text); background: color-mix(in srgb, var(--critical) 14%, transparent); }

    .kpis {
      display: grid; grid-template-columns: 1.5fr repeat(4, minmax(0, 1fr)); color: inherit; text-decoration: none;
      background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
    }
    .kpi { display: grid; gap: 0.3rem; align-content: start; padding: 1rem 1.1rem; box-shadow: -1px -1px 0 var(--border); }
    .kpi.hero .v { font-size: 2.8rem; }
    .kpi.hero .v small { color: var(--accent); font-family: var(--font-display); font-weight: 800; font-size: 0.45em; }
    .kpi .v { font-size: 1.7rem; }
    .delta { font-size: 0.8rem; font-weight: 600; color: var(--good-text); }
    .delta.down { color: var(--serious); }
    @media (max-width: 760px) {
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .kpi.hero { grid-column: 1 / -1; }
    }

    .runs { gap: 0; }
    .runs .head { margin-bottom: 0.4rem; }
    .run {
      display: grid; grid-template-columns: 6.5rem minmax(0, 1fr) 4.8rem 4.6rem 3.4rem; gap: 0.75rem; align-items: baseline;
      padding: 0.6rem 0; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums;
    }
    .run-date { font-size: 0.82rem; }
    .run-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-stat { text-align: right; }
    @media (max-width: 600px) {
      .run { grid-template-columns: minmax(0, 1fr) auto auto; row-gap: 0.1rem; column-gap: 0.6rem; }
      .run-date { grid-column: 1 / -1; font-size: 0.76rem; }
      .run-stat:last-child { display: none; }
    }
    .last-cond { display: grid; gap: 0.35rem; padding: 0 0 0.7rem; }
    .highlights { gap: 1rem; }
    .hl { display: grid; gap: 0.15rem; }
    .hl .v { font-size: 1.6rem; }
  `,
})
export class TodayPage {
  private readonly store = inject(DataService);
  protected readonly sci = inject(ScienceService);
  private readonly today = inject(PeriodService).today;

  protected readonly Math = Math;
  protected readonly km = km;
  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly duration = duration;
  protected readonly year = this.today.getFullYear();
  protected fmtDate = (iso: string) => runDate.format(parseDay(iso));
  protected fmtDay = (iso: string) => day(parseDay(iso));
  protected shortDay = (d: Date) => day(d);

  private readonly acts = this.store.activities;

  protected readonly title = computed(() => {
    const t = longDate.format(this.today);
    return t.charAt(0).toUpperCase() + t.slice(1);
  });

  private readonly lastRun = computed(() => this.acts().at(-1) ?? null);
  /** Rapport des conditions de la dernière sortie (absent sur tapis) */
  protected readonly hasConditions = computed(() => {
    const a = this.lastRun();
    return a ? this.sci.conditions(a) !== null : false;
  });

  protected readonly lede = computed(() => {
    const wk = isoWeek(this.today);
    const last = this.lastRun();
    if (!last) return `Semaine ${wk}`;
    const ago = Math.round((this.today.getTime() - parseDay(last.date).getTime()) / DAY_MS);
    const when = ago === 0 ? "aujourd'hui" : ago === 1 ? 'hier' : `il y a ${ago} jours`;
    return `Semaine ${wk} · dernière sortie ${when} : ${last.name || 'sortie'}, ${km(last.distanceKm)}`;
  });

  // Prochaine course
  protected readonly nextGoal = computed(() => this.sci.upcomingGoals()[0] ?? null);

  // Forme du jour
  protected readonly health = computed(() => {
    const h = this.store.data()?.health;
    return h ? healthNow(h) : null;
  });
  protected readonly hrvState = computed(() => hrvStatus(this.health()?.hrv));
  protected readonly rhrState = computed(() => rhrStatus(this.health()?.rhr));
  protected readonly pmcNow = computed(() => pmc(this.acts(), this.today).at(-1) ?? null);
  protected readonly fresh = computed(() => freshnessState(this.pmcNow()?.tsb ?? 0));

  // Année en cours
  private readonly yearStart = new Date(this.year, 0, 1);
  protected readonly ytd = computed(() => summarize(inRange(this.acts(), this.yearStart, addDays(this.today, 1))));
  protected readonly ytdDiff = computed(() => {
    const prev = summarize(inRange(this.acts(), new Date(this.year - 1, 0, 1), addDays(new Date(this.year - 1, this.today.getMonth(), this.today.getDate()), 1)));
    return prev.count ? this.ytd().km - prev.km : null;
  });
  protected readonly projection = computed(() => yearProjection(this.acts(), this.today));
  protected readonly week = computed(() => summarize(inRange(this.acts(), startOfWeek(this.today), addDays(this.today, 1))));

  protected readonly latest = computed(() => [...this.acts()].reverse().slice(0, 5));

  /** Trois moments forts de l'année : la plus longue sortie, la meilleure allure sur la plus longue distance courue, la plus grosse semaine */
  protected readonly highlights = computed(() => {
    const acts = inRange(this.acts(), this.yearStart, addDays(this.today, 1));
    if (!acts.length) return [];
    const describe = (a: Activity) => `${a.name || 'Sortie'} · ${day(parseDay(a.date))}`;
    const out: { label: string; value: string; detail: string }[] = [];
    const longest = maxBy(acts, (a) => a.distanceKm)!;
    out.push({ label: 'Plus longue sortie', value: km(longest.distanceKm), detail: describe(longest) });
    for (const [label, min] of [['semi', 21.0975], ['10 km', 10], ['5 km', 5]] as const) {
      const a = fastestOver(acts, min);
      if (a) {
        out.push({ label: `Meilleure allure ≥ ${label}`, value: `${pace(a.durationSec / a.distanceKm)} /km`, detail: describe(a) });
        break;
      }
    }
    const weeks = weekly(acts, this.today, isoWeek(this.today) + 1).filter((w) => w.count);
    const best = maxBy(weeks, (w) => w.km);
    if (best) out.push({ label: 'Plus grosse semaine', value: km(best.km), detail: `semaine du ${day(best.start)} · ${best.count} sorties` });
    return out;
  });

  protected readonly brief = computed<Brief | null>(() => {
    const points: string[] = [];
    const n = this.pmcNow();
    const hrv = this.hrvState();
    const parts: string[] = [];
    if (n) parts.push(`fraîcheur ${n.tsb > 0 ? '+' : ''}${num(n.tsb)} (${this.fresh().label.toLowerCase()})`);
    if (hrv) parts.push(`VFC ${hrv.label.toLowerCase()}`);
    const rhr = this.rhrState();
    if (rhr && rhr.tone !== 'good') parts.push(`FC de repos ${rhr.label}`);
    let title = 'Ta journée';
    if (parts.length) {
      const warn = (hrv && hrv.tone !== 'good' && hrv.tone !== 'neutral') || (rhr && rhr.tone !== 'good') || this.fresh().tone === 'critical';
      title = warn ? 'Journée à prendre en douceur' : this.fresh().label === 'Frais' ? 'Tu es frais' : 'Rien ne s’oppose à une séance normale';
      points.push(`${capitalize(parts.join(', '))}. ${warn ? 'Privilégie une sortie facile ou le repos.' : this.fresh().text}`);
    }
    const g = this.nextGoal();
    if (g) {
      points.push(
        `${g.goal.name} dans ${g.daysLeft} jour${g.daysLeft > 1 ? 's' : ''} : chrono probable ${clock(g.predicted)}` +
          (g.probability !== null ? `, ${g.index} % de chances sous ${clock(g.goal.targetSec!)}.` : `, préparation ${g.index}/100.`),
      );
    }
    const y = this.ytd();
    const d = this.ytdDiff();
    points.push(
      `${this.year} : ${km(y.km)}` +
        (d !== null ? `, ${d >= 0 ? `${km(d)} d'avance` : `${km(-d)} de retard`} sur ${this.year - 1} à la même date` : '') +
        `, fin d'année vers ${km(this.projection().projected)}.`,
    );
    return { title, points };
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Numéro de semaine ISO 8601 */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}
