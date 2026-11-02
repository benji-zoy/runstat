import { Component, DestroyRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { summarize, parseDay } from '../core/stats';
import { activeDays, paceOf, runnerProfile, topN, weekStreaks } from '../core/insights';
import { BADGES } from '../core/badges';
import { headlineHeight, tripFor } from '../core/equivalences';
import { clock, day, duration, km, num, pace, smart } from '../core/format';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const SLIDES = 9;
/** Plein écran (téléphone) : chaque diapositive reste affichée 6 s, comme une story */
const SLIDE_MS = 6000;

@Component({
  selector: 'app-recap',
  template: `
    <div class="years">
      @for (y of years(); track y) {
        <button type="button" class="chip" [class.active]="year() === y" (click)="pick(y)">{{ y }}</button>
      }
    </div>

    @if (r(); as r) {
      @if (phone() && !full()) {
        <!-- Téléphone : le récap s'ouvre en plein écran, comme une story -->
        <button type="button" class="launch" (click)="open()">
          <span class="kicker">Ton année {{ year() }}{{ r.partial ? ' (en cours)' : '' }}</span>
          <span class="mega display">{{ num(r.s.km) }}<small>km</small></span>
          <span class="lead">{{ r.s.count }} sorties · {{ r.days }} jours à courir</span>
          <span class="play">Voir mon récap</span>
        </button>
      } @else {
      <div class="story" [class.full]="full()" [attr.data-slide]="index()" [attr.role]="full() ? 'dialog' : null"
        [attr.aria-modal]="full() ? 'true' : null" [attr.aria-label]="'Récap ' + year()"
        (touchstart)="touchStart($event)" (touchend)="touchEnd($event)">
        <div class="bars">
          @for (s of slides; track s) {
            <span [class.done]="s < index() || (!full() && s === index())" [class.current]="full() && s === index()"></span>
          }
        </div>
        @if (full()) {
          <button type="button" class="close" (click)="close()" aria-label="Fermer le récap">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        }
        <button type="button" class="zone prev" (click)="go(-1)" aria-label="Précédent"></button>
        <button type="button" class="zone next" (click)="go(1)" aria-label="Suivant"></button>

        <div class="slide">
          @switch (index()) {
            @case (0) {
              <p class="kicker">Ton année {{ year() }}{{ r.partial ? ' (en cours)' : '' }} en course</p>
              <p class="mega display">{{ r.days }}</p>
              <p class="lead">jours à courir</p>
              <div class="trio">
                <div><b class="display">{{ r.s.count }}</b><span>sorties</span></div>
                <div><b class="display">{{ duration(r.s.sec) }}</b><span>de course</span></div>
                <div><b class="display">{{ r.weeks }}</b><span>semaines d'affilée max</span></div>
              </div>
            }
            @case (1) {
              <p class="kicker">Distance parcourue</p>
              <p class="mega display">{{ num(r.s.km) }}<small>km</small></p>
              @if (r.trip.done; as t) {
                <p class="lead">Assez pour relier <b>{{ t.from }}</b> à <b>{{ t.to }}</b> à vol d'oiseau{{ r.s.km / t.km >= 2 ? ', ' + smart(r.s.km / t.km) + ' fois' : '' }}.</p>
              }
              @if (r.prevKm) {
                <p class="sub">{{ r.s.km >= r.prevKm ? '+' : '−' }}{{ num(Math.abs(r.s.km - r.prevKm)) }} km par rapport à {{ year() - 1 }}</p>
              }
            }
            @case (2) {
              <p class="kicker">Mois par mois</p>
              <div class="months">
                @for (m of r.months; track $index) {
                  <div class="mcol" [class.best]="$index === r.bestMonth">
                    <span class="mval">{{ m ? num(m) : '' }}</span>
                    <span class="mbar" [style.height.%]="(m / r.maxMonth) * 100"></span>
                    <span class="mlab">{{ monthLetters[$index] }}</span>
                  </div>
                }
              </div>
              <p class="lead">Ton meilleur mois : <b>{{ monthNames[r.bestMonth] }}</b> avec {{ km(r.months[r.bestMonth]) }}.</p>
            }
            @case (3) {
              <p class="kicker">Ta plus longue sortie</p>
              @if (r.longest; as l) {
                <p class="mega display">{{ num(l.distanceKm, 1) }}<small>km</small></p>
                <p class="lead">{{ l.name }} · {{ fmt(l.date) }} · {{ clock(l.durationSec) }}</p>
              }
              @if (r.hilliest; as h) {
                <p class="sub">La plus vallonnée : {{ h.name }}, {{ num(h.elevGain ?? 0) }} m de D+</p>
              }
            }
            @case (4) {
              <p class="kicker">Dénivelé positif</p>
              <p class="mega display">{{ num(r.s.elev) }}<small>m</small></p>
              <p class="lead">{{ smart(r.s.elev / r.height.value) }} fois {{ r.height.name }} {{ r.height.icon }}</p>
              <p class="sub">soit {{ num(r.s.elev / 330) }} tours Eiffel 🗼</p>
            }
            @case (5) {
              <p class="kicker">Ton profil</p>
              <p class="big display accent">{{ r.profile.title }}</p>
              <ul class="traits">
                @for (t of r.profile.traits; track t) {
                  <li>{{ t }}</li>
                }
              </ul>
            }
            @case (6) {
              <p class="kicker">Vitesse</p>
              <p class="mega display">{{ pace(r.s.avgPaceSec) }}<small>/km</small></p>
              <p class="lead">d'allure moyenne sur l'année</p>
              <div class="trio">
                @if (r.fast10; as f) {
                  <div><b class="display">{{ pace(paceOf(f)) }}</b><span>meilleure allure ≥ 10 km</span></div>
                }
                @if (r.bestKm; as b) {
                  <div><b class="display">{{ pace(b.bestKmSec) }}</b><span>kilomètre le plus rapide</span></div>
                }
                @if (r.s.avgHr) {
                  <div><b class="display">{{ num(r.s.avgHr) }}</b><span>bpm de FC moyenne</span></div>
                }
              </div>
            }
            @case (7) {
              <p class="kicker">En calories, ça donne…</p>
              <p class="mega display">{{ num(r.s.calories / 850) }} <span class="emoji">🍕</span></p>
              <p class="lead">pizzas margherita entières brûlées</p>
              <div class="trio">
                <div><b class="display">{{ num(r.s.calories / 280) }}</b><span>chocolatines 🥐</span></div>
                <div><b class="display">{{ num(r.s.km / 0.00065) }}</b><span>baguettes bout à bout 🥖</span></div>
                <div><b class="display">{{ num(r.s.sec / 60 / 194) }}</b><span>fois Titanic 🎬</span></div>
              </div>
            }
            @case (8) {
              <p class="kicker">Badges gagnés en {{ year() }}</p>
              @if (r.badges.length) {
                <div class="badges">
                  @for (b of r.badges; track b.id) {
                    <div class="b"><span class="b-ico">{{ b.icon }}</span><span>{{ b.name }}</span></div>
                  }
                </div>
              } @else {
                <p class="lead">Pas de nouveau badge cette année… l'an prochain !</p>
              }
              <div class="summary">
                <span class="display">RUN<b>STAT</b> {{ year() }}</span>
                <span>{{ km(r.s.km) }} · {{ r.s.count }} sorties · {{ num(r.s.elev) }} m D+ · {{ duration(r.s.sec) }}</span>
              </div>
            }
          }
        </div>
        <p class="hint">← → ou clic à gauche / à droite pour naviguer</p>
      </div>
      }
    }
  `,
  styleUrl: './recap.scss',
})
export class RecapPage {
  private readonly store = inject(DataService);
  private readonly ps = inject(PeriodService);

  protected readonly Math = Math;
  protected readonly num = num;
  protected readonly km = km;
  protected readonly pace = pace;
  protected readonly clock = clock;
  protected readonly smart = smart;
  protected readonly duration = duration;
  protected readonly paceOf = paceOf;
  protected readonly monthLetters = MONTHS;
  protected readonly monthNames = MONTH_NAMES;
  protected readonly slides = Array.from({ length: SLIDES }, (_, i) => i);
  protected fmt = (iso: string) => day(parseDay(iso));

  protected readonly years = computed(() =>
    [...new Set(this.store.activities().map((a) => Number(a.date.slice(0, 4))))].sort((a, b) => b - a),
  );
  private readonly picked = signal<number | null>(null);
  /** Par défaut : la dernière année complète, sinon l'année en cours */
  protected readonly year = computed(() => this.picked() ?? this.years().find((y) => y < this.ps.today.getFullYear()) ?? this.years()[0]);
  protected readonly index = signal(0);

  protected readonly r = computed(() => {
    const y = this.year();
    if (!y) return null;
    const all = this.store.activities();
    const acts = all.filter((a) => a.date.startsWith(String(y)));
    if (!acts.length) return null;
    const s = summarize(acts);
    const months = new Array(12).fill(0);
    for (const a of acts) months[Number(a.date.slice(5, 7)) - 1] += a.distanceKm;
    const maxMonth = Math.max(1, ...months);
    const prevKm = all.filter((a) => a.date.startsWith(String(y - 1))).reduce((t, a) => t + a.distanceKm, 0);
    const before = all.filter((a) => a.date < `${y}-01-01`);
    const upTo = all.filter((a) => a.date <= `${y}-12-31`);
    return {
      s,
      partial: y === this.ps.today.getFullYear(),
      days: activeDays(acts),
      weeks: weekStreaks(acts, new Date(y, 11, 31)).longest,
      trip: tripFor(s.km, this.store.data()?.athlete?.homeCity),
      prevKm,
      months,
      maxMonth,
      bestMonth: months.indexOf(Math.max(...months)),
      longest: topN(acts, (a) => a.distanceKm, 1)[0] ?? null,
      hilliest: topN(acts, (a) => a.elevGain ?? null, 1)[0] ?? null,
      height: headlineHeight(s.elev),
      profile: runnerProfile(acts),
      fast10: topN(acts, (a) => (a.distanceKm >= 10 && a.kind !== 'indoor' ? -paceOf(a) : null), 1)[0] ?? null,
      bestKm: topN(acts, (a) => (a.bestKmSec ? -a.bestKmSec : null), 1)[0] ?? null,
      // Badges obtenus pour la première fois cette année
      badges: BADGES.filter((b) => {
        const now = b.eval(upTo).earned;
        return now && now.startsWith(String(y)) && !b.eval(before).earned;
      }),
    };
  });

  /** Téléphone : récap en plein écran */
  protected readonly phone = signal(matchMedia('(max-width: 600px)').matches);
  protected readonly full = signal(false);
  private touch: { x: number; y: number } | null = null;

  constructor() {
    const media = matchMedia('(max-width: 600px)');
    const onMedia = (e: MediaQueryListEvent) => this.phone.set(e.matches);
    media.addEventListener('change', onMedia);
    // Avance automatique en plein écran ; un toucher relance le minuteur de la diapositive affichée
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      clearTimeout(timer);
      const i = this.index();
      if (this.full() && i < SLIDES - 1) timer = setTimeout(() => this.index.set(i + 1), SLIDE_MS);
    });
    // Pas de défilement de la page derrière la story
    effect(() => {
      document.body.style.overflow = this.full() ? 'hidden' : '';
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      media.removeEventListener('change', onMedia);
      document.body.style.overflow = '';
    });
  }

  protected pick(y: number): void {
    this.picked.set(y);
    this.index.set(0);
  }

  protected go(step: number): void {
    this.index.set(Math.min(SLIDES - 1, Math.max(0, this.index() + step)));
  }

  protected open(): void {
    this.index.set(0);
    this.full.set(true);
  }

  protected close(): void {
    this.full.set(false);
  }

  /** Glisser vers le bas : fermer ; vers la gauche ou la droite : diapositive suivante ou précédente */
  protected touchStart(e: TouchEvent): void {
    const t = e.changedTouches[0];
    this.touch = { x: t.clientX, y: t.clientY };
  }

  protected touchEnd(e: TouchEvent): void {
    if (!this.touch || !this.full()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - this.touch.x, dy = t.clientY - this.touch.y;
    this.touch = null;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
      this.close();
      e.preventDefault();
    } else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      this.go(dx < 0 ? 1 : -1);
      e.preventDefault();
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') this.go(1);
    if (e.key === 'ArrowLeft') this.go(-1);
    if (e.key === 'Escape' && this.full()) this.close();
  }
}
