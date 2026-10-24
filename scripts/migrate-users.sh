#!/bin/sh
# Passage d'une instance mono-utilisateur aux comptes (voir CLAUDE.md, « Comptes et migration ») : le propriétaire devient
# le premier compte. À lancer sur le NAS (SSH), projet Container Manager ARRÊTÉ, dans le dossier du projet :
#   sh app/scripts/migrate-users.sh /volume1/docker/runstat --owner <id> --login <login Tailscale> [--name <nom>]
#      [--chown 1026:100] [--apply]
# Sans --apply : à blanc (plan seulement). Avec --apply :
#   1. copie de sauvegarde dans migration-<date>/ (hors de tout volume monté) ;
#   2. data-raw/ → users/<id>/data-raw, html/data/ → users/<id>/snapshot, secrets/ → users/<id>/secrets ;
#   3. empreintes (cksum) avant/après comparées ; users.json écrit en dernier ; droits des secrets 700/600.
# Idempotent : ne fait rien si users/users.json existe déjà ; refuse si users/<id> existe.
set -eu

die() { echo "Erreur : $*" >&2; exit 1; }

dest=${1:-}
[ -n "$dest" ] && [ -d "$dest" ] || die "dossier du projet attendu en premier argument"
shift
owner='' login='' name='' owner_chown='' apply=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner=${2:-}; shift 2 ;;
    --login) login=${2:-}; shift 2 ;;
    --name) name=${2:-}; shift 2 ;;
    --chown) owner_chown=${2:-}; shift 2 ;;
    --apply) apply=1; shift ;;
    *) die "option inconnue : $1" ;;
  esac
done

# Mêmes règles que scripts/sync/accounts.mjs (aucun guillemet ni barre oblique inverse : users.json écrit tel quel)
echo "$owner" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' || die "--owner : minuscules, chiffres et tirets (ex. alex)"
case "$owner" in auth|backup|users|tmp) die "--owner : identifiant réservé" ;; esac
echo "$login" | grep -Eq '^[^[:space:]@,"<>\\'"'"']{1,64}@[^[:space:]@,"<>\\'"'"']{1,253}$' || die "--login : login Tailscale (adresse du compte)"
login=$(echo "$login" | tr 'A-Z' 'a-z')
[ -n "$name" ] || name=$owner
echo "$name" | grep -Eq '^[^"\\]{1,60}$' || die "--name : 60 caractères au plus, sans guillemet"
[ -z "$owner_chown" ] || echo "$owner_chown" | grep -Eq '^[0-9]+:[0-9]+$' || die "--chown : uid:gid numériques"

cd "$dest"
if [ -f users/users.json ]; then
  echo "Déjà migré (users/users.json existe) : rien à faire."
  exit 0
fi
[ -d data-raw ] || die "data-raw/ introuvable dans $dest"
[ ! -e "users/$owner" ] || die "users/$owner existe déjà : rien n'est déplacé"

# Empreintes des fichiers d'un dossier (chemins relatifs, triées)
fingerprint() { if [ -d "$1" ]; then (cd "$1" && find . -type f -exec cksum {} + | sort); fi; }
count() { if [ -d "$1" ]; then find "$1" -type f | wc -l | tr -d ' '; else echo 0; fi; }

echo "Projet : $dest"
echo "Compte propriétaire : $owner ($name), login $login"
for pair in "data-raw:data-raw" "html/data:snapshot" "secrets:secrets"; do
  src=${pair%%:*}
  echo "  $src/ ($(count "$src") fichiers) → users/$owner/${pair#*:}/"
done
if [ "$apply" -ne 1 ]; then
  echo "À blanc : relance avec --apply (projet arrêté) pour migrer."
  exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
backup="migration-$stamp"
# Droits explicites partout : sur le NAS, les ACL héritées de DSM ouvrent les nouveaux dossiers à tous (rwxrwxrwx+)
mkdir "$backup"
chmod 700 "$backup"
for src in data-raw html/data secrets; do
  if [ -d "$src" ]; then cp -Rp "$src" "$backup/$(echo "$src" | tr / -)"; fi
done
echo "Sauvegarde : $dest/$backup"

before_raw=$(fingerprint data-raw)
before_snap=$(fingerprint html/data)
before_sec=$(fingerprint secrets)

mkdir -p "users/$owner"
chmod 755 users "users/$owner"
mv data-raw "users/$owner/data-raw"
if [ -d html/data ]; then mv html/data "users/$owner/snapshot"; else mkdir "users/$owner/snapshot" && chmod 755 "users/$owner/snapshot"; fi
if [ -d secrets ]; then mv secrets "users/$owner/secrets"; else mkdir "users/$owner/secrets"; fi

[ "$before_raw" = "$(fingerprint "users/$owner/data-raw")" ] &&
  [ "$before_snap" = "$(fingerprint "users/$owner/snapshot")" ] &&
  [ "$before_sec" = "$(fingerprint "users/$owner/secrets")" ] ||
  die "empreintes différentes après déplacement : restaure depuis $backup/ avant toute autre action"

chmod 700 "users/$owner/secrets"
find "users/$owner/secrets" -type f -exec chmod 600 {} +
printf '[\n  {\n    "id": "%s",\n    "name": "%s",\n    "role": "owner",\n    "mode": "hosted",\n    "logins": ["%s"]\n  }\n]\n' \
  "$owner" "$name" "$login" > users/users.json.tmp
chmod 644 users/users.json.tmp
mv users/users.json.tmp users/users.json
[ -z "$owner_chown" ] || chown -R "$owner_chown" users
echo "Migré : users/$owner/ ($(count "users/$owner") fichiers), users/users.json."
echo "Ensuite : nouveau YAML dans Container Manager, puis Nettoyer › Construire. $backup/ peut être supprimé après vérification."
