# En-têtes transmis à runstat-sync, dans CHAQUE location relayée (nginx n'hérite des proxy_set_header du niveau server
# que si la location n'en définit aucun : on ne s'y fie pas). L'identité vient de $ts_login, posé par le bloc server :
# le login de Tailscale Serve sur le port tailnet, une chaîne vide ailleurs (en-tête du client écrasé).
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $public_host;
proxy_set_header X-Forwarded-Proto $public_proto;
proxy_set_header Tailscale-User-Login $ts_login;
proxy_set_header Tailscale-User-Name "";
proxy_set_header Tailscale-User-Profile-Pic "";
