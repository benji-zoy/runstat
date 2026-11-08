import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { DataService } from '../core/data.service';
import { parseDay } from '../core/stats';
import { clock, num, pace } from '../core/format';
import { ActivityDetailComponent } from '../ui/activity-detail';
import { IconComponent } from '../ui/icon';
import { ResultFormComponent } from '../ui/forms/result-form';
import { AiExportDialogComponent } from '../ui/forms/ai-export-dialog';
import { EntriesService } from '../core/entries.service';
import { ScienceService } from '../core/science.service';

const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Fiche d'une sortie, avec sa propre adresse : liens depuis Aujourd'hui, le journal, les records */
@Component({
  selector: 'app-run',
  imports: [ActivityDetailComponent, IconComponent, RouterLink, ResultFormComponent, AiExportDialogComponent],
  template: `
    <button type="button" class="back" (click)="back()"><app-icon name="back" />Retour</button>
    @if (activity(); as a) {
      <header class="page-head">
        <h1>{{ a.name || 'Sortie' }}</h1>
        <p class="lede">{{ when() }}</p>
      </header>
      <div class="figures">
        <div><span class="v">{{ num(a.distanceKm, 1) }}</span><span class="muted">km</span></div>
        <div><span class="v">{{ clock(a.durationSec) }}</span><span class="muted">durée</span></div>
        <div><span class="v">{{ pace(a.durationSec / a.distanceKm) }}</span><span class="muted">min/km</span></div>
        @if (a.avgHr) {
          <div><span class="v">{{ a.avgHr }}</span><span class="muted">FC moy.</span></div>
        }
      </div>
      @if (a.result; as r) {
        <section class="card official">
          <div class="o-head">
            <span class="label">Course officielle{{ r.pending ? ' · classement à compléter' : '' }}</span>
            @if (entries.available()) {
              <button type="button" class="btn small" (click)="resultForm.open(a)"><app-icon name="edit" />Modifier</button>
            }
          </div>
          <b class="event">{{ r.event }}@if (r.course) {<span class="muted"> · {{ r.course }}</span>}</b>
          <div class="figures">
            @if (r.distanceKm) {
              <div><span class="v">{{ distLabel(r.distanceKm) }}</span><span class="muted">distance officielle · montre {{ num(a.distanceKm, 2) }} km</span></div>
            }
            @if (r.officialSec) {
              <div><span class="v">{{ clock(r.officialSec) }}</span><span class="muted">temps officiel · montre {{ clock(a.durationSec) }}</span></div>
            }
            @if (r.rank) {
              <div><span class="v">{{ r.rank }}<small>{{ r.finishers ? ' / ' + r.finishers : '' }}</small></span><span class="muted">scratch</span></div>
            }
            @if (r.sexRank) {
              <div><span class="v">{{ r.sexRank }}<small>{{ r.sexCount ? ' / ' + r.sexCount : '' }}</small></span><span class="muted">{{ r.sex === 'F' ? 'femmes' : 'hommes' }}</span></div>
            }
            @if (r.catRank) {
              <div><span class="v">{{ r.catRank }}<small>{{ r.catCount ? ' / ' + r.catCount : '' }}</small></span><span class="muted">{{ r.category ?? 'catégorie' }}</span></div>
            }
          </div>
          @if (r.note) {
            <p class="muted note">{{ r.note }}</p>
          }
          <div class="links">
            @if (r.source) {
              <a [href]="r.source" target="_blank" rel="noopener">Résultats officiels ↗</a>
            }
            <a routerLink="/comprendre/classements">Niveau FFA et classements <app-icon name="arrow" /></a>
          </div>
        </section>
      } @else if (entries.available()) {
        <div class="declare">
          @if (isRace()) {
            <span class="muted">Course détectée : ajoute ton temps officiel et ton classement.</span>
            <button type="button" class="btn small" (click)="resultForm.open(a)"><app-icon name="plus" />Saisir le résultat</button>
          } @else {
            <span class="muted">C'était une course officielle ?</span>
            <button type="button" class="btn small" (click)="resultForm.open(a)"><app-icon name="flag" />Déclarer la course</button>
          }
        </div>
      }
      <app-result-form #resultForm />
      <app-ai-export-dialog #aiDialog />
      <button type="button" class="btn small ai" (click)="aiDialog.open({ run: a })"><app-icon name="chat" />Discuter de cette sortie avec une IA</button>

      <div class="card detail">
        <app-activity-detail [activity]="a" />
      </div>
    } @else {
      <div class="card missing">
        <p>Cette sortie n'existe pas (ou plus) dans tes données.</p>
        <a class="btn" routerLink="/journal">Ouvrir le journal</a>
      </div>
    }
  `,
  styles: `
    :host { display: grid; gap: 1.25rem; }
    .back {
      justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; min-height: 44px; margin: 1rem 0 -1rem;
      padding: 0 0.4rem 0 0; border: none; background: none; color: var(--accent-text); font: 600 0.95rem var(--font-body); cursor: pointer;
    }
    .figures { display: flex; flex-wrap: wrap; gap: 1.5rem 2.25rem; }
    .figures div { display: grid; }
    .figures .v { font: 600 1.5rem var(--font-mono); }
    .figures .muted { font-size: 0.8rem; }
    .missing { display: grid; gap: 0.75rem; justify-items: start; }
    .ai { justify-self: start; }
    .official { display: grid; gap: 0.6rem; }
    .o-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
    .label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-text); }
    .event { font-size: 1.05rem; }
    .figures small { font-size: 0.85rem; color: var(--text-muted); }
    .note { margin: 0; font-size: 0.88rem; }
    .links { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; font-size: 0.88rem; }
    .links a { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--accent-text); font-weight: 600; text-decoration: none; --icon: 0.85rem; }
    .declare {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem;
      padding: 0.6rem 0.9rem; border: 1px dashed var(--border); border-radius: var(--radius);
    }
  `,
})
export class RunPage {
  private readonly store = inject(DataService);
  private readonly location = inject(Location);
  private readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);
  protected readonly num = num;
  protected readonly clock = clock;
  protected readonly pace = pace;

  protected readonly activity = computed(() => {
    const id = this.params()?.get('id');
    return this.store.activities().find((a) => a.id === id) ?? null;
  });
  protected distLabel = (km: number) =>
    Math.abs(km - 42.195) < 0.05 ? 'Marathon' : Math.abs(km - 21.0975) < 0.05 ? 'Semi' : `${num(km, km % 1 ? 1 : 0)} km`;
  protected readonly isRace = computed(() => {
    const a = this.activity();
    return !!a && this.sci.types().get(a.id) === 'race';
  });
  protected readonly when = computed(() => {
    const a = this.activity();
    if (!a) return '';
    const d = longDate.format(parseDay(a.date));
    const time = a.start ? new Date(a.start * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
    return d.charAt(0).toUpperCase() + d.slice(1) + (time ? ` · ${time}` : '');
  });

  protected back(): void {
    this.location.back();
  }
}
