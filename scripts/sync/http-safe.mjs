// Garde-fous HTTP communs aux trois zones : une requête ou une lecture de fichier ratée
// ne doit jamais faire tomber le processus (et avec lui la file des runs et les autres zones).

/** URL de la requête, ou null si elle est invalide (nginx transmet l'URI brute : `//[/../api/me` lève dans `new URL`) */
export const parseUrl = (raw) => {
  try {
    return new URL(raw ?? '/', 'http://runstat');
  } catch {
    return null;
  }
};

/** Flux de fichier vers la réponse : une erreur de lecture (fichier retiré entre-temps) coupe la réponse sans faire tomber le processus */
export const pipeFile = (stream, res) => {
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
};

/** Gestionnaire protégé : toute erreur non prévue donne un 500 (ou coupe la réponse déjà commencée) au lieu d'un rejet non géré */
export const safeHandler = (handle, log = console) => async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    log.error?.(`${req.method} : erreur non gérée : ${e?.message ?? e}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end('{"error":"erreur du serveur"}');
    else res.destroy();
  }
};

/**
 * Hôte acceptable sur le port du réseau local (zone lan, compte du propriétaire) : adresse IP, nom court ou nom local.
 * Un nom de domaine public est refusé : c'est la marque du DNS rebinding (même règle que le bloc `listen 80` de nginx).
 */
export const lanHostAllowed = (host) => {
  const name = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  return /^([0-9.]+|\[[0-9a-f:.]+\]|[a-z0-9-]+|[a-z0-9.-]+\.(local|lan|home\.arpa))$/.test(name);
};
