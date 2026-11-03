import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ScienceService } from '../core/science.service';
import { GoalEvaluation } from '../core/goals';
import { DistanceKey, REFERENCE_DISTANCES } from '../core/history';
import { officialDistance } from '../core/science';
import { clock, num } from '../core/format';
import { parseDay } from '../core/stats';
import { EntriesService } from '../core/entries.service';
import { GoalFormComponent } from '../ui/forms/goal-form';
import { ResultFormComponent } from '../ui/forms/result-form';
import { IconComponent } from '../ui/icon';
import { PredictionHistoryComponent } from '../sections/prediction-history';

const TONE: Record<string, string> = { good: 'var(--good)', neutral: 'var(--series-1)', warning: 'var(--warning)', serious: 'var(--serious)' };
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Courses : une petite carte par objectif (à venir, puis passés) qui ouvre sa fiche (`/courses/:id`), et la courbe des
 * chronos estimés sur les distances de référence. Les classements (barème FFA) sont dans Comprendre › classements.
 */
@Component({
  selector: 'app-goals',
  imports: [RouterLink, GoalFormComponent, ResultFormComponent, IconComponent, PredictionHistoryComponent],
  template: `
    <header class="page-head">
      <h1>Courses</h1>
      <p class="lede">Indice de confiance calculé sur tes données, mis à jour à chaque synchro. Touche une course pour son détail.</p>
      @if (entries.available()) {
        <div class="add">
          <button type="button" class="btn small" (click)="resultForm.declare()"><app-icon name="flag" />Course passée</button>
          <button type="button" class="btn small" (click)="goalForm.open()"><app-icon name="plus" />Objectif</button>
        </div>
      }
    </header>
    <app-goal-form #goalForm />
    <app-result-form #resultForm />

    <section class="section">
      <h2>À venir</h2>
      <div class="tiles">
        @for (e of upcoming(); track e.goal.id) {
          <a class="card tile" [routerLink]="['/courses', e.goal.id]" [style.--tone]="tone(e)">
            <div class="head">
              <h3>{{ e.goal.name }}</h3>
              <span class="days display">{{ e.daysLeft > 0 ? 'J-' + e.daysLeft : 'Jour J' }}</span>
            </div>
            <span class="muted small">{{ fmt(e.goal.date) }} · {{ km(e) }}</span>
            <div class="figures">
              <div><span class="v">{{ clock(e.predicted) }}</span><span class="muted small">chrono probable</span></div>
              <div>
                <span class="v tone">{{ e.index }}<small>{{ e.probability !== null ? ' %' : '/100' }}</small></span>
                <span class="muted small">{{ e.probability !== null ? 'sous ' + clock(e.goal.targetSec!) : 'préparation' }}</span>
              </div>
            </div>
            <div class="progress" aria-hidden="true"><span [style.width.%]="e.index"></span></div>
            <span class="verdict">{{ e.verdict.label }} <app-icon name="arrow" /></span>
          </a>
        } @empty {
          <div class="card empty">
            @if (entries.available()) {
              <p>Pas d'objectif à venir : ajoute ta prochaine course pour suivre ta préparation et ton chrono probable.</p>
              <button type="button" class="btn primary" (click)="goalForm.open()"><app-icon name="plus" />Ajouter un objectif</button>
            } @else {
              <p>Ajoute tes prochains objectifs dans <code>data-raw/goals.json</code> puis lance <code>npm run data</code> :</p>
              <pre>[{{ '{' }} "id": "semi-2026", "name": "Semi", "date": "2026-10-11", "startTime": "09:30",
  "distanceKm": 21.0975, "targetSec": 5700, "kind": "road" {{ '}' }}]</pre>
            }
          </div>
        }
      </div>
    </section>

    @if (past().length) {
      <section class="section">
        <h2>Passées <small class="muted">{{ past().length }}</small></h2>
        <div class="tiles">
          @for (p of past(); track p.e.goal.id) {
            <a class="card tile past" [routerLink]="['/courses', p.e.goal.id]" [attr.data-tone]="p.tone">
              <div class="head">
                <h3>{{ p.e.goal.name }}</h3>
              </div>
              <span class="muted small">{{ fmt(p.e.goal.date) }} · {{ km(p.e) }}</span>
              <div class="figures">
                @if (p.official !== null) {
                  <div><span class="v">{{ clock(p.official) }}</span><span class="muted small">{{ p.fromChip ? 'temps officiel' : 'temps montre' }}</span></div>
                } @else {
                  <div><span class="v muted">–</span><span class="muted small">sortie non trouvée</span></div>
                }
                <div><span class="v muted">{{ clock(p.e.predicted) }}</span><span class="muted small">prédit la veille</span></div>
              </div>
              <span class="verdict">{{ p.label }} <app-icon name="arrow" /></span>
            </a>
          }
        </div>
        <a class="all" routerLink="/comprendre/classements">Toutes tes courses officielles et classements <app-icon name="arrow" /></a>
      </section>
    }

    <section class="section">
      <h2>Chronos estimés</h2>
      <p class="muted intro">Ce que les modèles prédisaient sur chaque distance, recalculé à chaque date avec les seules données connues ce jour-là.</p>
      <div class="card">
        <app-prediction-history [initial]="initialDistance()" />
      </div>
    </section>

    <details class="card method">
      <summary>Comment l'indice est calculé</summary>
      <ul>
        <li><b>Objectif chrono, une méthode par type de course</b>. Route : plusieurs modèles prédisent le temps (Coros, VDOT de Daniels,
          Riegel avec ton exposant pondéré, VDOT actualisé par ta progression d'efficacité, vitesse critique, Tanda et Vickers au marathon),
          corrigés du profil du parcours. Trail : tes trails récents ramenés en distance équivalent plat avec ta courbe vitesse / pente
          (mesurée sur tes FIT à FC égale), extrapolés (Riegel, exposant 1,10) et pondérés par la ressemblance du terrain, plus ton niveau
          route actuel multiplié par ton coefficient trail. Ultra (dès 60 km-effort) : en plus, une simulation tronçon par tronçon à ta FC
          d'endurance, avec ton usure par heure et les ravitaillements.</li>
        <li><b>Jour J et probabilité</b> : la moyenne géométrique des modèles est corrigée par la fraîcheur projetée, la récupération
          (VFC, FC de repos), la météo (règle de Hadley), la nuit (simulée sur le profil) et la préparation spécifique. L'incertitude
          combine le désaccord entre modèles, la variabilité d'un jour de course (2 % sur 5 km à 4 % au marathon, 6 % en trail, 8 % en
          ultra) et, en ultra, l'extrapolation au-delà de ta plus longue sortie : l'indice est la probabilité de passer sous le chrono
          visé. Moins de 10 % : hors de portée ; 10 à 25 % : ambitieux ; 25 à 50 % : jouable ; 50 à 75 % : probable ; au-delà : très probable.</li>
        <li><b>Tracé GPX</b> (Modifier l'objectif) : le profil et les points de passage servent à la prédiction et aux temps de passage ;
          seul le profil est gardé, pas les coordonnées.</li>
        <li><b>Objectif « finir »</b> : indice de préparation pondéré (volume, sortie la plus longue, D+, expérience en km-effort,
          sorties de nuit, durabilité, régularité, récupération).</li>
        <li><b>Course de référence</b> : ta dernière course sur la même distance (moins de 2 ans) est un modèle à part entière, de poids 1,5
          (le plus spécifique). Son chrono, ramené à des conditions neutres (Hadley), donne ton niveau de ce jour-là ; il est projeté à
          aujourd'hui en comparant les 8 semaines qui l'ont précédé aux 8 dernières : effet du volume (Tanda) × progrès de forme
          (moyenne de l'allure moyenne d'entraînement et de la moitié du gain d'efficacité aérobie), plafonné à ±10 %.</li>
        <li><b>Chronos estimés</b> : consensus des mêmes modèles (sans la prédiction de la montre, qui n'est qu'un instantané du jour)
          rejoué à chaque date ; l'évolution de l'indice d'une course est rejouée de la même façon, semaine après semaine.</li>
        <li><b>Stratégie</b> : allure par tronçon calée pour que la somme fasse le chrono visé (route : départ 2-3 s/km plus lent, final plus
          rapide ; trail : profil, usure, nuit et arrêts, tronçons entre les ravitaillements du GPX), zones de FC selon la distance, glucides 30-60 g/h jusqu'à 2 h 30 puis 60-90 g/h (ACSM, Burke), recharge 7-12 g/kg.</li>
        <li>Les seuils de préparation sont des repères d'entraînement usuels, pas des lois : l'indice indique où porter l'effort.</li>
      </ul>
    </details>
  `,
  styles: `
    :host { display: grid; gap: 1.25rem; }
    .page-head { margin-top: 1.75rem; position: relative; }
    .add { position: absolute; right: 0; top: 0.2rem; display: flex; gap: 0.4rem; }
    @media (max-width: 600px) { .add { position: static; margin-top: 0.75rem; } }
    .all { justify-self: start; display: inline-flex; align-items: center; gap: 0.3rem; color: var(--accent-text); font-weight: 600; font-size: 0.9rem; text-decoration: none; --icon: 0.9rem; }
    .section { display: grid; gap: 0.75rem; }
    .section h2 small { font-size: 0.85rem; margin-left: 0.3rem; }
    .intro { margin: -0.4rem 0 0; font-size: 0.88rem; }
    .tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
    .tile {
      display: grid; gap: 0.55rem; align-content: start; color: inherit; text-decoration: none;
      transition: border-color 0.15s, background 0.15s;
    }
    .tile:hover { border-color: var(--accent); }
    .tile:focus-visible { outline-offset: 3px; }
    .head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
    .head h3 { font-size: 1.05rem; line-height: 1.2; }
    .days { color: var(--accent); font-size: 1.4rem; white-space: nowrap; }
    .small { font-size: 0.8rem; }
    .figures { display: flex; flex-wrap: wrap; gap: 0.4rem 1.5rem; }
    .figures div { display: grid; }
    .figures .v { font: 600 1.35rem var(--font-mono); }
    .figures .v small { font-size: 0.8rem; }
    .tone { color: var(--tone); }
    .progress { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
    .progress span { display: block; height: 100%; border-radius: 3px; background: var(--tone); }
    .verdict { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; font-weight: 600; color: var(--tone, var(--accent-text)); --icon: 0.9rem; }
    .past .verdict { color: var(--text-secondary); }
    .past[data-tone='good'] .verdict { color: var(--good-text, var(--good)); }
    .past[data-tone='warning'] .verdict { color: var(--warning); }
    .empty { display: grid; gap: 0.75rem; justify-items: start; grid-column: 1 / -1; }
    .empty p { margin: 0; }
    .method ul { gap: 0.5rem; }
    pre { background: var(--surface-2); padding: 0.8rem; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
  `,
})
export class GoalsPage {
  constructor() {
    const route = inject(ActivatedRoute);
    const router = inject(Router);
    const section = route.snapshot.queryParamMap.get('section');
    // Anciennes adresses : Courses › Classements, et un sous-onglet par objectif
    if (section === 'classements') void router.navigateByUrl('/comprendre/classements', { replaceUrl: true });
    else if (section && section !== 'archives') void router.navigate(['/courses', section], { replaceUrl: true });
  }

  private readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  protected readonly clock = clock;
  protected readonly upcoming = this.sci.upcomingGoals;

  /** Objectifs passés : temps réalisé (puce si saisi) face à l'objectif */
  protected readonly past = computed(() =>
    this.sci.archivedGoals().map((e) => {
      const d = this.sci.debriefs().get(e.goal.id) ?? null;
      const official = d?.official ?? null;
      const target = e.goal.targetSec ?? null;
      const label = official === null ? 'Voir l\'indice de la veille'
        : target === null ? 'Terminé · voir le bilan'
        : official <= target ? 'Objectif atteint · voir le bilan' : `Manqué de ${clock(official - target)} · voir le bilan`;
      const tone = official === null ? null : target === null || official <= target ? 'good' : 'warning';
      return { e, official, fromChip: d?.fromChip ?? false, label, tone };
    }),
  );

  /** Distance de la courbe des chronos : celle du prochain objectif sur route, sinon 10 km */
  protected readonly initialDistance = computed<DistanceKey | null>(() => {
    const g = this.upcoming().find((e) => e.goal.kind === 'road')?.goal;
    if (!g) return null;
    const d = officialDistance(g.distanceKm);
    return REFERENCE_DISTANCES.find((r) => r.km * 1000 === d)?.key ?? null;
  });

  protected tone = (e: GoalEvaluation) => TONE[e.verdict.tone];
  protected fmt = (iso: string) => dayFmt.format(parseDay(iso));
  protected km = (e: GoalEvaluation) =>
    `${num(e.goal.distanceKm, e.goal.distanceKm % 1 ? 1 : 0)} km${e.goal.elevGain ? ` · ${num(e.goal.elevGain)} m D+` : ''}`;
}
