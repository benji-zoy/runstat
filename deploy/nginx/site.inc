# Fichiers du site (build Angular dans ./html), communs aux deux blocs server de default.conf.
root /usr/share/nginx/html;

gzip on;
gzip_proxied any;
gzip_types application/json application/javascript text/css image/svg+xml;

# Appli installable : le service worker et son manifeste ne sont pas hachés, toujours revalidés
# (sinon la règle de cache long ci-dessous figerait l'appli un an). Les locations exactes passent avant les regex.
location = /ngsw-worker.js {
  add_header Cache-Control "no-cache";
}
location = /safety-worker.js {
  add_header Cache-Control "no-cache";
}
location = /ngsw.json {
  add_header Cache-Control "no-cache";
}
location = /manifest.webmanifest {
  default_type application/manifest+json;
  add_header Cache-Control "no-cache";
}

# Icônes (noms fixes) : une semaine.
location ^~ /icons/ {
  expires 7d;
}
location = /favicon.svg {
  expires 7d;
}

# Fichiers à nom haché par le build : cache long.
location ~* \.(js|css|woff2?|png|svg)$ {
  expires 1y;
}

# Page d'entrée : toujours revalidée après un déploiement.
location = /index.html {
  add_header Cache-Control "no-cache";
}

# Instantané du compte de la requête (coros.json, routes.json) : servi par runstat-sync (/api/data/), jamais en statique.
location ~ ^/data/(coros\.json|routes\.json)$ {
  resolver 127.0.0.11 valid=30s;
  proxy_pass http://runstat-sync:$sync_port/api/data/$1;
  include /etc/nginx/conf.d/proxy.inc;
}
location /data/ {
  return 404;
}

# API du site : service runstat-sync du projet, jamais publié lui-même.
# Résolu à chaque requête (DNS Docker) pour que nginx démarre même si runstat-sync est arrêté.
location /api/ {
  resolver 127.0.0.11 valid=30s;
  proxy_pass http://runstat-sync:$sync_port;
  include /etc/nginx/conf.d/proxy.inc;
  proxy_read_timeout 15s;
}

# Archive Strava envoyée depuis Réglages (souvent plusieurs centaines de Mo) : transmise en flux à runstat-sync,
# qui l'écrit sur le disque (sans tampon nginx, délais longs).
location = /api/strava/archive {
  resolver 127.0.0.11 valid=30s;
  proxy_pass http://runstat-sync:$sync_port;
  include /etc/nginx/conf.d/proxy.inc;
  client_max_body_size 2g;
  proxy_request_buffering off;
  proxy_send_timeout 600s;
  proxy_read_timeout 600s;
}

# Routes Angular (/forme?section=…) : renvoyer index.html.
location / {
  try_files $uri $uri/ /index.html;
}
