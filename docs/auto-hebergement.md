# Héberger RunStat chez toi

RunStat tourne sur n'importe quel serveur Docker à la maison : NAS Synology, mini-PC, Raspberry Pi 4 ou 5 (images amd64 et arm64).
Il n'y a pas de serveur central. Tes données et celles des proches que tu héberges restent chez toi, et on y accède de l'extérieur
**par Tailscale seulement** : aucun port n'est ouvert sur ta box.

Deux conteneurs :

- `runstat` (nginx) sert le tableau de bord et relaie l'API. Ses trois ports correspondent à trois zones de confiance :
  - réseau local : ton compte seulement ;
  - Tailscale Serve : les comptes hébergés, reconnus par leur login Tailscale ;
  - Tailscale Funnel : pour les proches local-first, seulement l'authentification, la sauvegarde chiffrée et le relais Google.
- `runstat-sync` (Node) synchronise les comptes hébergés toutes les 3 h (COROS, Strava, Google Health) et répond à l'API.

## 1. Préparer le dossier

```sh
mkdir -p runstat/users && cd runstat
curl -fsSLO https://raw.githubusercontent.com/benji-zoy/runstat/main/deploy/compose.selfhost.yml
```

Crée le compte du propriétaire, c'est-à-dire toi, dans `users/users.json`. Mets ton login Tailscale dans `logins` :

```json
[{ "id": "moi", "name": "Prénom", "role": "owner", "mode": "hosted", "logins": ["toi@example.com"] }]
```

Le service refuse de démarrer si `users/` existe sans `users.json`.

Donne le dossier à l'utilisateur qui fera tourner le service : `sudo chown -R "$(id -u):$(id -g)" users`.

## 2. Régler `compose.selfhost.yml`

Remplace les valeurs entre `<…>` :

- `<adresse locale du serveur>` : par exemple `192.168.1.20`. Jamais `0.0.0.0` : ce port sert ton compte sans authentification et ne
  doit pas être joignable par l'adresse Tailscale du serveur, que voient les proches avec qui tu le partages.
- `<uid>:<gid>` : le propriétaire de `users/` (`id -u`, `id -g`).
- `<machine>.<tailnet>.ts.net` : le nom Tailscale du serveur (console Tailscale › Machines).

Puis lance `docker compose -f compose.selfhost.yml up -d`.

## 3. Tailscale

Sur le serveur, avec Tailscale installé et connecté :

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8090
```

Le tableau de bord est alors à `https://<machine>.<tailnet>.ts.net/`. Vérifie que `http://<adresse locale>:8090` n'est **pas** joignable
depuis une autre machine du réseau local.

## 4. Connecter tes sources

Ouvre Réglages par l'adresse ts.net. Choisis tes sources, puis « Connecter COROS », « Connecter Strava » ou « Connecter Google » :

- **COROS** : rien à préparer, RunStat s'enregistre tout seul auprès de COROS.
- **Strava** : chacun crée sa propre appli sur strava.com/settings/api (abonnement Strava requis), avec comme domaine de rappel
  l'hôte ts.net. Le guide est dans Réglages.
- **Google Health** : crée un client OAuth « Application Web » dans la console Google Cloud, avec les adresses de retour
  `https://<machine>.<tailnet>.ts.net/api/google/callback` et, pour les proches local-first,
  `https://benji-zoy.github.io/runstat/connexion/google`. Dépose son JSON dans `users/moi/secrets/google-client.json` (droits 600). En mode
  « test », ajoute chaque personne comme testeur ; les jetons y durent 7 jours.

## 5. Inviter des proches

Réglages › « Proches » (par l'adresse ts.net, propriétaire seulement).

- **Hébergé** : tu ajoutes son login Tailscale, puis tu partages la machine avec lui dans la console Tailscale (Machines › Partager).
  Ses données sont en clair dans `users/<id>/` : tu peux les lire.
- **Local-first** (recommandé) : « Créer le lien d'invitation ». Ses données restent sur son appareil, dans l'appli publique ; ton
  serveur ne garde qu'une sauvegarde chiffrée qu'il ne peut pas lire. Il faut ouvrir Funnel :
  1. Console Tailscale › Access controls : donne l'attribut `funnel` à ta machine.
  2. `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8091`.
  3. Vérifie depuis l'extérieur, en 4G : seules les adresses `/auth/`, `/backup/` et `/relay/` répondent, tout le reste renvoie 404.

  L'appli publique `benji-zoy.github.io/runstat` ne connaît pas ton serveur : à l'ouverture du lien, la personne voit d'abord un écran
  « Serveur inconnu » qui affiche ton adresse. Pour l'éviter, publie ta propre copie de l'appli (fork du dépôt, GitHub Pages, variable
  `RUNSTAT_NAS_ORIGINS`), puis mets son adresse dans `RUNSTAT_APP_URL`.

## Mises à jour et sauvegardes

- `docker compose -f compose.selfhost.yml pull && docker compose -f compose.selfhost.yml up -d`. Les images portent aussi un numéro
  de version (`:1.2.0`) si tu préfères choisir le moment.
- Sauvegarde le dossier `users/` : il contient tout (comptes, données, jetons, sauvegardes chiffrées des proches). Garde cette copie
  aussi à l'abri que l'original.

## Confidentialité

En hébergeant des proches, tu es responsable de leurs données sur ton serveur : la page « Confidentialité » de l'appli décrit ce qui
va où.

- Chacun peut exporter ses données ou supprimer son compte depuis l'appli.
- Les journaux du service ne contiennent ni contenu, ni jeton.
- Une sauvegarde chiffrée supprimée reste récupérable 30 jours (`users/<id>/backup-supprimee-*`), puis elle est purgée.
