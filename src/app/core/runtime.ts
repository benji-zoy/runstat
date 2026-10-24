// Mode d'exécution, fixé à la construction (option `define` d'angular.json, ou `ng build --define`) :
//   site du NAS (défaut) : données servies par le NAS (/data, /api), compte reconnu par Tailscale ;
//   appli publique (configuration `pages`, GitHub Pages) : local-first, données sur l'appareil (IndexedDB, core/local.service.ts).
declare const RUNSTAT_LOCAL: boolean | undefined;
declare const RUNSTAT_NAS_ORIGINS: string | undefined;

export const LOCAL_MODE: boolean = typeof RUNSTAT_LOCAL !== 'undefined' && RUNSTAT_LOCAL === true;

/** Adresses publiques (Funnel) des NAS connus, variable RUNSTAT_NAS_ORIGINS du dépôt : liens d'invitation acceptés sans écran d'avertissement */
export const KNOWN_NAS: string[] = (() => {
  try {
    return typeof RUNSTAT_NAS_ORIGINS === 'string' ? (JSON.parse(RUNSTAT_NAS_ORIGINS) as string[]) : [];
  } catch {
    return [];
  }
})();
