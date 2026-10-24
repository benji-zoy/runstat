#!/bin/sh
# Télécharge dans data-raw/fit/ les URL FIT renvoyées par le connecteur Coros
# (queryActivityFitFileDownloadUrls). Usage : sh scripts/fetch-fit.sh URL [URL…]
cd "$(dirname "$0")/.." || exit 1
mkdir -p data-raw/fit
for url in "$@"; do
  name=$(basename "$url")
  if [ -s "data-raw/fit/$name" ]; then
    echo "déjà présent : $name"
  elif curl -sf -o "data-raw/fit/$name" "$url"; then
    echo "ok : $name ($(wc -c < "data-raw/fit/$name" | tr -d ' ') octets)"
  else
    rm -f "data-raw/fit/$name"
    echo "ÉCHEC : $name" >&2
  fi
done
