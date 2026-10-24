import { Component, computed, inject, input, signal } from '@angular/core';
import { Activity } from '../core/models';
import { ScienceService } from '../core/science.service';
import { SyncService } from '../core/sync.service';
import { conditionsSummary, formatPct, reportText } from '../core/conditions';
import { clock, pace } from '../core/format';

/**
 * Coût des conditions d'une sortie (façon « rapport Enduraw ») : altitude, dénivelé, température et vent en %,
 * et le temps équivalent en conditions standard. `compact` : une ligne pour la page Aujourd'hui.
 */
@Component({
  selector: 'app-conditions',
  template: `
    @if (report(); as r) {
      @if (compact()) {
        <p class="line">
          @for (f of r.factors; track f.key) {
            <span>{{ f.emoji }} {{ f.label }} <b [class]="tone(f.pct)">{{ pct(f.pct) }}</b></span>
          }
        </p>
        <p class="muted small">{{ summary() }}</p>
      } @else {
        <div class="head">
          <span class="fit-title">Coût des conditions</span>
          <button type="button" class="copy" (click)="copy()">{{ copied() ? 'Copié' : 'Copier le rapport' }}</button>
        </div>
        <p class="summary">{{ summary() }}</p>
        <div class="tiles">
          <div><small>Temps réel</small><b>{{ clock(activity().durationSec) }}</b><small>{{ pace(activity().durationSec / activity().distanceKm) }} /km</small></div>
          <div><small>En conditions standard</small><b>{{ clock(r.standardSec) }}</b><small>{{ pace(r.standardPace) }} /km</small></div>
          <div>
            <small>Effet total</small><b [class]="tone(r.totalPct)">{{ pct(r.totalPct) }}</b>
            <small>{{ gap() }}</small>
          </div>
        </div>
        <ul class="factors">
          @for (f of r.factors; track f.key) {
            <li>
              <span class="name">{{ f.emoji }} {{ f.label }}</span>
              <span class="bar" aria-hidden="true">
                <span [class]="'fill ' + tone(f.pct)" [style.width.%]="width(f.pct)" [class.right]="f.pct > 0"></span>
              </span>
              <b [class]="'v ' + tone(f.pct)">{{ pct(f.pct) }}</b>
              <span class="why">
                {{ f.cause }} · {{ f.detail }}
                @if (f.model === 'perso') { <span class="badge" title="Coefficient mesuré sur ton historique">perso</span> }
                @if (f.estimated) { <span class="badge" title="Sans fichier FIT : estimation">estimé</span> }
              </span>
            </li>
          }
        </ul>
        @if (r.estimated && sync.available()) {
          <p class="refine">
            <button type="button" (click)="refine()" [disabled]="sync.running()">
              {{ sync.refining() === activity().id ? 'Téléchargement du tracé…' : 'Affiner avec le tracé' }}
            </button>
            <span class="muted small">
              {{ notice() ?? (caps().fitQuota ? 'Télécharge le fichier FIT (quota COROS : 50 par jour) pour le vent, l’altitude et le dénivelé exacts.'
                : 'Télécharge le tracé seconde par seconde depuis Strava pour le vent, l’altitude et le dénivelé exacts.') }}
            </span>
          </p>
        } @else if (notice(); as n) {
          <p class="muted small">{{ n }}</p>
        }
        <details class="method">
          <summary>Méthode</summary>
          <p>
            Chaque facteur est comparé à des conditions standard : plat, niveau de la mer, 12 °C, sans vent. Un pourcentage négatif
            est un coût ; le temps standard est le temps réel multiplié par (1 + %) de chaque facteur.
          </p>
          <ul>
            <li><b>Altitude</b> : VO₂max −6,3 % par 1 000 m au-dessus de 300 m (Wehrlin et Hallén, 2006), dont environ 55 % se
              retrouve sur le chrono (10 000 m de Mexico 1968), moins le gain d'un air moins dense. Altitude moyenne du FIT, sinon celle du départ.</li>
            <li><b>Dénivelé</b> : distance « équivalent plat » de Minetti (2002) calculée sur le FIT ; sans FIT, D+ et D− de COROS
              avec ton coefficient de boucle mesuré sur tes FIT. Surestime un peu les descentes techniques en trail.</li>
            <li><b>Température</b> : au-dessus de 12 °C, ta perte d'efficacité (EF) par degré, mesurée sur tes sorties faciles ;
              sinon la règle de Hadley (température + point de rosée). Effet plein sur 2 h 30, moitié sur 30 min ; léger coût sous 5 °C.</li>
            <li><b>Vent</b> : traînée aérodynamique (Pugh, 1971) secteur de cap par secteur de cap, vent à 10 m ramené à hauteur du
              coureur (× 0,7), à puissance égale ; un vent de dos ne rend qu'une partie de ce que coûte un vent de face. Sans tracé,
              le parcours est supposé faire une boucle. Ni rafales ni abris (bâtiments, arbres, peloton).</li>
          </ul>
          <p>Estimation, pas un résultat officiel : utile pour comparer des séances faites dans des conditions différentes.</p>
        </details>
      }
    }
  `,
  styles: `
    :host { display: grid; gap: 0.6rem; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .fit-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    button { font: inherit; font-size: 0.8rem; padding: 0.3rem 0.7rem; border-radius: 7px; border: 1px solid var(--border);
      background: var(--surface-2); color: var(--text-primary); cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:disabled { opacity: 0.6; cursor: default; }
    .summary { margin: 0; font-size: 0.9rem; line-height: 1.5; padding-left: 0.7rem; border-left: 3px solid var(--accent); }
    .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
    .tiles div { display: grid; background: var(--surface-2); border-radius: 8px; padding: 0.5rem 0.7rem; }
    .tiles small { font-size: 0.72rem; color: var(--text-muted); }
    .tiles small:first-child { text-transform: uppercase; letter-spacing: 0.04em; }
    .tiles b { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
    .factors { list-style: none; margin: 0; padding: 0; display: grid; }
    .factors li { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr) 4.2rem; align-items: center; column-gap: 0.7rem;
      padding: 0.45rem 0; border-top: 1px solid var(--border); }
    .name { font-size: 0.9rem; }
    .bar { position: relative; height: 0.55rem; background: var(--surface-2); border-radius: 3px; }
    .bar::after { content: ''; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: var(--text-muted); }
    .fill { position: absolute; top: 0; bottom: 0; right: 50%; border-radius: 2px; background: var(--text-muted); }
    .fill.right { right: auto; left: 50%; }
    .fill.bad { background: var(--bad); }
    .fill.good { background: var(--good); }
    .v { text-align: right; font-variant-numeric: tabular-nums; }
    .bad { color: var(--bad); }
    .good { color: var(--good-text); }
    .why { grid-column: 1 / -1; font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.15rem; }
    .badge { margin-left: 0.3rem; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.68rem; background: var(--accent-soft); color: var(--accent-text); }
    .refine { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin: 0; }
    .line { display: flex; flex-wrap: wrap; gap: 0.3rem 0.9rem; margin: 0; font-size: 0.88rem; }
    .small { font-size: 0.8rem; margin: 0; }
    @media (max-width: 520px) { .factors li { grid-template-columns: 7rem minmax(0, 1fr) 3.8rem; } }
  `,
})
export class ConditionsCardComponent {
  readonly activity = input.required<Activity>();
  readonly compact = input(false);
  private readonly sci = inject(ScienceService);
  protected readonly sync = inject(SyncService);
  protected readonly caps = this.sci.caps;

  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly pct = formatPct;
  protected readonly copied = signal(false);

  protected readonly report = computed(() => this.sci.conditions(this.activity()));
  protected readonly summary = computed(() => {
    const r = this.report();
    return r ? conditionsSummary(this.activity(), r) : '';
  });
  protected readonly notice = computed(() => {
    const n = this.sync.refineNotice();
    return n && n.id === this.activity().id ? n.text : null;
  });
  /** Échelle des barres : la demi-largeur vaut au moins 5 % */
  private readonly scale = computed(() => Math.max(5, ...(this.report()?.factors.map((f) => Math.abs(f.pct)) ?? [])));

  protected readonly gap = computed(() => {
    const r = this.report();
    if (!r) return '';
    const d = this.activity().durationSec - r.standardSec;
    if (Math.abs(d) < 1) return 'aucun écart';
    return `${clock(Math.abs(d))} ${d > 0 ? 'perdues' : 'gagnées'}`;
  });

  protected tone(pct: number): string {
    return pct <= -0.05 ? 'bad' : pct >= 0.05 ? 'good' : '';
  }

  protected width(pct: number): number {
    return (Math.abs(pct) / this.scale()) * 50;
  }

  protected copy(): void {
    const r = this.report();
    if (!r) return;
    navigator.clipboard?.writeText(reportText(this.activity(), r)).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  protected refine(): void {
    void this.sync.refineFit(this.activity().id);
  }
}
