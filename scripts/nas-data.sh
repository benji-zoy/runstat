#!/bin/sh
# Données sur le NAS : depuis la synchro automatique (runstat-sync), le NAS fait foi.
#   npm run nas -- init              migration initiale (une seule fois) : data-raw/, données du site et secrets/
#   npm run nas -- pull              NAS → poste : data-raw/ et public/data/, pour développer
#   npm run nas -- push <chemins…>   poste → NAS : fichiers saisis à la main, relatifs à data-raw/
#                                    (goals.json, athlete.json, results…), pris en compte au run suivant
# Destination dans data-raw/nas.txt (comme scripts/deploy.sh). Instance à comptes (users/users.json sur le NAS) :
# identifiant de ton compte en deuxième ligne de data-raw/nas.txt (données dans users/<id>/data-raw et snapshot).
cd "$(dirname "$0")/.." || exit 1

dest=$(head -n 1 data-raw/nas.txt 2>/dev/null | tr -d '[:space:]')
[ -n "$dest" ] || { echo "Destination absente : data-raw/nas.txt" >&2; exit 1; }
ssh_opts="ssh -o ControlMaster=auto -o ControlPath=/tmp/runstat-nas-%r@%h -o ControlPersist=60"
sync="rsync -rltp --exclude=.DS_Store --exclude=.sync.lock"

# Test d'existence sur le NAS (SSH « hôte:chemin » ou partage monté)
remote_exists() {
  case "$dest" in
    *:*) ssh -o ControlMaster=auto -o ControlPath=/tmp/runstat-nas-%r@%h -o ControlPersist=60 \
           "${dest%%:*}" test -e "'${dest#*:}/$1'" ;;
    *) test -e "$dest/$1" ;;
  esac
}

# Dossiers du NAS : instance à comptes, ou disposition historique
user=$(sed -n 2p data-raw/nas.txt 2>/dev/null | tr -d '[:space:]')
if remote_exists users/users.json; then
  echo "$user" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' ||
    { echo "Instance à comptes : indique ton identifiant en 2e ligne de data-raw/nas.txt" >&2; exit 1; }
  nas_raw="users/$user/data-raw" nas_snap="users/$user/snapshot" accounts=1
else
  nas_raw=data-raw nas_snap=html/data accounts=0
fi

case "$1" in
  init)
    [ "$accounts" -eq 0 ] || { echo "Le NAS a déjà des comptes : rien n'est écrasé. Utilise « pull »." >&2; exit 1; }
    if remote_exists data-raw/records.txt; then
      echo "Le NAS a déjà des données (data-raw/records.txt) : rien n'est écrasé. Utilise « pull »." >&2
      exit 1
    fi
    [ -s secrets/coros-tokens.json ] && [ -s secrets/google-tokens.json ] ||
      { echo "Autorise d'abord les deux sources : npm run auth -- coros / google" >&2; exit 1; }
    $sync -e "$ssh_opts" --exclude=/nas.txt --exclude=/health-source.txt data-raw/ "$dest/data-raw/" || exit 1
    $sync -e "$ssh_opts" public/data/ "$dest/html/data/" || exit 1
    # Droits conservés (-p) : dossier 700, fichiers 600
    chmod 700 secrets && chmod 600 secrets/*.json
    $sync -e "$ssh_opts" secrets/ "$dest/secrets/" || exit 1
    # Le refresh token COROS change à chaque renouvellement : un seul détenteur, sinon l'autre est révoqué.
    rm -f secrets/coros-tokens.json
    echo "Données et secrets copiés sur le NAS. Le token COROS du poste est supprimé (le NAS en est le seul détenteur)."
    ;;
  pull)
    $sync -e "$ssh_opts" --exclude=/nas.txt "$dest/$nas_raw/" data-raw/ || exit 1
    $sync -e "$ssh_opts" "$dest/$nas_snap/" public/data/ || exit 1
    echo "Données du NAS récupérées dans data-raw/ et public/data/."
    ;;
  push)
    shift
    [ $# -gt 0 ] || { echo "Usage : npm run nas -- push goals.json athlete.json results" >&2; exit 1; }
    for p in "$@"; do
      if [ -d "data-raw/$p" ]; then
        $sync -e "$ssh_opts" "data-raw/$p/" "$dest/$nas_raw/$p/" || exit 1
      else
        $sync -e "$ssh_opts" "data-raw/$p" "$dest/$nas_raw/$p" || exit 1
      fi
      echo "envoyé : $p"
    done
    ;;
  *)
    echo "Usage : npm run nas -- init | pull | push <chemins…>" >&2
    exit 1
    ;;
esac
