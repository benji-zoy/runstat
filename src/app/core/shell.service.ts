import { Injectable } from '@angular/core';

/** Fenêtres de saisie déclarées une seule fois dans la coquille (app.html) */
export type ShellForm = 'athlete' | 'users' | 'account';

/**
 * Ouvre depuis n'importe quelle page (Moi surtout) les fenêtres posées dans la coquille : réglages de l'athlète,
 * proches, compte et sauvegarde. La coquille enregistre l'ouverture de chacune au démarrage.
 */
@Injectable({ providedIn: 'root' })
export class ShellService {
  private readonly openers = new Map<ShellForm, () => void>();

  register(form: ShellForm, open: () => void): void {
    this.openers.set(form, open);
  }

  open(form: ShellForm): void {
    this.openers.get(form)?.();
  }
}
