#!/bin/sh
# Construit le site et le copie sur le NAS (conteneurs nginx et runstat-sync, voir deploy/).
# Destination dans data-raw/nas.txt : `utilisateur@nas:/volume1/docker/runstat` (SSH)
# ou `/Volumes/docker/runstat` (partage SMB monté).
# Les données (html/data, data-raw, secrets) vivent sur le NAS : jamais écrasées ici (voir scripts/nas-data.sh).
cd "$(dirname "$0")/.." || exit 1

dest=$(head -n 1 data-raw/nas.txt 2>/dev/null | tr -d '[:space:]')
if [ -z "$dest" ]; then
  echo "Indique la destination dans data-raw/nas.txt, par exemple :" >&2
  echo "  echo 'utilisateur@nas.local:/volume1/docker/runstat' > data-raw/nas.txt" >&2
  exit 1
fi

npx ng build || exit 1
site=dist/runstat/browser

# Worker de synchro : scripts + fit-file-parser et ses dépendances (JavaScript pur)
app=dist/sync-app
rm -rf "$app" && mkdir -p "$app/node_modules" || exit 1
cp -R scripts package.json "$app/" || exit 1
find "$app/scripts" -name '*.test.mjs' -delete
rm -rf "$app/scripts/sync/fixtures"
# Moteur (src/engine, TypeScript lu par Node) : le conteneur ne monte que scripts/, node_modules/ et package.json,
# donc il va dans scripts/engine et l'alias #engine/* de package.json est réécrit en conséquence
cp -R src/engine "$app/scripts/engine" || exit 1
find "$app/scripts/engine" -name '*.spec.ts' -delete
rm -rf "$app/scripts/engine/testing" "$app/scripts/engine/tsconfig.json"
node -e '
  const f = process.argv[1], p = JSON.parse(require("fs").readFileSync(f, "utf8"));
  p.imports = { "#engine/*": "./scripts/engine/*" };
  require("fs").writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
' "$app/package.json" || exit 1
for pkg in fit-file-parser buffer base64-js ieee754; do
  cp -R "node_modules/$pkg" "$app/node_modules/" || exit 1
done

# Une seule connexion SSH (un seul mot de passe) pour toutes les copies.
ssh_opts="ssh -o ControlMaster=auto -o ControlPath=/tmp/runstat-deploy-%r@%h -o ControlPersist=60"
sync="rsync -rltp --chmod=a+rX --exclude=.DS_Store"

$sync -e "$ssh_opts" deploy/docker-compose.yml deploy/nginx.conf "$dest/" || exit 1
$sync -e "$ssh_opts" --delete --exclude=/data/ "$site/" "$dest/html/" || exit 1
$sync -e "$ssh_opts" --delete "$app/" "$dest/app/" || exit 1
echo "Déployé dans $dest (site : $(du -sh "$site" | cut -f1))."
