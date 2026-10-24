import { Component, DestroyRef, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import * as L from 'leaflet';
import { C, resolveColor } from './palette';
import { ThemeService } from '../core/theme.service';

/** Carte Leaflet d'un ou plusieurs tracés (fond OpenStreetMap assombri). */
@Component({
  selector: 'app-route-map',
  template: '<div #map class="map"></div>',
  styles: `
    :host { display: block; }
    .map { height: var(--map-h, 260px); border-radius: 10px; background: var(--map-land); }
    :host ::ng-deep .dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6); }
    :host-context([data-theme='light']) ::ng-deep .dark-tiles { filter: saturate(0.7); }
    :host ::ng-deep .leaflet-control-attribution { background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--text-muted); }
    :host ::ng-deep .leaflet-control-attribution a { color: var(--text-secondary); }
  `,
})
export class RouteMapComponent {
  /** Un ou plusieurs tracés [lat, lon][] */
  readonly tracks = input.required<[number, number][][]>();
  /** Opacité des tracés (plus faible pour une heatmap de nombreux tracés) */
  readonly opacity = input(0.95);
  private readonly el = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private readonly theme = inject(ThemeService).theme;

  constructor() {
    effect(() => {
      const tracks = this.tracks().filter((t) => t.length > 1);
      this.theme(); // couleurs du thème courant (Leaflet écrit des attributs SVG, sans variables CSS)
      const c = (v: string) => resolveColor(v);
      if (!this.map) {
        this.map = L.map(this.el().nativeElement, { scrollWheelZoom: false });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
          className: 'dark-tiles',
        }).addTo(this.map);
      }
      this.layer?.remove();
      this.layer = L.layerGroup().addTo(this.map);
      for (const t of tracks) {
        L.polyline(t, { color: c(C.accent), weight: tracks.length > 20 ? 2 : 3.5, opacity: this.opacity() }).addTo(this.layer);
      }
      if (tracks.length === 1) {
        L.circleMarker(tracks[0][0], { radius: 6, color: c(C.surface), weight: 2, fillColor: c(C.good), fillOpacity: 1 }).addTo(this.layer);
        L.circleMarker(tracks[0].at(-1)!, { radius: 6, color: c(C.surface), weight: 2, fillColor: c(C.bad), fillOpacity: 1 }).addTo(this.layer);
      }
      const all = tracks.flat();
      if (all.length) this.map.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
      else this.map.setView([46.6, 2.4], 5);
    });
    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }
}
