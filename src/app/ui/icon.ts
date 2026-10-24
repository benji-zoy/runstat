import { Component, computed, input } from '@angular/core';

/** Icônes au trait (24 × 24, couleur du texte) : navigation et repères, à la place des emojis */
const PATHS = {
  today: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  training: 'M3 12h4l3-8 4 16 3-8h4',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  star: 'M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21l1.5-7L2 9.3l7-.8z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  sync: 'M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5',
  plus: 'M12 5v14M5 12h14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  close: 'M18 6L6 18M6 6l12 12',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'app-icon',
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" [attr.stroke-width]="stroke()" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path [attr.d]="d()" />
    </svg>
  `,
  styles: `
    :host { display: inline-flex; width: var(--icon, 1.1em); height: var(--icon, 1.1em); flex: none; }
    svg { width: 100%; height: 100%; }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly stroke = input(2);
  protected readonly d = computed(() => PATHS[this.name()]);
}
