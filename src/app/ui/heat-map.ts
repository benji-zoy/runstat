import { Component, DestroyRef, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import * as L from 'leaflet';
import { Heat } from '../core/heat';
import { C, alpha, resolveColor } from './palette';
import { ThemeService } from '../core/theme.service';

/** Couleur et épaisseur des niveaux 0 (passage unique) à 4 (parcours habituel) */
export const HEAT_STYLE = [
  { color: alpha(C.s1, 0.35), weight: 1.5 },
  { color: alpha(C.s1, 0.75), weight: 2 },
  { color: C.s3, weight: 2.5 },
  { color: C.accent, weight: 3 },
  { color: C.accent, weight: 4.5 },
];

/** Carte thermique Leaflet : tracés colorés selon le nombre de sorties passées au même endroit (rendu canvas). */
@Component({
  selector: 'app-heat-map',
  template: '<div #map class="map"></div>',
  styles: `
    :host { display: block; }
    .map { height: var(--map-h, 460px); border-radius: 10px; background: var(--map-land); }
    :host ::ng-deep .dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.7) contrast(0.9) saturate(0.4); }
    :host-context([data-theme='light']) ::ng-deep .dark-tiles { filter: saturate(0.5) brightness(1.03); }
    :host ::ng-deep .leaflet-control-attribution { background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--text-muted); }
    :host ::ng-deep .leaflet-control-attribution a { color: var(--text-secondary); }
  `,
})
export class HeatMapComponent {
  readonly heat = input.required<Heat>();
  private readonly el = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private readonly theme = inject(ThemeService).theme;

  constructor() {
    effect(() => {
      const heat = this.heat();
      this.theme(); // couleurs du thème courant (le canvas ne lit pas les variables CSS)
      if (!this.map) {
        this.map = L.map(this.el().nativeElement, { scrollWheelZoom: false, preferCanvas: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
          className: 'dark-tiles',
        }).addTo(this.map);
      }
      this.layer?.remove();
      this.layer = L.layerGroup().addTo(this.map);
      const renderer = L.canvas({ padding: 0.3 });
      for (const line of heat.lines) {
        const s = HEAT_STYLE[line.level];
        L.polyline(line.points, { renderer, color: resolveColor(s.color), weight: s.weight, opacity: 1, interactive: false }).addTo(this.layer);
      }
      if (heat.bounds) this.map.fitBounds(L.latLngBounds(heat.bounds), { padding: [10, 10] });
      else this.map.setView([46.6, 2.4], 5);
    });
    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }
}
