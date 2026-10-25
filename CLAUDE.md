# RunStat

Dashboard Angular 21 (standalone + signals, Chart.js) alimenté par un snapshot JSON (`public/data/coros.json`, nom historique)
des données COROS ou Strava (voir Sources).
Interface en français. Node local : 24.14 → rester sur Angular 21 (le CLI 22 exige Node ≥ 24.15).

## Synchronisation automatique (NAS, `scripts/sync/`)

Le conteneur `runstat-sync` (NAS, `scripts/sync/server.mjs`) lance `scripts/sync/run.mjs` pour chaque compte hébergé (voir Comptes),
un run à la fois (`queue.mjs`), au démarrage, toutes les 3 h
et à la demande (bouton de l'en-tête, `core/sync.service.ts` → `/api/sync`, proxy nginx ; masqué sans ce service ; `POST /api/fit?id=` →
`run.mjs --fit <id>` : le FIT d'une seule sortie puis build-fit + build-data, sans toucher à la fenêtre de synchro) : COROS (activités des derniers jours
fusionnées dans `records.txt`, détails, forme, charge cumulée dans `load.txt`, FIT jusqu'au quota) et Google Health API
(santé quotidienne + sommeil → `data-raw/health-api.json`, prioritaire sur `health.json` de Takeout), recouvrement de
3 jours, puis build-fit, build-data, fit-queue, météo. **Le NAS fait foi pour `data-raw/`** : `npm run nas -- pull` avant
de travailler sur les données. Les objectifs, bilans, classements et réglages se saisissent dans le site (voir Saisie) ; à la main,
`npm run nas -- push goals.json athlete.json results` (pris en compte au run suivant). FC max/repos ou seuils modifiés dans
`athlete.json` → `build-fit --force` (empreinte `athleteFit` dans l'état ; poids, taille, `raceWeights` ne recalculent pas les FIT). État : `data-raw/sync-state.json` (dernier succès,
dernière erreur, ré-autorisation) ; réponses brutes : `data-raw/raw/<source>/<type>/`. Logs : Container Manager.
- Clients et synchro dans le moteur (`src/engine/sync/`, les mêmes que sur l'appareil, voir Appli publique) : `coros.ts` (MCP HTTP sans
  session, **liste blanche `READ_TOOLS`**, aucun outil d'écriture), `strava.ts` (GET sur `READ_PATHS`), `google.ts` (API v4 ; filtres en
  snake_case `daily_resting_heart_rate.date`, contrairement à la doc ; jeton par un point injecté), `run-sources.ts` (`sourceSync` : une
  synchro par source, `syncOne` pour « Affiner »), `http.ts` (`fetchRetry`, `ReauthRequired`, `RateLimited`, magasin de jetons `TokenStore`
  avec `savedAt` et `refresh` facultatif). `coros.mjs`, `strava.mjs`, `google-health.mjs` et `run.mjs` n'en sont que des enveloppes Node
  (jetons dans un dossier de secrets : `nodeTokens` de `secrets.mjs`, `savedAt` = date du fichier ; zone raw = `NodeStore`).
  Pas de score de préparation, de score de sommeil ni de FC intraday par l'API.
- Tokens dans `secrets/` (poste) ou `users/<id>/secrets/` (NAS), jamais affichés. Connexion depuis le site, pour chaque compte :
  Réglages › « Connecter COROS » / « Connecter Google » (`oauth-connect.mjs`, `GET /api/coros|google/connect` puis `/callback`, mêmes
  gardes que Strava : state aléatoire lié au compte, 10 min, usage unique, `redirect_uri` = origine ts.net de `SYNC_PUBLIC_ORIGINS`, retour
  `/aujourdhui?coros|google=ok|refus&raison=…`). COROS : client public enregistré dynamiquement pour cette adresse, PKCE ; client et jetons
  écrits ensemble au retour seulement (jamais un client neuf à côté d'anciens jetons). Google : client OAuth « Web » du propriétaire
  (`users/<propriétaire>/secrets/google-client.json`, transmis aux runs des proches par `RUNSTAT_GOOGLE_CLIENT`, jamais recopié) ; y
  déclarer l'URI `https://<hôte ts.net>/api/google/callback` dans la console Google Cloud et, en mode test, ajouter chaque proche comme
  testeur (jetons de 7 jours). Secours sur le poste : `npm run auth -- coros | google` (navigateur + loopback), puis copier les fichiers
  de jetons dans `users/<id>/secrets/` du NAS. Le refresh token COROS change à chaque renouvellement : un seul détenteur (le NAS),
  sinon l'autre est révoqué.
- `npm run test:sync` (parseurs, fusions idempotentes, liste blanche, validation de la saisie ; `strava.test.mjs` : archive Strava,
  tracés, santé COROS sur les fixtures fictives de `scripts/sync/fixtures/` ; `strava-connect.test.mjs` : connexion Strava, fetch bouchonné ;
  `accounts.test.mjs` : identité par zone, cloisonnement A/B, administration, invitations, file, migration ; `oauth-connect.test.mjs` :
  connexion COROS et Google, fetch bouchonné ; `public-api.test.mjs` : CORS, passkeys ES256/RS256, sessions et ré-authentification,
  sauvegarde cloisonnée et versionnée, relais, limites, aller-retour chiffré du client du moteur contre le vrai serveur), `npm run spike -- coros | google` (dumps bruts).

## Sources au choix (`data-raw/sources.json`, `scripts/sync/sources.mjs`, `core/sources.ts`)

`{ "activities": "coros" | "strava", "health": "google" | "coros" | "none" }`, absent = COROS + Google Health ; modifiable dans
Réglages (`GET|PUT /api/sources`, reconstruction complète). Une seule source d'activités par instance, sans dédoublonnage.
`run.mjs` ne synchronise que les sources choisies ; `build-data` les recopie dans `sources` et chaque sortie porte `source`.
L'interface lit `ScienceService.caps()` (`CAPABILITIES`) pour masquer ce que la source ne fournit pas (charge, TE et focus,
VO₂max et prédictions de la montre, ratio de charge, quota FIT) ; sans santé, Forme › Récupération disparaît.
- **Strava** : identifiants `strava:<id>`, fichiers `strava-<id>` (`fileKey`, pas de « : » sur le partage SMB), `sportType` au code
  COROS (100 route, 101 tapis/virtuel, 102 trail). Sorties dans `data-raw/strava/activities.json` (`src/engine/parsers/strava.ts`).
  Replis dans `build-data` : charge = TRIMP (`fit.trimp`, sinon FC moyenne), meilleur km = effort FIT de 1 000 m, départ = premier
  point du tracé ; `fitness: null`, `load: []` ; le modèle Coros sort seul du consensus de prédiction ; `workout_type` course → `race`.
- **Archive Strava** (historique, conforme : ses propres données) : `npm run strava -- <export.zip>` sur le poste, ou Réglages ›
  « Importer l'archive » (`POST /api/strava/archive`, flux vers `data-raw/import/`, 2 Gio au plus, puis `run.mjs --import-strava`,
  zip supprimé). `activities.csv` (en-têtes anglais ou français, colonnes en double, dates UTC → Europe/Paris), FIT décompressés
  dans `fit/`, GPX/TCX dans `tracks/*.gz` lus par `src/engine/fit/track.ts` (même structure que `fit-file-parser`, puis `analyse()` du moteur).
  Lecteur zip maison (`zip.mjs`, zip64, sans dépendance). Le numéro du fichier de l'archive n'est pas l'id de l'activité.
- **API REST Strava** (`strava.mjs`, GET sur la liste blanche `READ_PATHS`) : le MCP officiel `mcp.strava.com` est réservé à Claude et aux
  abonnés, et la politique API interdit de le relayer. Pas d'appli commune : chacun crée la sienne sur strava.com/settings/api
  (abonnement Strava requis pour la créer ; sinon, l'archive), avec pour **Authorization Callback Domain l'hôte ts.net du site**
  (`<nas>.<tailnet>.ts.net`, première adresse HTTPS de `SYNC_PUBLIC_ORIGINS` ; localhost est toujours accepté). Réglages › Synchro Strava : Client ID + Client Secret
  (`PUT /api/strava/client` → `secrets/strava-client.json`, jamais relu par le site ; changer d'appli efface les jetons), puis
  « Connecter Strava » (`strava-connect.mjs`) : `GET /api/strava/connect` (state aléatoire en mémoire, 10 min, usage unique ; 302 vers
  l'autorisation Strava, scope `read,activity:read_all`, `redirect_uri` = origine du site lue dans X-Forwarded-Host / Host et
  X-Forwarded-Proto, transmis par nginx, acceptée seulement si elle est dans `SYNC_PUBLIC_ORIGINS` de `docker-compose.yml`, sinon
  localhost seul), `GET /api/strava/callback` (state vérifié, sans en-tête X-RunStat puisque c'est une navigation : rien n'est écrit
  sans state valide ; échange du code, `strava-tokens.json` avec le scope accordé, `reauthSince` levé, synchro lancée) puis
  `/aujourdhui?strava=ok|refus&raison=…` (message sous le bouton de synchro, paramètres retirés). `GET /api/sync` ajoute
  `stravaClient`, `stravaConnected`, `stravaAthlete` (prénom et n° d'athlète, jamais les jetons) et `stravaOrigin` (première adresse HTTPS
  de la liste : Réglages y envoie le bouton et l'affiche comme domaine de rappel dans le guide pas à pas). En secours : `npm run auth -- strava`
  sur le poste, puis copier `strava-tokens.json` sur le NAS. Un seul athlète par instance pour l'instant. Synchro : activités depuis la dernière date − 3 jours,
  streams de 40 sorties par run → `tracks/strava-<id>.json.gz`, arrêt à 90 % du quota des 15 min. `STRAVA_API_URL` pour la nouvelle
  adresse obligatoire au 1er juin 2027. Politique Strava : cache de 7 jours au plus (§ 6.2), assumé pour l'historique personnel ;
  accès révoqué → supprimer `data-raw/strava` et les fichiers `strava-*` sous 30 jours.
- **Santé COROS** (`src/engine/parsers/coros-health.ts`, source `corosHealth` de l'état, jetons COROS) : `queryDailyHealthData` (sommeil, score),
  `querySleepHrv` (VFC, 7 jours par appel), `queryRestingHeartRate` → `data-raw/health-coros.json` (un an au premier passage).
  Pas de poids, de préparation ni de température.

## Moteur portable (`src/engine/`)

Tout ce qui transforme les données brutes en snapshot (`coros.json`, `routes.json`) est du TypeScript sans API Node ni Angular,
pour tourner aussi dans le navigateur (local-first, phase 4) : `fit/` (`analyse()`, tracés GPX/TCX/streams, lecture FIT par
`fit-file-parser` + polyfill `buffer`, gunzip par `DecompressionStream`), `parsers/` (COROS, Google Health, Strava, santé COROS),
`snapshot/` (`buildSnapshot` = ex-build-data, textes COROS), `pipeline/build-fit.ts` (cache `fit-derived/` par `FIT_VERSION`),
`fit-queue.ts`, `sources.ts`. Entrées-sorties par `storage/` : `FileStore` (`list`, `read`, `readText`, `write`, `remove`), deux zones
`raw` (data-raw) et `snapshot` (public/data) ; `MemoryStore`, `IndexedDbStore` (base `runstat-engine`, un magasin par zone), et
`NodeStore` côté Node (`scripts/node-storage.mjs`, écriture atomique). Aussi dans le moteur : `weather.ts` (Open-Meteo, `fetch`
injecté ; `fetch-weather.mjs` n'est plus qu'une enveloppe), `archive/` (lecteur zip sur une source à accès direct, `Blob` du navigateur ou
`fs.openAsBlob` de Node, `DecompressionStream` borné ; import de l'archive Strava, enveloppé par `strava-archive.mjs`), `entries.ts`
(validation de la saisie, réexportée par `entries.mjs`), `pipeline/rebuild.ts` (reconstruction complète sur l'appareil). Aussi `sync/` (clients des sources et
synchro, voir Synchronisation). Restent en Node : `server.mjs`, `import-health.mjs`, les enveloppes (`run.mjs`, `*.mjs` des clients). Pas de `Blob.stream()` dans le moteur (absent de jsdom) : flux construits à la main.
- Node exécute les `.ts` directement (**type stripping** de Node 24, sans build) : les scripts importent `#engine/…` (champ `imports`
  de `package.json`), le moteur importe avec l'extension `.ts` (`rewriteRelativeImportExtensions` côté Angular) et reste en syntaxe
  effaçable (pas d'enum, de namespace ni de propriété de paramètre : `npm run check:engine`). `src/engine/package.json` le déclare en ESM.
- `npm run deploy` copie le moteur dans `app/scripts/engine/` et y réécrit `#engine/*` : le YAML de Container Manager ne change pas.
- Tests : `src/engine/**/*.spec.ts` (`ng test`), sur les données fictives de `scripts/sync/fixtures/engine/` (`sortie.fit` généré par
  `make-fit.mjs`, instances `raw/` COROS + Google et `raw-strava/`, sorties attendues `expected/` produites par l'ancien pipeline Node),
  chargées par l'option `loader` d'angular.json. Le moteur doit redonner ces sorties à l'identique, y compris avec IndexedDB (fake-indexeddb).
  Dans Vitest, les paquets npm restent externes (`buffer` natif de Node) : le polyfill n'est éprouvé que dans un vrai bundle navigateur.
- Changement du moteur : `npm run data` avant / après sur la même copie de `data-raw/`, puis
  `node scripts/compare-snapshot.mjs <avant> <après>` (coros.json hors generatedAt, routes.json, fit-derived/, missing-details.txt) :
  zéro écart attendu, sauf changement voulu (alors incrémenter `FIT_VERSION` si l'analyse FIT change).

## Appli publique et mode local-first (`core/runtime.ts`, `core/local.service.ts`, `core/engine.worker.ts`)

Une seule base de code, deux constructions : site du NAS (`ng build`, défaut) et appli publique sans données (`ng build -c pages`, GitHub
Pages sous `/runstat/`, `RUNSTAT_LOCAL` posé par `define`). En local-first, tout reste sur l'appareil : IndexedDB `runstat-engine` (zones
`raw` et `snapshot`), calculs par le moteur dans un Web Worker (`engine.worker.ts` : `rebuild`, import de l'archive Strava lue par
morceaux, jamais envoyée), un calcul à la fois, reconstructions regroupées. `DataService` lit le snapshot local (aucun = écran
« Bienvenue »), `EntriesService` valide avec `src/engine/entries.ts` (mêmes règles que le NAS) puis recalcule ; `available` (saisie) est
vrai en local, `SyncService.available` (bouton de synchro) dès qu'une source est connectée sur l'appareil (voir Synchro sur
l'appareil). Météo Open-Meteo depuis le navigateur (hors ligne : snapshot quand même, erreur
dans `local-state.json`). `navigator.storage.persist()` à la première saisie ; bandeau « écran d'accueil » sur iPhone (Safari efface
les données après 7 jours sans visite, sauf appli installée). `fit-file-parser` et `buffer` sont des dépendances de l'appli (polyfill
éprouvé dans le vrai bundle du worker ; versions verrouillées : un changement de version change l'analyse FIT).
- Build Pages : `baseHref /runstat/`, `data/` exclu des fichiers copiés, `inlineCritical` coupé (gestionnaire `onload` en ligne),
  puis `scripts/pages-postbuild.mjs` : CSP en balise meta (scripts `'self'` + empreinte du script de thème, `connect-src` limité aux services
  appelés et aux NAS de `RUNSTAT_NAS_ORIGINS`), `referrer no-referrer`, `404.html` = `index.html` (routes Angular). Vérifier en local :
  `npx ng build -c pages && node scripts/pages-postbuild.mjs && node scripts/serve-pages.mjs` (config `runstat-pages`, http://localhost:4320/runstat/).
- `.github/workflows/pages.yml` (main seulement, actions épinglées par SHA, `npm ci`, droits minimaux) : tests, build avec
  `--define RUNSTAT_NAS_ORIGINS=…` (variable du dépôt, liste d'adresses Funnel → `KNOWN_NAS`), CSP, publication. Mise en service (avec
  l'accord du propriétaire) : variable `RUNSTAT_NAS_ORIGINS`, Settings › Pages › Source « GitHub Actions », puis variable
  `RUNSTAT_PAGES=true` (sans elle, le workflow ne publie pas : `main` ne casse pas tant que Pages n'est pas activé). La valeur de
  `--define` est une expression JS : une chaîne JSON encodée deux fois (`'RUNSTAT_NAS_ORIGINS="[\"http://localhost:8789\"]"'`) ; un tableau
  nu donne `KNOWN_NAS` vide (écran « Serveur inconnu »).

### Synchro des sources sur l'appareil (`core/device-sync.service.ts`, `pages/oauth-return.ts`)
Le moteur de `src/engine/sync/` dans le navigateur (thread principal ; COROS, Strava, Google Health et l'hôte des FIT acceptent le CORS) :
`sourceSync(raw, clients, { stage: false })` (pas de réponses brutes : sauvegarde plus légère), puis `rebuild` dans le worker, `fit-queue.txt`
(COROS), rechargement. À l'ouverture si la dernière tentative date de plus d'une heure, et au bouton de l'en-tête (`SyncService` en local
lit l'état de l'appareil : `sync-state.json`, présence des jetons). « Affiner avec le tracé » : `syncOne`.
- Jetons dans la zone raw, `secrets/<nom>.json` (`fileTokenStore`, avec `savedAt`) : chiffrés dans la sauvegarde, donc suivent le compte.
  Appli Strava de la personne (Client ID + Secret, `validateStravaApp` comme sur le NAS) gardée sur l'appareil, jamais envoyée au NAS.
- **Appareil principal** (`sync-primary.json` : appareil, nom, époque, fusionné par la sauvegarde) : seul à renouveler les jetons (le
  refresh token COROS et Strava change à chaque renouvellement). Renouvellement sous `navigator.locks` (`runstat-jeton-<nom>`, relecture des
  jetons une fois le verrou pris) : avant, `account.sync()` (jetons et appareil principal les plus récents) puis vérification (sans
  appareil principal, il le devient ; un autre → `NotPrimary`, rien n'est envoyé au serveur de jetons) ; après, sauvegarde aussitôt.
  Sauvegarde verrouillée (phrase non saisie) ou session expirée : pas de renouvellement. Sans compte : appareil seul, direct. Synchros
  sous le verrou `runstat-sources` (un onglet à la fois). Réglages › « Devenir l'appareil principal » : époque suivante, sauvegarde.
  Se connecter à une source depuis un appareil en fait l'appareil principal.
- OAuth depuis le navigateur, adresse de retour `<appli>connexion/<source>` (Réglages › « Connecter … », state + vérificateur PKCE dans
  `sessionStorage`, usage unique, code retiré de l'adresse) : COROS par enregistrement dynamique (client « RunStat (appli) ») et PKCE,
  échange direct ; Strava par l'appli de la personne (domaine de rappel : hôte de l'appli publique, `benji-zoy.github.io`), échange
  direct (secret depuis l'appareil) ; Google seulement avec un compte : identifiant du client et adresses de retour par
  `GET /relay/google/client`, échange et renouvellement par le relais (le propriétaire déclare `<appli>connexion/google` dans la console
  Google Cloud). Retour vers `/aujourdhui?<source>=ok|refus&raison=…`, puis synchro.
- Tests : `src/engine/sync/sync.spec.ts` (fetch bouchonné : COROS complet, quota FIT, listes blanches, rotation du jeton avec deux appels
  simultanés, renouvellement refusé, pause « ré-autorisation » puis reprise, Strava et limite de débit, Google par le relais, « Affiner »),
  `core/device-sync.service.spec.ts` (appareil principal, sauvegarde verrouillée, appli Strava, retour de connexion), `sync.test.mjs`
  (`run.mjs` réel contre un MCP simulé : `COROS_MCP_URL`).

### Sauvegarde chiffrée et multi-appareils (`src/engine/backup/`, `core/account.service.ts`, `pages/join.ts`)
Compte d'un proche local-first sur le NAS qui l'a invité (API publique, voir Comptes › Accès public). Le serveur ne voit que des
identifiants opaques, des tailles et des versions ; tout est chiffré sur l'appareil.
- `crypto.ts` (WebCrypto) : clé de données aléatoire (32 octets) enveloppée en AES-GCM par une clé PBKDF2-SHA256 de la phrase de passe
  (sel 16 octets, **600 000 itérations au moins, imposé côté client** quoi que dise l'en-tête), et par le code de secours facultatif
  (Crockford base32, 24 caractères, tirets et casse ignorés). Changer de phrase de passe ou de code = réenvelopper la même clé. Clés de travail
  (HKDF) non extractibles : `enc` (AES-GCM) et `mac` (HMAC). Objet : identifiant = HMAC du clair (vérifié après déchiffrement),
  IV ‖ chiffré, données associées `rs-obj-v1|id` ; manifeste : `rs-manifest-v1|compte|version` (ni rejouable sous une autre version,
  ni d'un autre compte). `WrongPassphrase`, `TamperedData`.
- `sync.ts`, `syncBackup` : envoie les fichiers de `raw` modifiés, télécharge ceux des autres appareils, fusionne, puis `PUT` du manifeste
  avec `If-Match` (412 → relecture et nouvelle fusion, 4 essais). Fusion par fichier : horloge de Lamport, appareil pour départager,
  suppression = pierre tombale (pas d'horloge murale ; même fichier modifié sur deux appareils : le dernier écrit gagne). Fichiers de
  moins de 256 Kio regroupés en paquets de 4 Mio au plus. Anti-retour : plus haute version vue gardée dans `backup-index.json`, un manifeste
  plus ancien est refusé (`Rollback`) ; manifeste le plus récent illisible → dernier lisible. Non sauvegardé : `fit-derived/`,
  `local-state.json`, `backup-index.json`, `missing-details.txt` (reconstruits). Restaurer = synchroniser un stockage vide, puis `rebuild`.
- `account.service.ts` (IndexedDB `runstat-account` : NAS, jeton de session, appareil, clés de travail ; jamais la phrase de passe ni la
  clé de données) : `join` (invitation + passkey), `login` (passkey), `redeemLink` (lien de connexion), `create`, `unlock` (phrase ou code
  de secours), `changePassphrase`, `newRecoveryCode`, `deviceLink` (ré-authentification par passkey), `logout` (session révoquée, données
  gardées sur l'appareil). Sauvegarde automatique 5 s après chaque reconstruction (`LocalService.onRebuilt`).
- Parcours : `/rejoindre#nas=…&code=…` (NAS hors `KNOWN_NAS` → écran « Serveur inconnu » qui affiche l'hôte ; consentement santé,
  RGPD art. 9.2.a ; passkey ; phrase de passe proposée par `core/passphrase.ts`, 6 mots parmi 256 ; code de secours affiché une fois),
  `/connexion` (passkey + adresse du NAS) ou `/connexion#nas=…&lien=…` (lien de 15 min créé dans « Compte et sauvegarde »), puis phrase de
  passe et restauration. Fragment effacé de l'adresse dès sa lecture. Bouton nuage de l'en-tête : `ui/forms/account-form.ts`.
- Vérifier le parcours en local : `users/users.json` de test (un propriétaire hébergé, un compte `local`), `server.mjs --no-schedule` avec
  `RUNSTAT_APP_URL=http://localhost:4320/runstat/`, `RUNSTAT_PUBLIC_URL=http://localhost:8789`, `RUNSTAT_APP_ORIGINS=http://localhost:4320` ;
  invitation par `POST http://localhost:8788/api/admin/invitations` (en-têtes `Tailscale-User-Login` du propriétaire et `X-RunStat: sync`) ;
  build Pages servi sur 4320 ; passkey simulée en remplaçant `navigator.credentials` par du JS (clé ECDSA P-256, attestation `none`) ;
  « second appareil » = bases IndexedDB effacées. Supprimer `users/` ensuite. Le test `public-api.test.mjs` fait le même aller-retour
  (client du moteur contre le vrai serveur) sans navigateur.

## Saisie depuis le site (`scripts/sync/entries.mjs`, `core/entries.service.ts`, `ui/forms/`)

`GET|PUT /api/goals`, `GET|PUT /api/athlete`, `GET|PUT /api/sources`, `GET|PUT|DELETE /api/results/<id>[?replaces=date-….json]` (même garde
`X-RunStat` que `/api/sync`, corps ≤ 64 Ko) : validation stricte (champs connus seulement, aucun nom de tiers), écriture atomique
dans `data-raw/`, puis `run.mjs --rebuild` (reconstruction sans les sources ; une saisie pendant un run en relance une à la fin).
Le site applique le changement tout de suite (objectifs et bilans sont évalués côté client) puis recharge après la reconstruction.
Formulaires dans un `<dialog>` commun (`ui/forms/form-dialog.ts`, Reactive Forms, styles `.fields`, `.field`, `.btn` de `styles.scss`) :
objectif (Courses : « Objectif », « Modifier l'objectif »), bilan (Archives), classement + poids de la course (Classements : « Saisir »),
réglages et sources (bouton de l'en-tête). Masqués sans service de synchro (`ng serve` ; avec le service local
`node scripts/sync/server.mjs --no-schedule`, config `runstat-sync`, la config `runstat-api` de `.claude/launch.json` relaie `/api` par `proxy.conf.json`). Durées lues par `parseDuration` (`core/format.ts`).
Chaque saisie ne touche que le compte de la requête (voir Comptes). Sans `users.json` (mono-utilisateur, `ng serve`, poste),
pas d'authentification : quiconque atteint le service peut écrire.

## Comptes et autorisation (`scripts/sync/accounts.mjs`, `app.mjs`, `queue.mjs`, `core/me.service.ts`)

`RUNSTAT_USERS/users.json` (NAS : `/docker/runstat/users`, volume `/app/users`) : `[{ id, name, role: owner|member, mode: hosted|local,
logins: [login Tailscale] }]`, un seul propriétaire, logins uniques sans casse ; données de chaque compte dans `users/<id>/data-raw`,
`snapshot` (coros.json, routes.json) et `secrets`. Sans ce fichier : instance mono-utilisateur historique (`data-raw/`, `public/data/`,
`secrets/`), comme avant. **La confiance vient du port, jamais d'un en-tête** : `server.mjs` écoute une zone par port, et chaque bloc
`server` de nginx (`deploy/nginx/default.conf`) ne relaie que vers le sien :
- `:80` → 8787, zone `lan` : port 8080 du NAS lié à son adresse locale (pas 0.0.0.0, sinon joignable par l'adresse Tailscale du NAS
  qu'ont les proches) → compte du propriétaire, sans administration ; en-têtes `Tailscale-User-*` effacés (`proxy.inc`).
- `:81` → 8788, zone `tailnet` : `127.0.0.1:8090` du NAS, cible de Tailscale Serve (qui retire les `Tailscale-User-*` du client et pose
  les siens) ; seule la passerelle du réseau Docker (172.28.0.1, sous-réseau fixé dans le compose) est admise. Login vide, inconnu ou
  compte `local` → 403.
Toutes les routes (`/api/sync`, `/api/fit`, saisie, `/api/strava/*`, `/api/data/<coros|routes>.json`) résolvent d'abord le compte puis
ne touchent qu'à ses dossiers (`userPaths`) ; nginx renvoie `/data/` vers `/api/data/` (plus d'instantané dans la racine web).
`GET /api/me` ; `GET|PUT /api/admin/users` (propriétaire par le tailnet seulement ; il garde son compte, son rôle et le login de sa
requête ; dossiers créés à l'ajout, données gardées au retrait) : bouton « Proches » de l'en-tête (`ui/forms/users-form.ts`). Ajouter un
proche hébergé : son login Tailscale dans Proches, puis partager le nœud du NAS dans la console Tailscale (Machines › Partager). Nouveau
compte : écran « Bienvenue » (404 sur `data/coros.json`), puis Réglages et sources. Le `state` OAuth de Strava est lié au compte.
- Runs : un seul à la fois pour tout le NAS, ordre d'arrivée, au plus une tâche de chaque sorte en attente par compte (une synchro
  complète remplace une reconstruction ; un seul tracé ; deux archives) ; `POST /api/sync` → 202 même en file (`queued`), 429 seulement
  dans les 20 s suivant une synchro complète. Chaque run reçoit un environnement en liste blanche (`runEnv`) avec `RUNSTAT_RAW`,
  `RUNSTAT_SNAPSHOT`, `RUNSTAT_SECRETS` ; tous les scripts lisent leurs dossiers par `scripts/paths.mjs`, qui **échoue** si l'une
  manque alors que `users.json` existe (jamais de repli sur les données du propriétaire). Secrets : `readSecret(nom, dossier)` et
  `writeSecret(nom, valeur, dossier)` ; le service passe le dossier du compte (connexion Strava faite dans son processus).
- Droits explicites sur tout ce que le service et la migration créent (dossiers 755, `secrets` 700, JSON 644) : sur le NAS, les ACL
  héritées de DSM ouvrent sinon les nouveaux dossiers et fichiers en écriture à tous (`rwxrwxrwx+`).
- Quota par compte hébergé : `RUNSTAT_USER_QUOTA_MB` (2 Go), 507 au-delà (saisie, archive). Au démarrage, `server.mjs` refuse de
  tourner si `users/` existe sans `users.json` (nouveau YAML monté avant la migration).

### Accès public des proches local-first (Tailscale Funnel, `public-api.mjs`)
Troisième zone : nginx `:82` (`127.0.0.1:8091`, cible de `tailscale funnel --bg --https=8443`) → port 8789, routeur `public-api.mjs`
seul : `/auth/`, `/backup/`, `/relay/` (tailles refusées par nginx avant toute authentification, IP du client = valeur la plus à droite
de `X-Forwarded-For`, posée en `X-Real-IP` par un `map`, pas par `realip` qui passerait avant `allow/deny`). Variables :
`RUNSTAT_APP_URL` (appli publique, liens d'invitation `…/rejoindre#nas=<RUNSTAT_PUBLIC_URL>&code=…`), `RUNSTAT_PUBLIC_URL` (adresse
Funnel), `RUNSTAT_APP_ORIGINS` (CORS et origines WebAuthn ; défaut : origine de l'appli), `RUNSTAT_GOOGLE_REDIRECTS`
(défaut `<appli>connexion/google`), `RUNSTAT_BACKUP_QUOTA_MB` (1 Go). CORS = filtre (403 hors liste) ; la sécurité vient de
l'invitation, de la passkey et du jeton de session (Bearer, sans cookie).
- Comptes `mode: local` (sans login Tailscale, pas d'accès au tableau de bord). « Proches » › « Créer le lien d'invitation »
  (`POST /api/admin/invitations`, compte créé au besoin), « Nouveau lien », « Réinitialiser l'accès » (`POST /api/admin/users/<id>/reset` :
  passkeys, sessions, codes et identifiant WebAuthn révoqués). Retirer un compte local révoque aussi tout et met sa sauvegarde
  en suppression douce (penser à « Enregistrer » dans Proches : retirer la ligne seule n'envoie rien).
- `auth-store.mjs` (`users/auth/`, 700/600, empreintes seulement) : codes d'invitation (7 jours) et liens de connexion (15 min) à
  usage unique ; passkeys ; sessions (30 jours glissants, 180 au plus, 20 par compte). `webauthn.mjs` : CBOR maison, ES256 et RS256
  seulement, UP + UV exigés, `crossOrigin` refusé, rpId = hôte de l'origine, compteur refusé seulement s'il recule (iCloud et Google
  renvoient 0). Le challenge d'enregistrement n'est émis que contre un code valide et lié à lui ; code consommé et passkey enregistrée
  sans `await` entre les deux. Ré-authentification par passkey (5 min) exigée pour un lien de connexion, ajouter ou retirer une
  passkey, supprimer la sauvegarde ; une session ouverte par un lien n'en vaut pas une.
- `backup-store.mjs` (`users/<id>/backup/`) : objets chiffrés immuables nommés par un HMAC (64 hex, 32 Mio au plus), manifestes
  versionnés (`If-Match: "v<n>"` / `If-None-Match: *`, 412 si périmé, 409 si des objets manquent) avec en-tête clair (dérivation,
  clé enveloppée) et blob chiffré ; manifestes et objets gardés 30 jours quel que soit leur nombre (le dernier toujours), ménage toutes
  les 6 h (`gcAllBackups` : aussi les dossiers des comptes retirés, dont la sauvegarde restante passe en suppression douce, purgée
  après 30 jours, dossier effacé une fois vide ; données d'un hébergé retiré gardées) ; `DELETE /backup` = suppression douce (30 jours).
- Relais : `POST /relay/google/token` et `GET /relay/google/client` (identifiant public du client et adresses de retour) seulement (secret du client Google du propriétaire ajouté côté serveur ; `authorization_code`
  avec PKCE et adresse de retour en liste blanche, ou `refresh_token` ; réponse filtrée ; 30 par heure et par compte). Le reste se fait
  depuis le navigateur : COROS (MCP, OAuth, enregistrement dynamique), Strava, Google Health, Open-Meteo et l'hôte des FIT COROS
  (`s3eu.coros.com`) acceptent le CORS. Les jetons Google des proches transitent donc en clair par le NAS à chaque renouvellement.
- Limites : `/auth` 30/min par IP et 300/min au total, sauvegarde 1 200 requêtes / 10 min par compte. Journal : méthode, route type,
  statut, compte ; jamais de corps, jeton, code ni URL relayée.
- Mise en service (avec l'accord du propriétaire) : variables ci-dessus et port `127.0.0.1:8091:82` dans le YAML de Container Manager,
  Nettoyer › Construire ; attribut `funnel` dans la politique du tailnet ; `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8091` ;
  vérifier depuis l'extérieur (4G) que seuls `/auth`, `/backup`, `/relay` répondent (le reste : 404).

### Confidentialité, export, suppression (RGPD)
- Page publique `/confidentialite` (`pages/privacy.ts`, les deux constructions ; liens dans le pied de page, l'accord de `/rejoindre` et
  « Mes données ») : ce qui va où selon le mode, tiers contactés, durées, droits. **À tenir à jour** quand un flux change.
- Export (portabilité) : zip « stocké » du moteur (`src/engine/archive/zip-writer.ts`, `zipStream`, sans zip64 : 4 Gio et 65 535 fichiers
  au plus), `data-raw/` sans `secrets/` ni fichiers techniques (`EXPORT_EXCLUDED`), `snapshot/`, `LISEZMOI.txt`. Hébergé :
  `GET /api/export` (en flux, Réglages › Mes données) ; appareil : `LocalService.exportZip()` (Compte et sauvegarde › Mes données).
- Suppression : proche hébergé, `DELETE /api/account { confirm: <id> }` (tailnet seulement, jamais le propriétaire ; dossier
  `users/<id>/` effacé, compte retiré de `users.json`, accès public révoqué, tâches en attente abandonnées, 409 pendant un run) ;
  local-first, « Tout effacer » : `DELETE /auth/account` (ré-authentification par passkey : sauvegarde en suppression douce 30 jours,
  passkeys, sessions et codes révoqués ; le compte reste listé chez le propriétaire, sans accès), puis zones IndexedDB vidées
  (`IndexedDbStore.clear`). Sans compte : données de l'appareil seulement.

### Migration d'une instance mono-utilisateur (une fois, avec l'accord du propriétaire)
1. `npm run nas -- pull` (copie locale), puis `npm run deploy` (scripts, `deploy/nginx/`, compose).
2. Container Manager : Projet › runstat › Arrêter.
3. Par SSH sur le NAS, à blanc puis pour de bon :
   `sh /volume1/docker/runstat/app/scripts/migrate-users.sh /volume1/docker/runstat --owner <id> --login <login Tailscale> --name <Prénom>`,
   puis la même commande avec `--apply` (et `--chown 1026:100` si lancée en root) : copie dans `migration-<date>/`, déplacement vers
   `users/<id>/`, empreintes comparées, `users.json` écrit en dernier ; idempotente.
4. Projet › runstat › YAML : coller `deploy/docker-compose.yml` avec les vraies valeurs (adresse locale du NAS sur le port 8080,
   `SYNC_PUBLIC_ORIGINS`), puis Nettoyer › Construire.
5. `tailscale serve --bg --https=443 http://127.0.0.1:8090` (au lieu de l'ancien port 8080).
6. Vérifier : tableau de bord par l'adresse ts.net et par le réseau local, `GET /api/me`, 403 pour un login inconnu, `:8090` injoignable
   depuis une autre machine du réseau local. 2e ligne de `data-raw/nas.txt` = identifiant du compte (pour `npm run nas`).
   `migration-<date>/` supprimable après vérification. Retour arrière : arrêter, remettre les dossiers de `migration-<date>/`, ancien YAML.

## Rafraîchissement manuel (secours, par le connecteur Coros de Claude)

Seulement si la synchro du NAS est en panne : `npm run nas -- pull`, la procédure ci-dessous, puis
`npm run nas -- push records.txt details fitness.txt load.txt fit`. Inutile de télécharger tout l'historique FIT :
la file est triée par utilité.

1. Liste complète des courses : `mcp__coros__querySportRecords` avec `startDate: "20100101"`, `endDate` = aujourd'hui,
   `sportTypeCodes: [100, 101, 102, 103]`, `limit: 1000`, filtres numériques à 0 / grandes valeurs, chaînes vides.
   La sortie dépasse la limite et est sauvegardée dans un fichier : le copier tel quel dans `data-raw/records.txt`.
2. `npm run data` → écrit `data-raw/missing-details.txt` (activités sans détail, format `<labelId> <sportType> <date>`).
3. Pour chaque ligne manquante, `mcp__coros__getActivityDetail` puis ajouter une ligne à
   `data-raw/details/part-AAAAMMJJ.jsonl` :
   `{"id":"…","elevGain":25,"elevLoss":20,"cadence":171,"stride":1.04,"power":223,"trainingLoad":93,"aerobicTE":2.6,"anaerobicTE":1.2,"focus":"Base","bestKm":"4:59"}`
   (null si absent). Au-delà d'une cinquantaine, répartir entre sous-agents.
4. `mcp__coros__queryFitnessAssessmentOverview` → texte brut dans `data-raw/fitness.txt`.
   `mcp__coros__queryTrainingLoadAssessment` avec `days: 365` (Coros ne renvoie que ~31 jours) → fusionner dans
   `data-raw/load.txt` par date (`mergeLoad` de `src/engine/parsers/coros.ts`), sans écraser l'historique accumulé.
5. Fichiers FIT (seconde par seconde) : `npm run fit-queue` régénère `data-raw/fit-queue.txt` (courses → sorties
   longues → fractionné/tempo → reste).
   Pour chacune, `mcp__coros__queryActivityFitFileDownloadUrls` avec **uniquement** `labelId` + `sportType`
   (les requêtes par plage de dates déclenchent une protection anti-abus), puis `sh scripts/fetch-fit.sh <URL…>`.
   **Limite Coros : 50 fichiers FIT par jour.** S'arrêter au premier message d'erreur ou de quota.
6. `npm run weather` (météo Open-Meteo, coordonnées arrondies à 0,1°, avec cache) puis `npm run data`
   (analyse des FIT avec cache dans `data-raw/fit-derived/`, puis fusion) : doit annoncer 0 activité sans détail.

Splits au km : calculés depuis les FIT ; pour une course sans FIT, `mcp__coros__queryActivityLapData` (ne compte pas
dans le quota FIT) → tours de 1 km recopiés dans `data-raw/splits/<id>.json` (`{"km": [...], "rest": {...}}`, vérifier
que la somme = durée). Ils servent à détecter le mur (`wallAnalysis`).

Tours au km (durabilité, `src/app/core/durability.ts`) : pour les sorties longues (≥ 75 min, trail ≥ 60 min) sans FIT,
`mcp__coros__queryActivityLapData` (hors quota) → `data-raw/laps/<id>.json` au format
`{"km":[[distance m, temps s, FC, D+, D−, allure ajustée s/km, puissance, cadence],...]}`. Prendre le groupe dont
`lapDistance` = 100000 qui contient vraiment des tours de ~1 km (souvent `type:10` sur route, `type:2` en trail ;
l'autre peut être découpé par étapes de séance). Répartir entre sous-agents, puis `node scripts/check-laps.mjs`
(somme des temps et distance ≈ sortie). Les FIT produisent le même format (« Effort Pace » Coros comme allure ajustée).

Réglages de l'athlète (FC max, FC repos, seuils `lt1Hr`/`lt2Hr`, sexe, poids…) : `data-raw/athlete.json`, modifiable par le bouton
Réglages de l'en-tête. `raceWeights: { "<id>": 0.5 }` force le poids d'une course dans l'exposant de fatigue (0 = ignorée), réglable
sur la course dans Classements. Modifié à la main : `node scripts/build-fit.mjs --force` en local puis `npm run nas -- push athlete.json`.

## Santé & sommeil (Google Health)

Export Google Takeout (« Google Health », ex-Fitbit), laissé dans le dossier de l'utilisateur (≈ 2 Go, données
sensibles) : `npm run health -- "<chemin vers Takeout/Google Health>"` (chemin mémorisé dans `data-raw/health-source.txt`),
puis `npm run data`. Ne lit que FC de repos, VFC, préparation, respiration, température, SpO2, sommeil, poids.
Attention : le nom du dossier contient une espace insécable, et chaque nuit existe en `sleep_session_v1` et `v2`
(on garde la plus récente). Depuis, l'API complète automatiquement (`health-api.json`, voir Synchronisation) ; le Takeout reste
utile pour l'historique et le score de préparation. Affiché dans Forme › Récupération (`src/app/core/health.ts`, `sections/recovery.ts`) et en résumé sur Aujourd'hui.

## Objectifs (onglet Courses, `src/app/core/goals.ts`)

Saisis dans Courses (bouton « Objectif », « Modifier l'objectif ») ou dans `data-raw/goals.json` (non versionné) : `[{ "id", "name", "date": "AAAA-MM-JJ", "startTime": "HH:MM", "distanceKm",
"elevGain"?, "elevLoss"? (D−, absent = D+), "targetSec"? (absent = objectif « finir »), "stretchSec"? (bas d'une fourchette, ex. 10 h 30 pour « 10 h 30 / 11 h »), "kind": "road" | "trail", "lat"?, "lon"? }]`.
`npm run weather` télécharge la prévision des objectifs à moins de 15 jours (lieu indiqué, sinon lieu de sortie habituel)
dans `data-raw/weather/forecast-<id>.json`, puis `npm run data`.
Chrono : consensus géométrique des modèles (Coros, course de référence = dernière course sur la même distance à poids 1,5,
projetée à aujourd'hui par `progressionSince` : volume Tanda × moyenne(allure d'entraînement, ½ gain d'EF), 8 sem. avant / 8 dernières,
VDOT, Riegel pondéré, VDOT actualisé par l'EF, vitesse critique à poids 0,5) × ajustements (fraîcheur projetée, VFC/FC repos, Hadley, nuit, préparation) ; incertitude log-normale →
probabilité. Finir : indice de préparation pondéré ; chrono trail extrapolé au km-effort (Riegel k = 1,10) ; ultra (≥ 60 km-effort) : modèle « allure à FC d'ultra » (`ultraModel` : allure ajustée à la FC LT1 sur les sorties longues, perte de durabilité par heure, 5 % d'arrêts).
Stratégie de course (`src/app/core/race-plan.ts`) : allures par tronçon et temps de passage, allure montre corrigée de
l'écart GPS mesuré sur les courses de référence, cardio, ravitaillement, derniers jours, échauffement, tenue, leçons.
Une course n'est « référence » que si elle est classée `race` (`RACE_NAME` dans `science.ts` : nom d'épreuve ou millésime ;
la sortie d'un objectif passé l'est toujours, quel que soit son nom).

## Coût des conditions (fiche d'une sortie et Aujourd'hui, `src/app/core/conditions.ts`, `ui/conditions-card.ts`)

Façon « rapport Enduraw » : altitude 🗻, dénivelé 🚠, température 🔥, vent 💨 en % (négatif = coût) face à des conditions standard
(plat, niveau de la mer, 12 °C, sans vent) ; temps standard = durée × Π(1 + %). Calculé pour toutes les sorties (hors tapis).
Altitude : Wehrlin & Hallén (−6,3 % VO₂max/1000 m au-dessus de 300 m) × 0,55 (Mexico 1968) moins le gain d'air, `fit.altMean` sinon
`startAlt` (API elevation d'Open-Meteo, `data-raw/weather/elevation.json`). Dénivelé : `gapDistance` Minetti, sinon D+/D− Coros
avec le coefficient de boucle perso. Chaleur : pente perso de l'EF au-delà de 12 °C (≥ 15 sorties), sinon Hadley, selon la durée.
Vent : traînée de Pugh par secteur de cap (`fit.headings`, 16 × [s, m]) avec `weather.dir` ; sans FIT, caps uniformes (« estimé »).
Sortie sans FIT : bouton « Affiner avec le tracé » (`SyncService.refineFit`, quota de 50 FIT/jour). « Copier le rapport » : texte
à coller dans Strava / COROS (aucune écriture externe).

## Archives (Courses › Archives, `src/app/core/debrief.ts`)

Un objectif passe dans Courses › Archives (`sections/goal-archive.ts`, une course par sous-onglet `?course=`) dès que sa sortie est synchronisée (même jour ou lendemain, distance à ±15 %).
Bilan : temps officiel vs objectif et prédiction de la veille, km par km ramenés à la distance officielle face au plan,
allure, cardio (décrochages du capteur exclus), foulée, gels, conditions, modèles, leçons ; puis l'indice de la veille
(`sections/goal-card.ts`, partagé avec les objectifs à venir). Après la course, l'utilisateur saisit temps puce, gels, ressenti
dans Archives (« Temps puce, gels, ressenti ») ; à la main : `"debrief": { "chipSec": 5816, "gelsKm": [7, 14], "notes": ["…"] }` dans l'objectif.

## Algorithmes

`src/app/core/science.ts` (affichés par `sections/analysis.ts`, réparti entre Performance, Forme et Entraînement) : Daniels/VDOT, Riegel (+ exposant perso mesuré sur les
courses), Tanda, Vickers, vitesse critique (Smyth & Muniz-Pumares), indice de forme Runalyze, marathon shape,
TRIMP, Foster, ACWR, classification des séances, EF + anomalies (z-score MAD), Theil-Sen, chaleur (règle de Hadley),
km-effort (ITRA D+/100, plus D−/300 ; D− absent = D+), index de polarisation. `src/engine/fit/analyse.ts` (lancé par `scripts/build-fit.mjs`) : meilleurs efforts, courbe d'allure, GAP (Minetti),
zones, découplage Pa:HR, durabilité, tours au km, TRIMP seconde par seconde, tracé GPS.
Les meilleurs efforts FIT (meilleur passage sur 400 m … marathon dans n'importe quelle sortie) alimentent Performance › Records › Segments (bascule « Ajusté à la pente » : GAP, 16 semaines / tous les FIT)
(`effortIn` dans `insights.ts` : sans FIT, meilleur km Coros ou allure moyenne d'une sortie de la distance à +5 %).
`src/app/core/durability.ts` : perte d'efficacité 1er/dernier tiers, dérive de FC à allure égale, début de dégradation,
montées/descentes en trail, courbe de durabilité heure par heure (sorties régulières seulement).

## Runner Matrix (Performance › Profil, `src/app/core/matrix.ts`, `sections/runner-matrix.ts`)

Inspirée d'Enduraw (méthode non publiée : construction propre). Six branches (Endurance, Montée, Descente, Vitesse,
Résilience, Physiologie), chacune = moyenne de rangs 0-100 de ses métriques par rapport à l'historique de l'athlète
(fenêtres hebdomadaires ; performance = meilleure valeur sur 120 j, état = médiane), radar aujourd'hui / il y a 26 semaines.
Résilience, EF et VO₂max FC corrigées de la chaleur (pente Theil-Sen personnelle, ramenées à 12 °C). Grille durée × terrain
(5 min → 3 h) : `curveGap`, `climb`, `descent` de `analyse()` (`src/engine/fit/analyse.ts`) (D+/D− cumulés avec hystérésis de 1 m, sauts > 1 m/s ignorés) ;
`terrain` = temps, distances et FC par tranche de pente (rendement en côte ≥ 8 %, vitesse ajustée en descente ≤ −8 % face au plat).
Lecture absolue à côté (bascule du radar) : % du niveau mondial, barème du classement par âge (60 % locale … 90 % mondiale),
pour Vitesse et Endurance (loi puissance entre les records du 1 500 m et du marathon, `WORLD_RECORDS` à mettre à jour si un
record tombe) et Physiologie (VO₂max Coros, historique par l'estimation FC recalée, face au VDOT du record du marathon).
Montée, Descente, Résilience : pas d'étalon mondial fiable, volontairement.

## Se situer (Courses › Classements, `src/app/core/ffa.ts`, `sections/race-standing.ts`)

Barème FFA route (athle.fr htmlid=125 hommes / 122 femmes, au 1er janvier 2010, IA → D7, recopié dans `ffa.ts`) : niveau de
chaque course à 5 / 10 / 15 / 20 km, semi, marathon (temps officiel > temps puce du bilan > montre), niveau acquis = 2 perfs
sur 12 mois. Classements : `data-raw/results/<activityId>.json` (ou `date-AAAA-MM-JJ-<km>.json`, rattaché par date et
distance), relevés sur la page de résultats officielle de l'organisateur / du chronométreur, **jamais bases.athle.fr**
(`robots.txt` : `Disallow: /`) ni MyDataRun (compte) ; vérifier le `robots.txt` du site, ne garder que les effectifs
(aucun nom d'autre coureur) : `{ event, course, distanceKm, elevGain?, officialSec, gunSec?, rank, finishers, sex, sexRank,
sexCount, category, catRank, catCount, label?, source, timing?, fetchedAt, note? }`. Saisie par « Saisir » sur la course
(remplace un éventuel `date-….json`, signalé par `result.file`). Après une nouvelle course, à la demande : retrouver la ligne
de l'athlète (son nom, jamais écrit dans le dépôt), écrire le fichier, puis `npm run data`.

## Interface

Six espaces, une question chacun (`TABS` dans `app.routes.ts`, icônes au trait `ui/icon.ts`) :
- **Aujourd'hui** (`pages/today.ts`) : en bref, prochaine course, forme du jour (Google Health + fraîcheur), année en cours, dernières sorties, 3 moments forts.
- **Entraînement** (`pages/training.ts`) : Journal (`pages/activities.ts`, cartes sur téléphone), Volume (`sections/volume.ts` : période, cumul, hebdo, calendrier, régularité),
  Habitudes (`pages/habits.ts`, Quand / Comment / Où), Séances (classification auto + focus Coros).
- **Forme** (`pages/fitness.ts`) : Récupération, Charge (Banister, charge hebdo + monotonie, Seiler, ACWR avec le ratio Coros), Efficacité (EF, tendances mensuelles, chaleur).
- **Performance** (`pages/performance.ts`) : Records (`pages/records.ts` : Sorties / Segments / Par année), Potentiel (prédictions, vitesse critique, courbe d'allure),
  Durabilité, Profil (Runner Matrix).
- **Courses** (`pages/goals.ts`) : un sous-onglet par objectif, Archives, Classements.
- **Souvenirs** (`pages/memories.ts`) : Récap, Badges, Jalons, Équivalences. Sur téléphone, accessible par l'étoile et la pastille de niveau de l'en-tête.

Les analyses scientifiques sont dans `sections/analysis.ts` (`<app-analysis view="predictions | matrice | efficacite | durabilite | charge | seances">`),
chaque vue ouvre sur un « En bref » (`ui/brief.ts`). Les anciennes adresses (`/labo`, `/records?section=…`, `/apercu`…) sont redirigées (`LEGACY` dans `app.routes.ts`).

Sous-onglets avec `ui/subtabs.ts` (`<app-subtabs #st [tabs]="…" />` puis `@switch (st.current())`) : onglets soulignés (`?section=`), ou bascule
`variant="segment"` pour un second niveau (`param="onglet"` ou `course`) ; ces paramètres sont retirés quand on change d'espace (`TAB_PARAMS`).
Ne jamais lire `#st` avant sa déclaration dans le gabarit. Trois contrôles, trois apparences : onglets soulignés (navigation), `.seg` (bascule de vue, période),
`.chip` (filtres). Explications méthodologiques repliées dans `<details class="method"><summary>Méthode</summary>…</details>`.

Thème sombre par défaut, clair au choix (bouton de l'en-tête, `core/theme.service.ts`, `data-theme` sur `<html>`). Toutes les couleurs sont des variables CSS
(`styles.scss`) ; dans les graphiques Chart.js et les cartes Leaflet, utiliser les jetons de `ui/palette.ts` (`C.s1`, `alpha(C.accent, 0.3)`…), résolus au dessin
(`resolveColors` dans `ui/chart.ts`), jamais de couleur hexadécimale en dur. Interface en tutoiement.

Appli installable (PWA) : `@angular/service-worker` (`ngsw-config.json` : coquille en cache, `data/` en `freshness` 4 s puis cache,
`/api/` jamais), `public/manifest.webmanifest`, icônes `public/icons/` (tracé de `ui/icon.ts` sur fond sombre, `favicon.svg`),
polices auto-hébergées (`@fontsource`, `angular.json`), bandeaux « Nouvelle version » et « Hors ligne » (`core/pwa.service.ts`).
Le service worker n'est actif qu'en HTTPS (adresse Tailscale Serve) ou sur localhost, et seulement en build de production.

## Auto-hébergement (`deploy/Dockerfile`, `deploy/compose.selfhost.yml`, `docs/auto-hebergement.md`)

Images `ghcr.io/benji-zoy/runstat-web` (nginx + site du NAS + `deploy/nginx/`) et `runstat-sync` (scripts + moteur + `fit-file-parser`,
même assemblage que `scripts/deploy.sh`), cibles `web` et `sync` d'un seul Dockerfile, publiées pour amd64 et arm64 par
`.github/workflows/images.yml` à chaque étiquette `v*` (tests d'abord, actions épinglées par SHA). Aucune donnée dans les images
(`.dockerignore` : data-raw, secrets, users, public/data). `compose.selfhost.yml` : mêmes zones et ports que le NAS, volume `./users`
(créer `users/users.json` avec le propriétaire avant le premier démarrage). Pas de Docker sur le poste : images non construites en
local, assemblage du service vérifié à la main (dossier temporaire, `server.mjs` démarré, `/api/me` et `/api/export`).

## Déploiement (NAS Synology)

Projet Container Manager dans `/docker/runstat` (`deploy/docker-compose.yml`) : `runstat` (nginx, ports 8080 réseau local et
127.0.0.1:8090 Tailscale Serve, dossier `deploy/nginx/` monté sur `conf.d` : `default.conf` (un bloc par zone, voir Comptes), `site.inc`
(fallback vers `index.html` pour les routes Angular, `index.html`, `ngsw-worker.js`, `ngsw.json` et le manifeste en no-cache, `/data/` et
`/api/` vers runstat-sync, `/api/strava/archive` sans tampon jusqu'à 2 Go), `proxy.inc` (en-têtes relayés, dans chaque location)) et
`runstat-sync` (node:24-alpine, uid 1026:100, volume `./users`, voir Synchronisation et Comptes). `npm run deploy` (`scripts/deploy.sh`) : `ng build`, puis rsync de la config, de
`dist/runstat/browser/` vers `<destination>/html/` (**sauf `data/`**, produit sur le NAS) et des scripts + `fit-file-parser`
vers `<destination>/app/` (relus à chaque synchro, sans redémarrage). Destination dans `data-raw/nas.txt` (SSH
`user@nas:/volume1/docker/runstat` ou partage monté `/Volumes/docker/runstat`). Mise en place initiale : `npm run nas -- init`
(copie `data-raw/`, les données du site et `secrets/`, refuse si le NAS a déjà des données), puis recréer le projet dans
Container Manager, puis la migration vers les comptes (voir Comptes). `server.mjs`, `app.mjs` ou `deploy/nginx/` modifié : Projet › runstat › Arrêter puis Construire. `docker-compose.yml` modifié :
Container Manager garde **sa propre copie du YAML** (celle copiée par le déploiement est ignorée) → recopier le changement dans
Projet › runstat › YAML, puis Arrêter › Nettoyer › Construire (un simple Construire redémarre sans recréer : nouvelles variables
d'environnement ignorées ; vérifier `stravaOrigin` dans `GET /api/sync`). Accès hors du réseau
local via Tailscale uniquement : données personnelles, ne pas ouvrir de port.

## Vérifier

- `npx ng test --watch=false` (tests de `src/app/core` et du moteur `src/engine`)
- `npm run check:engine` (syntaxe compatible avec le type stripping de Node)
- `npx ng build` (et `npx ng build -c pages` pour l'appli publique)
- `npm run test:sync` (synchro, `node:test`)
