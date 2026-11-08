import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';
import { easeOutExpo, prefersReducedMotion } from './motion';

/** Nombre au format français (« 1 234 », « 12,5 ») ou chrono (« 3:45:12 », « 4:59 ») */
const NUMBER = /\d{1,3}(?:[\u202f\u00a0 ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
const CLOCK = /^(\d+):(\d{2})(?::(\d{2}))?$/;

interface Token {
  value: number;
  decimals: number;
  grouped: boolean;
  /** Zéros de tête (« 02 » dans « 1 h 02 ») : largeur gardée */
  pad: number;
}

/**
 * Chiffre clé qui défile jusqu'à sa valeur en ralentissant à la fin, la première fois qu'il apparaît à l'écran ; ensuite,
 * d'une valeur à l'autre. Reçoit le texte déjà formaté et le réécrit tel quel à chaque image (mêmes séparateurs, mêmes
 * décimales) ; un chrono défile en secondes. `<span [appCountUp]="clock(e.predicted)"></span>`
 */
@Directive({ selector: '[appCountUp]' })
export class CountUpDirective {
  readonly appCountUp = input.required<string>();
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private shown: string | null = null;
  private frame = 0;
  private seen = false;

  constructor() {
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io?.disconnect();
      this.seen = true;
      this.run(this.appCountUp(), null);
    }, { threshold: 0.4 });
    io?.observe(this.el);
    if (!io) this.seen = true;

    effect(() => {
      const text = this.appCountUp();
      if (!this.seen) {
        // Pas encore à l'écran : la valeur finale (lisible, accessible) en attendant, le défilement partira de zéro
        this.el.textContent = text;
        return;
      }
      this.run(text, this.shown);
    });
    inject(DestroyRef).onDestroy(() => {
      io?.disconnect();
      cancelAnimationFrame(this.frame);
    });
  }

  private run(text: string, from: string | null): void {
    cancelAnimationFrame(this.frame);
    this.shown = text;
    const render = frames(text, from);
    if (!render || prefersReducedMotion()) {
      this.el.textContent = text;
      return;
    }
    const start = performance.now();
    const duration = from === null ? 1100 : 600;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      this.el.textContent = t >= 1 ? text : render(easeOutExpo(t));
      if (t < 1) this.frame = requestAnimationFrame(tick);
    };
    this.el.textContent = render(0);
    this.frame = requestAnimationFrame(tick);
  }
}

/** Texte intermédiaire à l'avancement `k` (0 → 1), ou null s'il n'y a rien à faire défiler */
function frames(text: string, from: string | null): ((k: number) => string) | null {
  const clock = CLOCK.exec(text.trim());
  if (clock) {
    const target = toSec(clock);
    const prev = from ? CLOCK.exec(from.trim()) : null;
    const origin = prev && !!prev[3] === !!clock[3] ? toSec(prev) : 0;
    if (origin === target) return null;
    return (k) => fmtClock(Math.round(origin + (target - origin) * k), !!clock[3]);
  }
  const parts = text.split(NUMBER);
  const tokens = [...text.matchAll(NUMBER)].map((m) => token(m[0]));
  if (!tokens.length) return null;
  const prevTokens = from && from.split(NUMBER).join('|') === parts.join('|') ? [...from.matchAll(NUMBER)].map((m) => token(m[0])) : null;
  const sep = /[\u202f\u00a0 ]/.exec(text)?.[0] ?? '\u202f';
  return (k) =>
    parts.reduce((out, p, i) => {
      if (i === 0) return p;
      const t = tokens[i - 1];
      const o = prevTokens?.[i - 1]?.value ?? 0;
      return out + fmt(o + (t.value - o) * k, t, sep) + p;
    }, '');
}

function token(s: string): Token {
  const [int, dec] = s.replace(/[\u202f\u00a0 ]/g, '').split(',');
  return { value: Number(`${int}.${dec ?? 0}`), decimals: dec?.length ?? 0, grouped: /[\u202f\u00a0 ]/.test(s), pad: /^0\d/.test(int) ? int.length : 0 };
}

function fmt(v: number, t: Token, sep: string): string {
  const [raw, dec] = v.toFixed(t.decimals).split('.');
  const int = raw.padStart(t.pad, '0');
  const grouped = t.grouped || int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : int;
  return dec ? `${grouped},${dec}` : grouped;
}

function toSec(m: RegExpExecArray): number {
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

function fmtClock(sec: number, hours: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours) return `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
}
