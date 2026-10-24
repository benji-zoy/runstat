import { Component, DestroyRef, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import * as L from 'leaflet';
import { Place } from '../core/insights';
import { km } from '../core/format';
import { C, resolveColor } from './palette';
import { ThemeService } from '../core/theme.service';

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (iso: string) => dateFmt.format(new Date(iso + 'T00:00:00'));

/** Carte des lieux de départ : un cercle par lieu, taille ∝ nombre de sorties. */
@Component({
  selector: 'app-start-map',
  template: '<div #map class="map"></div>',
  styles: `
    :host { display: block; }
    .map { height: var(--map-h, 380px); border-radius: 10px; background: var(--map-land); }
    :host ::ng-deep .dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6); }
    :host-context([data-theme='light']) ::ng-deep .dark-tiles { filter: saturate(0.7); }
    :host ::ng-deep .leaflet-popup-content-wrapper,
    :host ::ng-deep .leaflet-popup-tip { background: var(--surface-2); color: var(--text-primary); }
    :host ::ng-deep .leaflet-popup-content { font: 13px/1.4 var(--font-body); }
    :host ::ng-deep .leaflet-container a.leaflet-popup-close-button { color: var(--text-secondary); }
    :host ::ng-deep .leaflet-control-attribution { background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--text-muted); }
    :host ::ng-deep .leaflet-control-attribution a { color: var(--text-secondary); }
  `,
})
export class StartMapComponent {
  readonly places = input.required<Place[]>();
  private readonly el = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private readonly theme = inject(ThemeService).theme;

  constructor() {
    effect(() => {
      const places = this.places();
      this.theme(); // couleurs du thème courant (Leaflet écrit des attributs SVG, sans variables CSS)
      if (!this.map) {
        this.map = L.map(this.el().nativeElement, { scrollWheelZoom: false, attributionControl: true });
        // Tuiles OpenStreetMap standard, assombries en CSS pour le thème sombre
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
          className: 'dark-tiles',
        }).addTo(this.map);
      }
      this.layer?.remove();
      this.layer = L.layerGroup().addTo(this.map);
      const max = Math.max(1, ...places.map((p) => p.count));
      for (const p of places) {
        L.circleMarker([p.lat, p.lon], {
          radius: 6 + 18 * Math.sqrt(p.count / max),
          color: resolveColor(C.surface),
          weight: 2,
          fillColor: resolveColor(C.accent),
          fillOpacity: 0.85,
        })
          .bindPopup(
            `<b>${p.count} sortie${p.count > 1 ? 's' : ''}</b> · ${km(p.km)}<br>` +
              `${p.names.map((n) => escapeHtml(n)).join(', ')}<br>` +
              `<span style="color:var(--text-muted)">${p.first === p.last ? fmt(p.first) : `${fmt(p.first)} → ${fmt(p.last)}`}</span>`,
          )
          .addTo(this.layer);
      }
      if (places.length) {
        this.map.fitBounds(L.latLngBounds(places.map((p) => [p.lat, p.lon] as L.LatLngTuple)), { padding: [30, 30], maxZoom: 13 });
      } else {
        this.map.setView([46.6, 2.4], 5);
      }
    });
    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
