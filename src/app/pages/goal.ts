import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ScienceService } from '../core/science.service';
import { EntriesService } from '../core/entries.service';
import { GoalEvaluation } from '../core/goals';
import { RaceDebrief } from '../core/debrief';
import { clock, fixed, num, pace } from '../core/format';
import { parseDay } from '../core/stats';
import { GoalCardComponent, GoalPart } from '../sections/goal-card';
import { RaceDebriefComponent } from '../sections/race-debrief';
import { ConfidenceHistoryComponent } from '../sections/confidence-history';
import { GoalFormComponent } from '../ui/forms/goal-form';
import { DebriefFormComponent } from '../ui/forms/debrief-form';
import { IconComponent } from '../ui/icon';
import { AiExportDialogComponent } from '../ui/forms/ai-export-dialog';
import { MotionService } from '../ui/motion';

type Part = GoalPart | 'confiance' | 'bilan';

interface PartTile {
  id: Part;
  title: string;
  value: string;
  note: string;
}

const TONE: Record<string, string> = { good: 'var(--good)', neutral: 'var(--series-1)', warning: 'var(--warning)', serious: 'var(--serious)' };
const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const pct = (x: number) => `${x > 0 ? '+' : '−'}${fixed(Math.abs(x), 1)} %`;

/**
 * Fiche d'un objectif (`/courses/:id`) : l'essentiel en tête (indice et chrono probable, ou le bilan d'une course passée),
 * puis une petite carte par partie ; la carte touchée ouvre la partie en dessous (`?partie=`).
 */
@Component({
  selector: 'app-goal',
  imports: [RouterLink, GoalCardComponent, RaceDebriefComponent, ConfidenceHistoryComponent, GoalFormComponent, DebriefFormComponent, IconComponent, AiExportDialogComponent],
  template: `
    <a class="back" routerLink="/courses"><app-icon name="back" />Courses</a>
    <app-goal-form #goalForm />
    <app-debrief-form #debriefForm />
    <app-ai-export-dialog #aiDialog />

    @if (ev(); as e) {
      @let g = e.goal;
      <header class="page-head vt-hero">
        <div>
          <h1>{{ g.name }}</h1>
          <p class="lede">
            {{ dateLabel(g.date) }}{{ g.startTime ? ' · départ ' + startLabel(g.startTime) : '' }} ·
            {{ num(g.distanceKm, g.distanceKm % 1 ? 1 : 0) }} km{{ g.elevGain ? ' · ' + num(g.elevGain) + ' m D+' + (g.elevLoss ? ' / ' + num(g.elevLoss) + ' m D−' : '') : '' }}
            @if (g.kind === 'trail') {
              · {{ num(e.ke) }} km-effort, ≈ {{ num(e.effortKm) }} km équivalent plat pour toi
            }
            @if (g.targetSec) {
              · objectif {{ clock(g.targetSec) }}
            }
          </p>
        </div>
        <span class="countdown display">{{ archived() ? 'Terminé' : e.daysLeft > 0 ? 'J-' + e.daysLeft : 'Jour J' }}</span>
      </header>

      <div class="row-actions">
        @if (!archived()) {
          <button type="button" class="btn small" (click)="aiDialog.open({ goal: e }, 'goal')"><app-icon name="chat" />En discuter avec une IA</button>
          <button type="button" class="btn small" (click)="aiDialog.open({ goal: e }, 'plan')"><app-icon name="list" />Plan d'entraînement avec une IA</button>
        } @else if (debrief()) {
          <button type="button" class="btn small" (click)="aiDialog.open({ goal: e }, 'debrief')"><app-icon name="chat" />Bilan avec une IA</button>
        }
        @if (entries.available()) {
          @if (archived()) {
            <button type="button" class="btn small" (click)="debriefForm.open(g)">
              <app-icon [name]="g.debrief ? 'edit' : 'plus'" />{{ g.debrief ? 'Modifier le bilan' : 'Temps puce, gels, ressenti' }}
            </button>
          }
          <button type="button" class="btn small" (click)="goalForm.open(g)"><app-icon name="edit" />Modifier l'objectif</button>
        }
      </div>

      @if (!archived()) {
        <app-goal-card [ev]="e" part="chrono" [framed]="true" />
      }

      <div class="tiles" role="tablist" aria-label="Parties">
        @for (t of tiles(); track t.id) {
          <button type="button" role="tab" class="card tile" [class.active]="part() === t.id" [attr.aria-selected]="part() === t.id"
            [style.--tone]="t.id === 'confiance' ? tone(e) : null" (click)="open(t.id)">
            <span class="t-title">{{ t.title }}</span>
            <span class="t-value" [class.tone]="t.id === 'confiance'">{{ t.value }}</span>
            <span class="t-note muted">{{ t.note }}</span>
          </button>
        }
      </div>

      <section class="card panel" #panel>
        <h2>{{ currentTitle() }}</h2>
        @switch (part()) {
          @case ('bilan') {
            @if (debrief(); as d) {
              <app-race-debrief [ev]="e" [debrief]="d" [framed]="false" />
            } @else {
              <p>Pas de sortie trouvée pour {{ g.name }} le jour de la course (même jour ou lendemain, distance à ±15 %) : synchronise les données {{ sci.caps().label }}.</p>
            }
          }
          @case ('confiance') { <app-confidence-history [ev]="e" /> }
          @default { <app-goal-card [ev]="e" [part]="cardPart()" /> }
        }
      </section>
    } @else {
      <div class="card missing">
        <p>Cette course n'existe pas (ou plus) dans tes objectifs.</p>
        <a class="btn" routerLink="/courses">Voir toutes les courses</a>
      </div>
    }
  `,
  styles: `
    :host { display: grid; gap: 1.1rem; }
    .back {
      justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; min-height: 44px; margin: 1rem 0 -1rem;
      color: var(--accent-text); font-weight: 600; text-decoration: none;
    }
    .page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .page-head .lede { margin-top: 0.3rem; }
    .countdown { font-size: 2.2rem; color: var(--accent); white-space: nowrap; }
    .row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin: -0.4rem 0 -0.3rem; }
    .tiles { display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fill, minmax(min(46%, 170px), 1fr)); }
    .tile { display: grid; gap: 0.25rem; align-content: start; text-align: left; font: inherit; color: inherit; cursor: pointer; padding: 0.85rem 0.95rem; }
    .tile.active { border-color: var(--accent); background: var(--accent-soft); }
    .t-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .t-value { font-family: var(--font-display); font-stretch: var(--display-stretch); font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; font-size: 1.6rem; color: var(--text-primary); }
    .t-value.tone { color: var(--tone); }
    .t-note { font-size: 0.8rem; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .panel { display: grid; gap: 1rem; scroll-margin-top: 1rem; }
    .panel h2 { margin: 0; }
    .missing { display: grid; gap: 0.75rem; justify-items: start; }
    @media (max-width: 600px) {
      .countdown { font-size: 1.6rem; }
      .tile { padding: 0.7rem 0.8rem; }
      .t-value { font-size: 1.1rem; }
    }
  `,
})
export class GoalPage {
  protected readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.paramMap);
  private readonly query = toSignal(this.route.queryParamMap);
  /** Partie touchée (prioritaire sur `?partie=`, lu à l'arrivée sur la page) */
  private readonly picked = signal<Part | null>(null);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly clock = clock;
  protected readonly num = num;

  protected readonly ev = computed(() => this.sci.goals().find((e) => e.goal.id === this.params()?.get('id')) ?? null);

  constructor() {
    // Au retour, la carte de cet objectif (Courses, Aujourd'hui) reprend la place de l'en-tête
    const motion = inject(MotionService);
    effect(() => {
      const id = this.params()?.get('id');
      if (id) motion.last = 'goal:' + id;
    });
  }
  protected readonly archived = computed(() => {
    const e = this.ev();
    return !!e && this.sci.archivedGoals().includes(e);
  });
  protected readonly debrief = computed<RaceDebrief | null>(() => this.sci.debriefs().get(this.ev()?.goal.id ?? '') ?? null);

  protected readonly tiles = computed<PartTile[]>(() => {
    const e = this.ev();
    if (!e) return [];
    const g = e.goal;
    const archived = this.archived();
    const chance = e.probability !== null;
    const out: PartTile[] = [];
    if (archived) {
      const d = this.debrief();
      const gap = d && g.targetSec ? d.official - g.targetSec : null;
      out.push({
        id: 'bilan',
        title: 'Bilan',
        value: d ? clock(d.official) : '–',
        note: !d ? 'sortie non trouvée' : gap === null ? `prédit ${clock(e.predicted)}` : gap <= 0 ? 'objectif atteint' : `manqué de ${clock(gap)}`,
      });
    }
    out.push({
      id: 'confiance',
      title: archived ? 'Indice jusqu\'à la veille' : 'Évolution de l\'indice',
      value: `${e.index}${chance ? ' %' : '/100'}`,
      note: e.verdict.label + (chance ? ` sous ${clock(g.targetSec!)}` : ' pour finir'),
    });
    if (archived) {
      out.push({ id: 'chrono', title: 'Prédiction de la veille', value: clock(e.predicted), note: `8 chances sur 10 entre ${clock(e.low)} et ${clock(e.high)}` });
    }
    const cruise = g.targetSec ?? e.predicted;
    out.push({
      id: 'strategie',
      title: 'Stratégie',
      value: `${pace(cruise / g.distanceKm)} /km`,
      note: `${g.targetSec ? 'allure cible' : 'allure probable'} · ${e.plan.segments.length} tronçons, ${e.plan.blocks.length} fiches`,
    });
    const weakest = [...e.readiness].sort((a, b) => a.score - b.score)[0];
    out.push({
      id: 'preparation',
      title: 'Préparation',
      value: `${Math.round(e.readinessScore * 100)}/100`,
      note: weakest && weakest.score < 0.95 ? `à travailler : ${weakest.label.toLowerCase()}` : 'fondations en place',
    });
    if (e.raceRefs.length) {
      out.push({
        id: 'references',
        title: 'Courses de référence',
        value: String(e.raceRefs.length),
        note: e.progression ? `niveau projeté ${clock(e.progression.projected)}` : e.raceRefs[0].activity.name,
      });
    }
    out.push({ id: 'modeles', title: 'Modèles', value: clock(e.base), note: `consensus de ${e.models.length} modèle${e.models.length > 1 ? 's' : ''}` });
    const total = (e.adjustments.reduce((f, a) => f * (1 + a.pct / 100), 1) - 1) * 100;
    out.push({
      id: 'ajustements',
      title: 'Ajustements du jour J',
      value: total > 0.05 ? pct(total) : 'neutre',
      note: e.adjustments.length ? e.adjustments.map((a) => a.label.toLowerCase()).join(', ') : 'pris en compte dans les 3 dernières semaines',
    });
    if (!archived && e.advice.length) {
      out.push({ id: 'conseils', title: 'Conseils', value: String(e.advice.length), note: e.advice[0] });
    }
    return out;
  });

  protected readonly part = computed<Part>(() => {
    const asked = this.picked() ?? this.query()?.get('partie');
    const tiles = this.tiles();
    return tiles.find((t) => t.id === asked)?.id ?? tiles[0]?.id ?? 'confiance';
  });
  protected readonly cardPart = computed(() => this.part() as GoalPart);
  protected readonly currentTitle = computed(() => this.tiles().find((t) => t.id === this.part())?.title ?? '');

  protected open(id: Part): void {
    // L'adresse suit la partie ouverte, sans navigation du routeur (qui remonterait en haut de page)
    this.picked.set(id);
    const url = this.router.createUrlTree([], { relativeTo: this.route, queryParams: { partie: id }, queryParamsHandling: 'merge' });
    this.location.replaceState(this.router.serializeUrl(url));
    // Sur téléphone, la partie ouverte est sous les cartes : la faire apparaître
    setTimeout(() => {
      const el = this.panel()?.nativeElement;
      if (el && el.getBoundingClientRect().top > window.innerHeight * 0.6) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  protected tone = (e: GoalEvaluation) => TONE[e.verdict.tone];
  protected dateLabel = (iso: string) => {
    const d = longDate.format(parseDay(iso));
    return d.charAt(0).toUpperCase() + d.slice(1);
  };
  protected startLabel = (t: string) => (t === '00:00' ? 'à minuit' : `${Number(t.slice(0, 2))} h ${t.slice(3)}`);
}
