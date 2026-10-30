import { Component, computed, inject, input } from '@angular/core';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { inRange } from '../core/stats';
import { startPlaces } from '../core/insights';
import { decodePolyline } from '../core/polyline';
import { HEAT_STEPS, heatOf, heatPreview } from '../core/heat';
import { km, num } from '../core/format';
import { PeriodNavComponent } from '../ui/period-nav';
import { StartMapComponent } from '../ui/start-map';
import { HeatMapComponent } from '../ui/heat-map';

/** Où je cours : carte thermique des parcours (tracés GPS) et lieux de départ, sur la période choisie. */
@Component({
  selector: 'app-places',
  imports: [PeriodNavComponent, StartMapComponent, HeatMapComponent],
  template: `
    @if (compact()) {
      <p class="verdict">{{ verdict() }}</p>
      @if (preview().length) {
        <svg class="mini-heat" viewBox="0 0 240 104" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          @for (l of preview(); track l.level) {
            <path [attr.d]="l.d" [attr.class]="'h' + l.level" />
          }
        </svg>
      }
    } @else {
      <app-period-nav />

      <section class="section">
        <h2>Carte thermique <small>{{ tracks().length }} tracés GPS · {{ km(trackKm()) }}</small></h2>
        @if (tracks().length) {
          <div class="card">
            <app-heat-map [heat]="heat()" />
            <ul class="legend" aria-label="Légende : nombre de sorties passées au même endroit">
              @for (s of legend; track s.label; let i = $index) {
                <li><i [attr.class]="'h' + i"></i>{{ s.label }}</li>
              }
            </ul>
            <p class="muted small">
              Chaque tronçon prend la couleur du nombre de sorties passées à moins de 30 m. Le cadrage suit la zone où tu cours
              le plus ; dézoome pour voir les sorties lointaines.
            </p>
          </div>
        } @else {
          <div class="card">
            <p class="muted">Pas de tracé GPS sur cette période : ils viennent des fichiers FIT (COROS) ou des tracés Strava.</p>
          </div>
        }
      </section>

      @if (places().length) {
        <section class="section">
          <h2>Lieux de départ <small>{{ places().length }} lieu{{ places().length > 1 ? 'x' : '' }} différent{{ places().length > 1 ? 's' : '' }}</small></h2>
          <div class="card map-card">
            <app-start-map [places]="places()" />
            <ol class="places">
              @for (p of places().slice(0, 6); track p.lat + ',' + p.lon) {
                <li>
                  <b>{{ p.count }}</b> sortie{{ p.count > 1 ? 's' : '' }}
                  <span class="muted">· {{ p.names.join(', ') || 'Sans nom' }}</span>
                </li>
              }
            </ol>
          </div>
        </section>
      }
    }
  `,
  styles: `
    .card { display: grid; gap: 0.9rem; }
    .map-card { grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr); align-items: start; }
    @media (max-width: 760px) { .map-card { grid-template-columns: minmax(0, 1fr); } }
    .places { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.5rem; font-size: 0.9rem; }
    .small { font-size: 0.8rem; margin: 0; }
    .legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; margin: 0; padding: 0; list-style: none; font-size: 0.82rem; color: var(--text-secondary); }
    .legend li { display: inline-flex; align-items: center; gap: 0.45rem; }
    .legend i { width: 1.4rem; height: 0.3rem; border-radius: 2px; }
    .legend .h0 { background: color-mix(in srgb, var(--series-1) 35%, transparent); }
    .legend .h1 { background: color-mix(in srgb, var(--series-1) 75%, transparent); }
    .legend .h2 { background: var(--series-3); }
    .legend .h3 { background: var(--accent); }
    .legend .h4 { background: var(--accent); height: 0.45rem; }
    .mini-heat { display: block; width: 100%; height: 104px; margin-top: 0.2rem; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .mini-heat .h0 { stroke: var(--series-1); stroke-opacity: 0.3; stroke-width: 0.6; }
    .mini-heat .h1 { stroke: var(--series-1); stroke-opacity: 0.7; stroke-width: 0.8; }
    .mini-heat .h2 { stroke: var(--series-3); stroke-width: 1; }
    .mini-heat .h3 { stroke: var(--accent); stroke-width: 1.3; }
    .mini-heat .h4 { stroke: var(--accent); stroke-width: 2; }
  `,
})
export class PlacesSection {
  /** Carte de Comprendre : le constat en une phrase et un aperçu sans fond de carte */
  readonly compact = input(false);
  private readonly store = inject(DataService);
  private readonly ps = inject(PeriodService);
  protected readonly km = km;

  protected readonly legend = [
    { label: '1 sortie' },
    ...HEAT_STEPS.map((s, i) => ({ label: i < HEAT_STEPS.length - 1 ? `${s} à ${HEAT_STEPS[i + 1] - 1}` : `${s} et plus` })),
  ];

  private readonly acts = computed(() => inRange(this.store.activities(), this.ps.period().start, this.ps.period().end));
  protected readonly places = computed(() => startPlaces(this.acts()));
  private readonly withTrack = computed(() => {
    const routes = this.store.routes() ?? {};
    return this.acts().filter((a) => routes[a.id]);
  });
  protected readonly tracks = computed(() => {
    const routes = this.store.routes() ?? {};
    return this.withTrack().map((a) => decodePolyline(routes[a.id]));
  });
  protected readonly trackKm = computed(() => this.withTrack().reduce((s, a) => s + a.distanceKm, 0));
  protected readonly heat = computed(() => heatOf(this.tracks()));
  protected readonly preview = computed(() => heatPreview(this.heat(), 240, 104));

  protected readonly verdict = computed(() => {
    const places = this.places(), n = this.tracks().length;
    if (!this.acts().length) return 'Pas encore de sortie sur la période.';
    const parts = [`${num(n)} tracé${n > 1 ? 's' : ''} GPS`, `${places.length} lieu${places.length > 1 ? 'x' : ''} de départ`];
    if (this.heat().max > 1) parts.push(`jusqu'à ${num(this.heat().max)} passages au même endroit`);
    return parts.join(' · ');
  });

  constructor() {
    this.store.loadRoutes();
  }
}
