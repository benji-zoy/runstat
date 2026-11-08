import { DestroyRef, Directive, ElementRef, Injectable, inject, input, signal } from '@angular/core';

/**
 * Mouvement côté JavaScript (le reste est dans motion.scss) : arrivée qui décélère (`EASE_ARRIVEE`), départ qui accélère
 * sans freiner. Tout respecte « Réduire les animations » du système.
 */
export const EASE_ARRIVEE = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const EASE_DEPART = 'cubic-bezier(0.4, 0, 1, 1)';

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Décélération pour les animations calculées image par image (compteurs) : rapide au départ, posée à la fin */
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

@Injectable({ providedIn: 'root' })
export class MotionService {
  /** Sorties apparues à la dernière synchro : surlignées un instant dans les listes */
  readonly fresh = signal<ReadonlySet<string>>(new Set());
  /** Dernière fiche ouverte (`run:<id>`, `goal:<id>`) : sa carte reprend la place de l'en-tête au retour */
  last: string | null = null;
  private readonly morphed = new Set<HTMLElement>();
  private freshTimer?: ReturnType<typeof setTimeout>;

  markFresh(ids: string[]): void {
    clearTimeout(this.freshTimer);
    this.fresh.set(new Set(ids));
    this.freshTimer = setTimeout(() => this.fresh.set(new Set()), 6000);
  }

  /** Une seule carte porte le nom `hero` à la fois (sinon le navigateur abandonne la transition) */
  nameHero(el: HTMLElement, key: string): void {
    this.clearMorph();
    this.last = key;
    el.style.viewTransitionName = 'hero';
    this.morphed.add(el);
  }

  clearMorph(): void {
    for (const el of this.morphed) el.style.viewTransitionName = '';
    this.morphed.clear();
  }

  /** Moment signature : une seule fois par élément (clé mémorisée sur l'appareil) */
  firstTime(key: string): boolean {
    try {
      const k = `runstat-vu-${key}`;
      if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, '1');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Carte qui se transforme en en-tête de sa fiche (`.vt-hero`) à la navigation, et inversement au retour.
 * `<a class="card" [appMorph]="'run:' + a.id">`
 */
@Directive({
  selector: '[appMorph]',
  host: { '(click)': 'claim()' },
})
export class MorphDirective {
  readonly appMorph = input.required<string>();
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly motion = inject(MotionService);

  ngOnInit(): void {
    // Retour depuis la fiche : la carte de la fiche quittée reçoit l'en-tête
    if (this.motion.last === this.appMorph()) this.motion.nameHero(this.el, this.appMorph());
  }

  protected claim(): void {
    this.motion.nameHero(this.el, this.appMorph());
  }
}

/**
 * Moment signature (record, objectif atteint) : reflet volt et fil d'arrivée, joués une seule fois par clé et par appareil ;
 * ensuite le fil reste, sans animation.
 */
@Directive({
  selector: '[appSignature]',
  host: { '[class.signature]': '!!appSignature()' },
})
export class SignatureDirective {
  /** Clé du moment (null : élément ordinaire) */
  readonly appSignature = input.required<string | null>();
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly motion = inject(MotionService);

  ngOnInit(): void {
    const key = this.appSignature();
    if (key && this.motion.firstTime(key)) this.el.classList.add('play');
  }
}

/** Conteneurs dont l'élément actif est marqué par un fond ou un soulignement : l'indicateur glisse de l'ancien au nouveau */
const SLIDERS = '.seg, app-subtabs .bar, .topbar .tabs, nav.bottom';

/**
 * Indicateur qui glisse : au clic dans un conteneur, on note la place de l'élément actif, on attend que la classe
 * `active` passe au nouvel élément (navigation ou signal), puis un fantôme reprenant son apparence (fond, rayon,
 * soulignement) glisse de l'ancienne place à la nouvelle. Un seul écouteur pour toute l'appli.
 */
export function installSlidingIndicators(destroy: DestroyRef): void {
  const onClick = (e: MouseEvent) => {
    if (prefersReducedMotion() || !(e.target instanceof Element)) return;
    const host = e.target.closest<HTMLElement>(SLIDERS);
    if (!host) return;
    const target = [...host.children].find((c) => c.contains(e.target as Node)) as HTMLElement | undefined;
    const old = host.querySelector<HTMLElement>(':scope > .active');
    if (!target || !old || target === old) return;
    const from = box(host, old);
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    const observer = new MutationObserver(() => {
      if (!target.classList.contains('active') || !target.isConnected) return;
      done();
      slide(host, target, old, from);
    });
    observer.observe(host, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const timer = setTimeout(done, 4000);
  };
  document.addEventListener('click', onClick, true);
  destroy.onDestroy(() => document.removeEventListener('click', onClick, true));
}

function box(host: HTMLElement, el: HTMLElement) {
  const h = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - h.left + host.scrollLeft - host.clientLeft, y: r.top - h.top + host.scrollTop - host.clientTop, w: r.width, h: r.height };
}

function slide(host: HTMLElement, target: HTMLElement, old: HTMLElement, from: ReturnType<typeof box>): void {
  // Sans transition le temps du glissement : l'apparence lue est l'état final, l'ancien s'éteint d'un coup sous le fantôme
  for (const el of [target, old]) el.style.transition = 'none';
  const restore = () => void requestAnimationFrame(() => [target, old].forEach((el) => (el.style.transition = '')));
  const style = getComputedStyle(target);
  const fill = style.backgroundColor;
  const line = style.boxShadow;
  if ((fill === 'rgba(0, 0, 0, 0)' || fill === 'transparent') && (line === 'none' || !line)) return restore();
  host.querySelector(':scope > .slide-ghost')?.remove();
  const to = box(host, target);
  const ghost = document.createElement('span');
  ghost.className = 'slide-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    width: `${to.w}px`,
    height: `${to.h}px`,
    background: fill,
    boxShadow: line,
    borderRadius: style.borderRadius,
  });
  host.classList.add('slide-host', 'sliding');
  host.append(ghost);
  const anim = ghost.animate(
    [
      { transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px` },
      { transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px` },
    ],
    { duration: 320, easing: EASE_ARRIVEE },
  );
  const end = () => {
    ghost.remove();
    if (!host.querySelector(':scope > .slide-ghost')) host.classList.remove('sliding');
    restore();
  };
  anim.onfinish = end;
  anim.oncancel = end;
}
