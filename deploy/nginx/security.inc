# En-têtes de sécurité du site (zones lan et tailnet), inclus par site.inc au niveau server ET dans chaque location qui a
# ses propres add_header : nginx n'hérite des add_header du niveau supérieur que si la location n'en définit aucun.
# Pas de CSP complète ici (script de thème en ligne, tuiles OpenStreetMap) : seulement l'interdiction d'être encadré.
# Nom en .inc, pas .conf : le dossier est monté sur conf.d, dont nginx charge tous les *.conf au niveau http.
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "frame-ancestors 'none'" always;
