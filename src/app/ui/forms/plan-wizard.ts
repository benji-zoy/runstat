import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { AiExportService } from '../../core/ai-export.service';
import { AiDetail } from '../../core/ai/context';
import {
  CycleRequest, HILL_LABELS, HillLength, HillSlope, MOUNTAIN_LABELS, MountainAccess, PlanMode, PlanRequest, PlanTerrain, ROLLING_LABELS,
  RollingAccess, SLOPE_LABELS, STRENGTH_LABELS, StrengthFocus,
} from '../../core/ai/exports';
import { DataService } from '../../core/data.service';
import { EntriesService } from '../../core/entries.service';
import { GoalEvaluation } from '../../core/goals';
import { WEEKDAYS } from '../../core/insights';
import { PeriodService } from '../../core/period.service';
import { ambitiousAdvised, bandOf, currentWeekly, recommendedSessions, recommendedVolume, volumeBands, VolumeBand } from '../../core/plan';
import { secondaryChecks } from '../../core/plan-checks';
import { FOCUS, FOCUS_ORDER, TEST_DISTANCES, cycleId, cycleName, cycleTest, cycleVolume, nextMonday } from '../../core/cycle';
import { Cycle, CycleFocus, Goal } from '../../core/models';
import { addDays, isoDay, parseDay } from '../../core/stats';
import { goalId } from './goal-form';
import { ScienceService } from '../../core/science.service';
import { clock, num } from '../../core/format';
import { IconComponent } from '../icon';
import { GoalFormComponent } from './goal-form';
import { errorList } from './form-dialog';
import { canCopy, canShare, copyDoc, downloadDoc, shareDoc } from './md-delivery';

type Step = 'but' | 'secondaires' | 'volume' | 'seances' | 'terrain' | 'mode' | 'renfo' | 'recap';
const COMMON: { id: Step; title: string }[] = [
  { id: 'volume', title: 'Volume' },
  { id: 'seances', title: 'Séances' },
  { id: 'terrain', title: 'Terrain' },
  { id: 'mode', title: 'Intensité' },
  { id: 'renfo', title: 'Renforcement' },
  { id: 'recap', title: 'Récapitulatif' },
];
/** Plan vers une course : courses de préparation d'abord ; cycle sans course : son but d'abord */
const GOAL_STEPS = [{ id: 'secondaires' as Step, title: 'Courses de préparation' }, ...COMMON];
const CYCLE_STEPS = [{ id: 'but' as Step, title: 'Ton but' }, ...COMMON];
const WEEK_CHOICES = [4, 6, 8, 10, 12, 16];

/** Choix gardés sur l'appareil, par objectif (rouvrir l'assistant les retrouve) */
interface Saved {
  band: number | null;
  sessions: number[];
  days: number[];
  longDays: number[];
  mode: PlanMode | null;
  strength: { day: number; focus: StrengthFocus }[] | null;
  vision: string;
  injuries: string;
}
const key = (id: string) => `runstat-plan-${id}`;
function load(id: string): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(key(id)) ?? '{}');
  } catch {
    return {};
  }
}
function store(id: string, s: Saved): void {
  try {
    localStorage.setItem(key(id), JSON.stringify(s));
  } catch {
    /* navigation privée */
  }
}

const DETAIL_KEY = 'runstat-ai-detail';
/** Le terrain ne change pas d'un plan à l'autre : gardé une fois pour toutes sur l'appareil */
const TERRAIN_KEY = 'runstat-plan-terrain';
const HEALTH_KEY = 'runstat-ai-sante';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/**
 * « Préparer mon plan » : écrans successifs (courses de préparation, volume, séances, intensité, renfo, récapitulatif) puis
 * le texte à donner à une IA. Rien n'est envoyé par RunStat ; le plan rendu par l'IA s'importe ensuite (plan-import.ts).
 */
@Component({
  selector: 'app-plan-wizard',
  imports: [IconComponent, GoalFormComponent],
  template: `
    <app-goal-form #goalForm />
    <dialog #dlg class="sheet wizard" aria-label="Préparer mon plan" (close)="closed()">
      @if (active()) {
        <form novalidate (submit)="$event.preventDefault(); next()">
          <header>
            <div>
              <p class="kicker">{{ index() + 1 }} / {{ steps().length }} · {{ steps()[index()].title }}</p>
              <h2>{{ heading() }}</h2>
            </div>
            <button type="button" class="icon-btn" (click)="close()" aria-label="Fermer"><app-icon name="close" /></button>
          </header>
          <div class="progress" aria-hidden="true"><span [style.width.%]="((index() + 1) / steps().length) * 100"></span></div>

          <div class="body">
            @switch (step()) {
              @case ('but') {
                <p class="q">Quel est ton but pour ce cycle ?</p>
                <div class="options" role="radiogroup" aria-label="But du cycle">
                  @for (f of focusOrder; track f) {
                    <button type="button" class="opt card-opt" role="radio" [class.active]="focus() === f" [attr.aria-checked]="focus() === f" (click)="pickFocus(f)">
                      <span><b>{{ focusInfo[f].label }}</b></span>
                      <small class="muted">{{ focusInfo[f].hint }}</small>
                    </button>
                  }
                </div>
                <div class="field">Durée
                  <div class="chips nums" role="group" aria-label="Durée en semaines">
                    @for (w of weekChoices; track w) {
                      <button type="button" class="chip" [class.active]="weeks() === w" [attr.aria-pressed]="weeks() === w" (click)="weeks.set(w)">{{ w }}</button>
                    }
                  </div>
                  <span class="hint">semaines · conseillé : {{ focusInfo[focus()].weeks }} · 16 au plus (limite d'un plan COROS)</span>
                </div>
                <label class="field">Début
                  <input type="date" [value]="start()" (change)="start.set($any($event.target).value || start())" />
                  <span class="hint">Jusqu'au {{ lastDay() }}. Pour l'envoyer dans COROS, le cycle doit commencer dans les 14 jours.</span>
                </label>
                <div class="field">Test chronométré la dernière semaine
                  <div class="chips" role="group" aria-label="Test de fin de cycle">
                    <button type="button" class="chip" [class.active]="testKm() === null" (click)="testKm.set(null)">Sans test</button>
                    @for (k of testDistances; track k) {
                      <button type="button" class="chip" [class.active]="testKm() === k" (click)="testKm.set(k)">{{ k }} km</button>
                    }
                  </div>
                  <span class="hint">{{ focusInfo[focus()].testKm ? 'Conseillé : ' + focusInfo[focus()].testKm + ' km' : 'Conseillé : sans test' }} · le test apparaît dans Courses, avec son chrono probable puis son bilan.</span>
                </div>
                @if (error(); as err) {
                  <p class="alert warn" role="alert">{{ err }}</p>
                }
              }
              @case ('secondaires') {
                @if (live(); as e) {
                <p class="q">Des courses de préparation avant {{ e.goal.name }} ?</p>
                <p class="muted small">Elles sont intégrées au plan (allègement avant, récupération après). Coche celles qui en font partie.</p>
                @if (candidates().length) {
                  <ul class="list">
                    @for (c of candidates(); track c.goal.id) {
                      <li>
                        <label class="check">
                          <input type="checkbox" [checked]="c.goal.parent === e.goal.id" [disabled]="entries.saving()" (change)="link(c, $any($event.target).checked)" />
                          <span>
                            <b>{{ c.goal.name }}</b>
                            <small class="muted">{{ c.goal.date }} · {{ num(c.goal.distanceKm, c.goal.distanceKm % 1 ? 1 : 0) }} km{{ c.goal.targetSec ? ' · ' + clock(c.goal.targetSec) : '' }} · {{ weeksBefore(c) }}</small>
                          </span>
                        </label>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="muted small">Aucune autre course prévue avant celle-ci.</p>
                }
                @if (entries.available()) {
                  <button type="button" class="btn small add" (click)="goalForm.open(undefined, { parent: e.goal.id })"><app-icon name="plus" />Ajouter une course de préparation</button>
                }
                @for (c of checks(); track $index) {
                  <p class="alert" [class.warn]="c.level === 'warning'">{{ c.text }}</p>
                }
                @if (error(); as err) {
                  <p class="alert warn" role="alert">{{ err }}</p>
                }
                }
              }
              @case ('volume') {
                <p class="q">Combien de km par semaine au plus fort {{ kind() === 'cycle' ? 'du cycle' : 'du plan' }} ?</p>
                <p class="muted small">Aujourd'hui : {{ num(weekly()) }} km/semaine en moyenne sur 6 semaines. Conseillé : ≈ {{ num(recommended()) }} km.</p>
                <div class="options" role="radiogroup" aria-label="Volume au plus fort">
                  @for (b of bands(); track $index) {
                    <button type="button" class="opt" role="radio" [class.active]="band() === $index" [attr.aria-checked]="band() === $index" (click)="band.set($index)">
                      <span>{{ bandLabel(b) }}</span>
                      @if ($index === recommendedBand()) {
                        <span class="tag">Conseillé</span>
                      }
                    </button>
                  }
                </div>
              }
              @case ('seances') {
                <p class="q">Combien de séances de course par semaine ?</p>
                <p class="muted small">Choisis un nombre, ou deux qui se suivent (3 et 4 : le plan alterne selon la semaine et la phase).</p>
                <div class="chips nums" role="group" aria-label="Séances par semaine">
                  @for (n of counts; track n) {
                    <button type="button" class="chip" [class.active]="sessions().includes(n)" [attr.aria-pressed]="sessions().includes(n)" (click)="pickSessions(n)">{{ n }}</button>
                  }
                </div>
                <p class="small"><span class="tag">Conseillé : {{ recommendedCount() }}</span>
                  @if (sessions().length === 2) {
                    <span class="muted"> → {{ sessions()[0] }} séances les semaines légères, {{ sessions()[1] }} en charge</span>
                  }
                </p>
                <div class="field">Jours où tu peux courir
                  <div class="chips" role="group" aria-label="Jours où tu peux courir">
                    @for (d of weekdays; track $index) {
                      <button type="button" class="chip" [class.active]="days().includes($index)" [attr.aria-pressed]="days().includes($index)" (click)="toggle(days, $index)">{{ d.slice(0, 3) }}</button>
                    }
                  </div>
                  <span class="hint">Aucun choisi : indifférent.</span>
                </div>
                <div class="field">Sortie longue (deux jours au plus)
                  <div class="chips" role="group" aria-label="Jours de sortie longue">
                    @for (d of weekdays; track $index) {
                      <button type="button" class="chip" [class.active]="longDays().includes($index)" [attr.aria-pressed]="longDays().includes($index)" (click)="toggleLong($index)">{{ d.slice(0, 3) }}</button>
                    }
                  </div>
                </div>
                @if (sessionsWarning(); as w) {
                  <p class="alert">{{ w }}</p>
                }
              }
              @case ('terrain') {
                <p class="q">Où peux-tu courir ?</p>
                <div class="field">La plus longue côte près de chez toi
                  <div class="options" role="radiogroup" aria-label="Plus longue côte">
                    @for (h of hills; track h) {
                      <button type="button" class="opt" role="radio" [class.active]="hill() === h" [attr.aria-checked]="hill() === h" (click)="hill.set(h)">
                        <span>{{ cap(hillLabels[h]) }}</span>
                      </button>
                    }
                  </div>
                  <span class="hint">Elle sert aussi aux répétitions plus courtes : sur une côte de 300 m, des sprints de 100 m sont possibles.</span>
                </div>
                @if (hill() === 'medium' || hill() === 'long') {
                  <div class="field">Sa pente <span class="hint">(facultatif)</span>
                    <div class="chips" role="group" aria-label="Pente">
                      @for (p of slopes; track p) {
                        <button type="button" class="chip" [class.active]="slope() === p" (click)="slope.set(slope() === p ? null : p)">{{ cap(slopeLabels[p]) }}</button>
                      }
                    </div>
                  </div>
                }
                @if (trail()) {
                  <div class="field">Terrain vallonné (type coteaux)
                    <div class="chips" role="group" aria-label="Terrain vallonné">
                      @for (r of rollings; track r) {
                        <button type="button" class="chip" [class.active]="rolling() === r" (click)="rolling.set(r)">{{ cap(rollingLabels[r]) }}</button>
                      }
                    </div>
                  </div>
                  <div class="field">Montagne
                    <div class="chips" role="group" aria-label="Montagne">
                      @for (m of mountains; track m) {
                        <button type="button" class="chip" [class.active]="mountain() === m" (click)="mountain.set(m)">{{ cap(mountainLabels[m]) }}</button>
                      }
                    </div>
                  </div>
                }
              }
              @case ('mode') {
                <p class="q">Quelle intensité ?</p>
                <div class="options">
                  <button type="button" class="opt card-opt" [class.active]="mode() === 'normal'" (click)="mode.set('normal')">
                    <span><b>Normal</b> @if (!advisedAmbitious()) { <span class="tag">Conseillé</span> }</span>
                    <small class="muted">Une séance de qualité par semaine, deux en période de développement.</small>
                  </button>
                  <button type="button" class="opt card-opt" [class.active]="mode() === 'ambitious'" (click)="mode.set('ambitious')">
                    <span><b>Ambitieux</b> @if (advisedAmbitious()) { <span class="tag">Conseillé</span> }</span>
                    <small class="muted">Jusqu'à deux séances de qualité, des blocs un peu plus longs et plus durs, toujours raisonnables.</small>
                  </button>
                </div>
                @if (live(); as e) {
                  @if (e.probability !== null) {
                    <p class="muted small">Objectif {{ clock(e.goal.targetSec!) }} : {{ num(e.probability * 100) }} % de chances aujourd'hui ({{ e.verdict.label.toLowerCase() }}).
                      {{ advisedAmbitious() ? 'Le mode ambitieux t’aide à combler l’écart.' : 'Le mode normal suffit pour le tenir.' }}</p>
                  }
                } @else {
                  <p class="muted small">{{ advisedAmbitious() ? 'Pour gagner en vitesse, le mode ambitieux est conseillé.' : 'Pour ce but, le mode normal est conseillé.' }}</p>
                }
              }
              @case ('renfo') {
                <p class="q">Du renforcement musculaire ?</p>
                <div class="seg" role="group" aria-label="Renforcement">
                  <button type="button" [class.active]="strength() !== null" (click)="strengthOn(true)">Oui</button>
                  <button type="button" [class.active]="strength() === null" (click)="strengthOn(false)">Non</button>
                </div>
                @if (strength(); as rows) {
                  @for (r of rows; track $index) {
                    <div class="renfo-row">
                      <select [value]="r.day" (change)="setStrength($index, { day: +$any($event.target).value })" aria-label="Jour">
                        @for (d of weekdays; track $index) {
                          <option [value]="$index" [selected]="$index === r.day">{{ d }}</option>
                        }
                      </select>
                      <div class="seg small" role="group" aria-label="Zone du corps">
                        @for (f of focuses; track f) {
                          <button type="button" [class.active]="r.focus === f" (click)="setStrength($index, { focus: f })">{{ focusLabel(f) }}</button>
                        }
                      </div>
                      <button type="button" class="icon-btn" (click)="removeStrength($index)" aria-label="Retirer ce jour"><app-icon name="close" /></button>
                    </div>
                  }
                  @if (rows.length < 4) {
                    <button type="button" class="btn small add" (click)="addStrength()"><app-icon name="plus" />Ajouter un jour</button>
                  }
                  <p class="muted small">Le renfo reste dans RunStat : COROS ne le reçoit pas.</p>
                }
              }
              @case ('recap') {
                <p class="summary">{{ summary() }}</p>
                <label class="field">Ta vision du plan, tes contraintes
                  <textarea rows="3" maxlength="800" [value]="vision()" (input)="vision.set($any($event.target).value)"
                    placeholder="Ex. club le mardi soir, vacances du 20 au 27, je préfère courir tôt le matin"></textarea>
                </label>
                <label class="field">Gênes, blessures actuelles ou récentes
                  <textarea rows="2" maxlength="500" [value]="injuries()" (input)="injuries.set($any($event.target).value)"
                    placeholder="Ex. tendon d'Achille sensible depuis septembre"></textarea>
                </label>
                <div class="opts">
                  <div class="field">Niveau de détail
                    <div class="seg" role="group" aria-label="Niveau de détail">
                      <button type="button" [class.active]="detail() === 'summary'" (click)="detail.set('summary')">Résumé</button>
                      <button type="button" [class.active]="detail() === 'full'" (click)="detail.set('full')">Complet</button>
                    </div>
                  </div>
                  @if (ai.hasHealth()) {
                    <label class="check">
                      <input type="checkbox" [checked]="health()" (change)="health.set($any($event.target).checked)" />
                      <span>Inclure ma santé <small class="muted">sommeil, VFC, FC de repos, poids</small></span>
                    </label>
                  }
                </div>
                @if (doc(); as d) {
                  <p class="muted small">≈ {{ tokens(d.tokens) }} jetons · aucune coordonnée GPS, aucun nom de sortie ni de tiers. Donne ce texte à l'IA de ton choix, puis importe sa réponse avec « {{ kind() === 'cycle' ? 'Importer le cycle' : 'Importer le plan' }} ».</p>
                  <details class="preview">
                    <summary>Aperçu du texte</summary>
                    <pre>{{ d.markdown }}</pre>
                  </details>
                }
                @if (status(); as s) {
                  <p class="status" role="status">{{ s }}</p>
                }
              }
            }
          </div>

          <footer [class.recap]="step() === 'recap'">
            @if (index() > 0) {
              <button type="button" class="btn back" (click)="back()" aria-label="Retour"><app-icon name="back" /><span class="back-label">Retour</span></button>
            }
            <span class="spacer"></span>
            @if (step() === 'recap') {
              @if (canShare) {
                <button type="button" class="btn act" (click)="share()"><app-icon name="share" />Partager</button>
              }
              <button type="button" class="btn act" (click)="download()"><app-icon name="download" />Télécharger</button>
              @if (canCopy) {
                <button type="button" class="btn primary act" (click)="copy()"><app-icon name="copy" />Copier</button>
              }
            } @else {
              <button type="submit" class="btn primary" [disabled]="entries.saving()">Suivant</button>
            }
          </footer>
        </form>
      }
    </dialog>
  `,
  styles: `
    .kicker { margin: 0 0 0.15rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); }
    .progress { height: 3px; background: var(--surface-3); }
    .progress span { display: block; height: 100%; background: var(--accent-fill); transition: width var(--dur-long, 0.3s) var(--ease-arrivee, ease-out); }
    .q { margin: 0; font-family: var(--font-display); font-stretch: var(--display-stretch); font-weight: 800; font-size: 1.25rem; line-height: 1.15; }
    .small { margin: 0; font-size: 0.85rem; }
    .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
    .check { display: flex; align-items: center; gap: 0.6rem; min-height: 44px; cursor: pointer; font-size: 0.92rem; }
    .check input { width: 1.15rem; height: 1.15rem; accent-color: var(--accent-fill); flex: none; }
    .check small { display: block; font-size: 0.78rem; }
    .add { justify-self: start; }
    .alert { margin: 0; padding: 0.55rem 0.7rem; border-radius: var(--radius-s); background: var(--surface-2); border-left: 3px solid var(--border); font-size: 0.85rem; line-height: 1.4; }
    .alert.warn { border-left-color: var(--warning); }
    .options { display: grid; gap: 0.45rem; }
    .opt {
      display: flex; justify-content: space-between; align-items: center; gap: 0.6rem; min-height: 48px; padding: 0.6rem 0.85rem;
      font: 600 0.95rem var(--font-body); color: var(--text-primary); text-align: left; cursor: pointer;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
    }
    .opt.active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .card-opt { flex-direction: column; align-items: flex-start; }
    .card-opt small { font-weight: 400; font-size: 0.83rem; }
    .card-opt .tag { margin-left: 0.45rem; }
    .tag { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 6px; font-size: 0.72rem; font-weight: 700; background: var(--accent-fill); color: var(--on-accent); }
    .nums .chip { min-width: 44px; min-height: 44px; font-size: 1rem; }
    /* Jour, zone du corps, croix : toujours sur une ligne, la croix au bout (téléphone compris) */
    .renfo-row { display: grid; grid-template-columns: minmax(0, 7.5rem) minmax(0, 1fr) 40px; align-items: center; gap: 0.4rem; }
    .renfo-row select { min-width: 0; width: 100%; }
    .renfo-row .seg { display: flex; min-width: 0; }
    .renfo-row .seg button { flex: 1; min-width: 0; padding-inline: 0.3rem; }
    .renfo-row select { font: 400 0.95rem var(--font-body); color: var(--text-primary); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-s); min-height: 40px; padding: 0 0.5rem; }
    .renfo-row .icon-btn {
      display: inline-grid; place-items: center; width: 40px; height: 40px; padding: 0; cursor: pointer;
      color: var(--text-secondary); background: transparent; border: 1px solid var(--border); border-radius: var(--radius-s);
    }
    .summary { margin: 0; padding: 0.7rem 0.85rem; border-radius: var(--radius); background: var(--surface-2); font-size: 0.9rem; line-height: 1.5; }
    .opts { display: flex; flex-wrap: wrap; align-items: end; gap: 0.9rem 1.5rem; }
    .preview summary { cursor: pointer; font-weight: 600; font-size: 0.88rem; color: var(--accent-text); }
    .preview pre { margin: 0.5rem 0 0; max-height: 40vh; overflow: auto; padding: 0.7rem; border-radius: 8px; background: var(--surface-2); font: 0.75rem/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
    .status { margin: 0; font-size: 0.85rem; color: var(--accent-text); }
    /* Récapitulatif : partager, télécharger et copier sur une seule ligne, téléphone compris */
    footer.recap { flex-wrap: nowrap; }
    @media (max-width: 640px) {
      footer.recap { gap: 0.4rem; }
      footer.recap .spacer { display: none; }
      footer.recap .back-label { display: none; }
      footer.recap .back { flex: none; padding-inline: 0.6rem; }
      footer.recap .act { flex: 1 1 0; min-width: 0; justify-content: center; gap: 0.3rem; padding-inline: 0.4rem; font-size: 0.85rem; white-space: nowrap; }
    }
  `,
})
export class PlanWizardComponent {
  protected readonly ai = inject(AiExportService);
  protected readonly entries = inject(EntriesService);
  private readonly sci = inject(ScienceService);
  private readonly data = inject(DataService);
  private readonly today = inject(PeriodService).today;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly focusOrder = FOCUS_ORDER;
  protected readonly focusInfo = FOCUS;
  protected readonly weekChoices = WEEK_CHOICES;
  protected readonly testDistances = TEST_DISTANCES;
  protected readonly hills: HillLength[] = ['none', 'short', 'medium', 'long'];
  protected readonly slopes: HillSlope[] = ['gentle', 'steep'];
  protected readonly rollings: RollingAccess[] = ['never', 'weekend', 'weekdays', 'anytime'];
  protected readonly mountains: MountainAccess[] = ['never', 'rare', 'some-weekends', 'regular'];
  protected readonly hillLabels = HILL_LABELS;
  protected readonly slopeLabels = SLOPE_LABELS;
  protected readonly rollingLabels = ROLLING_LABELS;
  protected readonly mountainLabels = MOUNTAIN_LABELS;
  protected cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  protected readonly weekdays = WEEKDAYS;
  protected readonly counts = [2, 3, 4, 5, 6, 7];
  protected readonly focuses: StrengthFocus[] = ['upper', 'lower', 'full'];
  protected readonly clock = clock;
  protected readonly num = num;
  protected readonly canCopy = canCopy();
  protected readonly canShare = canShare();

  /** Plan vers une course, ou cycle d'entraînement sans course */
  protected readonly kind = signal<'goal' | 'cycle'>('goal');
  protected readonly active = signal(false);
  /** Objectif ouvert : relu dans les évaluations à jour (un objectif secondaire ajouté change tout) */
  private readonly goalId = signal<string | null>(null);
  private readonly ev = signal<GoalEvaluation | null>(null);
  protected readonly live = computed(() => (this.kind() === 'goal' ? (this.sci.goals().find((e) => e.goal.id === this.goalId()) ?? this.ev()) : null));
  protected readonly steps = computed(() => (this.kind() === 'cycle' ? CYCLE_STEPS : GOAL_STEPS));
  protected readonly index = signal(0);
  protected readonly step = computed(() => this.steps()[this.index()].id);

  // Cycle : identifiant (null tant qu'il n'est pas enregistré), but, durée, début, test, cycle précédent
  private readonly cycleKey = signal<string | null>(null);
  protected readonly focus = signal<CycleFocus>('endurance');
  protected readonly weeks = signal(8);
  protected readonly start = signal('');
  protected readonly testKm = signal<number | null>(10);
  private readonly previous = signal<string | null>(null);
  protected readonly lastDay = computed(() => (this.start() ? isoDay(addDays(parseDay(this.start()), this.weeks() * 7 - 1)) : ''));
  private readonly cycle = computed(() => this.sci.cycles().find((c) => c.id === this.cycleKey()) ?? null);
  protected readonly heading = computed(() => (this.kind() === 'cycle' ? cycleName(this.focus(), this.start() || isoDay(this.today)) : `Plan pour ${this.live()?.goal.name ?? ''}`));
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<string | null>(null);

  protected readonly band = signal<number | null>(null);
  protected readonly sessions = signal<number[]>([]);
  protected readonly days = signal<number[]>([]);
  protected readonly longDays = signal<number[]>([5, 6]);
  protected readonly mode = signal<PlanMode>('normal');
  protected readonly strength = signal<{ day: number; focus: StrengthFocus }[] | null>(null);
  protected readonly vision = signal('');
  protected readonly injuries = signal('');
  protected readonly detail = signal<AiDetail>(read(DETAIL_KEY) === 'full' ? 'full' : 'summary');
  private readonly savedTerrain = ((): Partial<PlanTerrain> => {
    try {
      return JSON.parse(read(TERRAIN_KEY) ?? '{}');
    } catch {
      return {};
    }
  })();
  protected readonly hill = signal<HillLength | null>(this.savedTerrain.hill ?? null);
  protected readonly slope = signal<HillSlope | null>(this.savedTerrain.slope ?? null);
  protected readonly rolling = signal<RollingAccess | null>(this.savedTerrain.rolling ?? null);
  protected readonly mountain = signal<MountainAccess | null>(this.savedTerrain.mountain ?? null);
  /** Vallonné et montagne : seulement pour un trail (objectif trail, cycle « Trail ») */
  protected readonly trail = computed(() => (this.kind() === 'cycle' ? this.focus() === 'trail' : this.live()?.goal.kind === 'trail'));
  private readonly terrain = computed<PlanTerrain>(() => ({
    hill: this.hill(),
    slope: this.hill() === 'medium' || this.hill() === 'long' ? this.slope() : null,
    rolling: this.trail() ? this.rolling() : null,
    mountain: this.trail() ? this.mountain() : null,
  }));
  protected readonly health = signal(read(HEALTH_KEY) !== '0');

  protected readonly weekly = computed(() => currentWeekly(this.data.activities(), this.today));
  protected readonly recommended = computed(() => {
    if (this.kind() === 'cycle') return cycleVolume(this.focus(), this.weekly(), this.weeks());
    const e = this.live();
    return e ? recommendedVolume(e.goal, this.weekly(), this.today) : 0;
  });
  protected readonly bands = computed(() => volumeBands(this.recommended(), this.weekly()));
  protected readonly recommendedBand = computed(() => bandOf(this.bands(), this.recommended()));
  private readonly chosenBand = computed<VolumeBand | null>(() => this.bands()[this.band() ?? this.recommendedBand()] ?? null);
  protected readonly recommendedCount = computed(() => {
    const b = this.chosenBand();
    return recommendedSessions(b ? (b.max ?? b.min + 20) - 10 : this.recommended());
  });
  protected readonly advisedAmbitious = computed(() => (this.kind() === 'cycle' ? this.focus() === 'speed' : ambitiousAdvised(this.live()?.probability ?? null)));

  /** Objectifs à venir avant celui-ci, sauf ceux qui préparent un autre objectif principal ou en ont eux-mêmes */
  protected readonly candidates = computed(() => {
    const e = this.live();
    if (!e) return [];
    const goals = this.data.data()?.goals ?? [];
    return this.sci
      .upcomingGoals()
      .filter((c) => c.goal.id !== e.goal.id && c.goal.date < e.goal.date && c.daysLeft >= 0)
      .filter((c) => (!c.goal.parent || c.goal.parent === e.goal.id) && !goals.some((g) => g.parent === c.goal.id));
  });
  protected readonly secondaries = computed(() => this.candidates().filter((c) => c.goal.parent === this.live()?.goal.id));
  protected readonly checks = computed(() => {
    const e = this.live();
    return e ? secondaryChecks(e, this.secondaries()) : [];
  });

  protected readonly sessionsWarning = computed(() => {
    const days = this.days();
    const max = Math.max(0, ...this.sessions());
    if (days.length && max > days.length) return `${max} séances pour ${days.length} jour${days.length > 1 ? 's' : ''} possible${days.length > 1 ? 's' : ''} : ajoute des jours ou réduis le nombre de séances.`;
    if (days.length && this.longDays().some((d) => !days.includes(d))) return 'Un jour de sortie longue n’est pas parmi tes jours possibles.';
    return null;
  });

  private readonly cycleRequest = computed<CycleRequest | null>(() => {
    const c = this.cycle();
    if (!c) return null;
    const { secondaries, checks, ...choices } = this.request();
    const test = cycleTest(c, this.data.data()?.goals ?? []);
    const testEv = test ? this.sci.goals().find((e) => e.goal.id === test.id) : null;
    const prev = this.previous() ? this.sci.cycles().find((x) => x.id === this.previous()) : null;
    return {
      ...choices,
      cycle: { name: c.name, focusLabel: FOCUS[c.focus].label, focusPrompt: FOCUS[c.focus].prompt, start: c.start, weeks: c.weeks, trail: c.focus === 'trail' },
      test: test ? { km: test.distanceKm, date: test.date, predicted: testEv?.predicted ?? null } : null,
      previous: prev ? this.sci.cycleBilan(prev) : null,
    };
  });

  private readonly request = computed<PlanRequest>(() => {
    const s = this.sessions();
    return {
      volume: this.chosenBand(),
      sessions: s.length ? { min: Math.min(...s), max: Math.max(...s) } : null,
      days: this.days(),
      longDays: this.longDays(),
      mode: this.mode(),
      strength: this.strength(),
      vision: this.vision(),
      injuries: this.injuries(),
      terrain: this.terrain(),
      secondaries: this.secondaries(),
      checks: this.checks(),
    };
  });

  protected readonly doc = computed(() => {
    if (this.step() !== 'recap') return null;
    const opts = { detail: this.detail(), health: this.health() };
    if (this.kind() === 'cycle') {
      const r = this.cycleRequest();
      return r ? this.ai.buildCycle(opts, r) : null;
    }
    const e = this.live();
    return e ? this.ai.buildPlan(e, opts, this.request()) : null;
  });

  protected readonly summary = computed(() => {
    const r = this.request();
    const e = this.live();
    const c = this.cycle();
    if (!e && !c) return '';
    const weeks = c ? c.weeks : Math.max(1, Math.ceil(e!.daysLeft / 7));
    const test = c ? cycleTest(c, this.data.data()?.goals ?? []) : null;
    const parts = [
      c ? `${FOCUS[c.focus].label} : ${weeks} semaines à partir du ${c.start}` : `${weeks} semaine${weeks > 1 ? 's' : ''}`,
      c ? (test ? `test de ${test.distanceKm} km le ${test.date}` : 'sans test') : null,
      r.volume ? this.bandLabel(r.volume) + ' au plus fort' : null,
      r.sessions ? (r.sessions.min === r.sessions.max ? `${r.sessions.min} séances` : `${r.sessions.min} ou ${r.sessions.max} séances`) + ' par semaine' : null,
      r.longDays.length ? `sortie longue le ${r.longDays.map((d) => WEEKDAYS[d].toLowerCase()).join(' ou le ')}` : null,
      r.mode === 'ambitious' ? 'mode ambitieux' : 'mode normal',
      r.terrain?.hill ? (r.terrain.hill === 'none' ? 'pas de côte' : `côte ${HILL_LABELS[r.terrain.hill].replace(/ \(.*\)/, '')}`) : null,
      r.terrain?.rolling ? `vallonné ${ROLLING_LABELS[r.terrain.rolling]}` : null,
      r.terrain?.mountain ? `montagne ${MOUNTAIN_LABELS[r.terrain.mountain].replace(/,.*/, '')}` : null,
      r.strength?.length ? 'renfo ' + r.strength.map((x) => `${WEEKDAYS[x.day].toLowerCase()} (${STRENGTH_LABELS[x.focus]})`).join(', ') : 'sans renfo',
      r.secondaries.length ? `${r.secondaries.length} course${r.secondaries.length > 1 ? 's' : ''} de préparation` : null,
    ];
    return parts.filter(Boolean).join(' · ');
  });

  open(e: GoalEvaluation): void {
    this.kind.set('goal');
    this.ev.set(e);
    this.goalId.set(e.goal.id);
    this.restore(e.goal.id, ambitiousAdvised(e.probability));
  }

  /** Cycle sans course : `cycle` à modifier, ou null pour un nouveau ; `previous` : cycle dont il prend la suite */
  openCycle(cycle: Cycle | null, { previous }: { previous?: string } = {}): void {
    this.kind.set('cycle');
    this.ev.set(null);
    this.goalId.set(null);
    this.cycleKey.set(cycle?.id ?? null);
    const goals = this.data.data()?.goals ?? [];
    const prev = previous ? this.sci.cycles().find((c) => c.id === previous) : null;
    // Un cycle suivant commence le lendemain du précédent (ou au prochain lundi s'il est déjà passé)
    const after = prev ? isoDay(addDays(parseDay(this.sci.cycleState(prev).end), 1)) : null;
    const focus = cycle?.focus ?? prev?.focus ?? 'endurance';
    this.focus.set(focus);
    this.weeks.set(cycle?.weeks ?? FOCUS[focus].weeks);
    this.start.set(cycle?.start ?? (after && after >= isoDay(this.today) ? after : nextMonday(this.today)));
    this.testKm.set(cycle ? (cycleTest(cycle, goals)?.distanceKm ?? null) : FOCUS[focus].testKm);
    this.previous.set(cycle?.previous ?? previous ?? null);
    this.restore(cycle?.id ?? 'nouveau-cycle', focus === 'speed');
  }

  private restore(key: string, ambitious: boolean): void {
    const s = load(key);
    this.band.set(s.band ?? null);
    this.sessions.set(s.sessions ?? []);
    this.days.set(s.days ?? []);
    this.longDays.set(s.longDays ?? [5, 6]);
    this.mode.set(s.mode ?? (ambitious ? 'ambitious' : 'normal'));
    this.strength.set(s.strength ?? null);
    this.vision.set(s.vision ?? '');
    this.injuries.set(s.injuries ?? '');
    this.index.set(0);
    this.error.set(null);
    this.status.set(null);
    this.active.set(true);
    const d = this.dlg().nativeElement;
    if (!d.open) d.showModal();
  }

  protected closed(): void {
    this.active.set(false);
    this.ev.set(null);
  }

  /** Change de but : durée et test conseillés pour ce but */
  protected pickFocus(f: CycleFocus): void {
    this.focus.set(f);
    if (!this.cycle()) {
      this.weeks.set(FOCUS[f].weeks);
      this.testKm.set(FOCUS[f].testKm);
      this.mode.set(f === 'speed' ? 'ambitious' : 'normal');
    }
  }

  close(): void {
    this.save();
    this.dlg().nativeElement.close();
  }

  protected async next(): Promise<void> {
    if (this.step() === 'but' && !(await this.saveCycle())) return;
    this.save();
    if (this.step() === 'seances' && !this.sessions().length) this.sessions.set([this.recommendedCount()]);
    if (this.index() < this.steps().length - 1) this.go(this.index() + 1);
  }

  /**
   * Enregistre le cycle (création ou modification) et son test de fin (objectif rattaché par `cycle`, le dernier jour) ;
   * faux si la saisie est refusée.
   */
  private async saveCycle(): Promise<boolean> {
    this.error.set(null);
    const d = this.data.data();
    const cycles = d?.cycles ?? [];
    const goals = d?.goals ?? [];
    const start = this.start();
    if (!start) return (this.error.set('Indique la date de début'), false);
    const old = this.cycle();
    const taken = [...cycles.map((c) => c.id), ...goals.map((g) => g.id)];
    const id = old?.id ?? cycleId(this.focus(), start, taken);
    const cycle: Cycle = {
      id,
      name: cycleName(this.focus(), start),
      focus: this.focus(),
      start,
      weeks: this.weeks(),
      ...(this.previous() ? { previous: this.previous()! } : {}),
    };
    const km = this.testKm();
    const existing = goals.find((g) => g.cycle === id);
    const date = this.lastDay();
    let nextGoals: Goal[] | null = null;
    if (km) {
      const test: Goal = {
        ...(existing ?? {}),
        id: existing?.id ?? goalId(`test ${km} km`, date, taken),
        name: `Test ${km} km · ${FOCUS[this.focus()].label}`,
        date,
        distanceKm: km,
        kind: 'road',
        cycle: id,
      };
      if (!existing || existing.date !== test.date || existing.distanceKm !== km || existing.name !== test.name)
        nextGoals = existing ? goals.map((g) => (g.id === existing.id ? test : g)) : [...goals, test];
    } else if (existing) nextGoals = goals.filter((g) => g.id !== existing.id);
    try {
      await this.entries.saveCycles(old ? cycles.map((c) => (c.id === id ? { ...cycle, plan: c.plan } : c)) : [...cycles, cycle]);
      if (nextGoals) await this.entries.saveGoals(nextGoals);
      if (!old) {
        // Les choix de l'assistant passent du brouillon au cycle enregistré
        this.cycleKey.set(id);
        this.save();
      }
      return true;
    } catch (e) {
      this.error.set(errorList(e).join(' ; '));
      return false;
    }
  }

  protected back(): void {
    this.go(Math.max(0, this.index() - 1));
  }

  private go(i: number): void {
    // Volume pas choisi : le conseil
    if (this.step() === 'volume' && this.band() === null) this.band.set(this.recommendedBand());
    this.index.set(i);
    this.status.set(null);
    this.dlg().nativeElement.querySelector<HTMLElement>('.body')?.scrollTo(0, 0);
  }

  private save(): void {
    try {
      localStorage.setItem(TERRAIN_KEY, JSON.stringify({ hill: this.hill(), slope: this.slope(), rolling: this.rolling(), mountain: this.mountain() }));
    } catch {
      /* navigation privée */
    }
    const id = this.kind() === 'cycle' ? (this.cycleKey() ?? 'nouveau-cycle') : this.goalId();
    if (!id) return;
    store(id, {
      band: this.band(),
      sessions: this.sessions(),
      days: this.days(),
      longDays: this.longDays(),
      mode: this.mode(),
      strength: this.strength(),
      vision: this.vision(),
      injuries: this.injuries(),
    });
  }

  /** Coche ou décoche une course de préparation : enregistré tout de suite (champ `parent` de l'objectif) */
  protected async link(c: GoalEvaluation, on: boolean): Promise<void> {
    const main = this.live();
    if (!main) return;
    const goals = (this.data.data()?.goals ?? []).map((g) => {
      if (g.id !== c.goal.id) return g;
      const { parent, ...rest } = g;
      return on ? { ...rest, parent: main.goal.id } : rest;
    });
    this.error.set(null);
    try {
      await this.entries.saveGoals(goals);
    } catch (e) {
      this.error.set(errorList(e).join(' ; '));
    }
  }

  protected weeksBefore(c: GoalEvaluation): string {
    const e = this.live();
    if (!e) return '';
    const w = Math.round((e.daysLeft - c.daysLeft) / 7);
    return `${w} semaine${w > 1 ? 's' : ''} avant`;
  }

  /** Un nombre, ou deux qui se suivent : un clic à côté du choix l'étend, ailleurs le remplace */
  protected pickSessions(n: number): void {
    const cur = this.sessions();
    if (cur.length === 1 && cur[0] === n) return this.sessions.set([]);
    if (cur.length === 1 && Math.abs(cur[0] - n) === 1) return this.sessions.set([Math.min(n, cur[0]), Math.max(n, cur[0])]);
    if (cur.length === 2 && cur.includes(n)) return this.sessions.set(cur.filter((x) => x !== n));
    this.sessions.set([n]);
  }

  protected toggle(sig: typeof this.days, i: number): void {
    sig.update((ds) => (ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i].sort()));
  }

  protected toggleLong(i: number): void {
    this.longDays.update((ds) => (ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i].slice(-2).sort()));
  }

  protected strengthOn(on: boolean): void {
    if (!on) return this.strength.set(null);
    if (this.strength()) return;
    // Par défaut : un jour sans sortie longue, de préférence sans course
    const free = [0, 2, 3, 1, 4].find((d) => !this.longDays().includes(d)) ?? 0;
    this.strength.set([{ day: free, focus: 'full' }]);
  }

  protected addStrength(): void {
    const used = (this.strength() ?? []).map((r) => r.day);
    const day = [3, 0, 1, 4, 2, 5, 6].find((d) => !used.includes(d)) ?? 0;
    this.strength.update((rows) => [...(rows ?? []), { day, focus: 'lower' }]);
  }

  protected setStrength(i: number, patch: Partial<{ day: number; focus: StrengthFocus }>): void {
    this.strength.update((rows) => rows?.map((r, j) => (j === i ? { ...r, ...patch } : r)) ?? null);
  }

  protected removeStrength(i: number): void {
    this.strength.update((rows) => {
      const left = rows?.filter((_, j) => j !== i) ?? [];
      return left.length ? left : null;
    });
  }

  protected focusLabel = (f: StrengthFocus) => ({ upper: 'Haut', lower: 'Bas', full: 'Tout' })[f];
  protected bandLabel = (b: VolumeBand) => (b.max === null ? `${b.min} km et plus` : `${b.min} – ${b.max} km`);
  protected tokens = (x: number) => (Math.round(x / 100) * 100).toLocaleString('fr-FR');

  protected async copy(): Promise<void> {
    const d = this.doc();
    if (d) this.status.set(await copyDoc(d));
  }

  protected download(): void {
    const d = this.doc();
    if (d) this.status.set(downloadDoc(d));
  }

  protected async share(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    const msg = await shareDoc(d);
    if (msg) this.status.set(msg);
  }
}
