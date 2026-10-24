# Images d'auto-hébergement (docs/auto-hebergement.md), publiées sur ghcr.io par .github/workflows/images.yml :
#   docker build -f deploy/Dockerfile --target web  -t runstat-web  .   → nginx + site du NAS + configuration (deploy/nginx/)
#   docker build -f deploy/Dockerfile --target sync -t runstat-sync .   → service de synchro (scripts/sync/server.mjs)
# Aucune donnée dans les images : les comptes vivent dans le volume /app/users.

FROM node:24.14-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Site du NAS, puis service : scripts + moteur (TypeScript lu par Node) + fit-file-parser et ses dépendances, comme scripts/deploy.sh
RUN npx ng build \
  && rm -rf dist/runstat/browser/data \
  && mkdir -p /app/node_modules \
  && cp -R scripts package.json /app/ \
  && find /app/scripts -name '*.test.mjs' -delete \
  && rm -rf /app/scripts/sync/fixtures \
  && cp -R src/engine /app/scripts/engine \
  && find /app/scripts/engine -name '*.spec.ts' -delete \
  && rm -rf /app/scripts/engine/testing /app/scripts/engine/tsconfig.json \
  && node -e 'const f="/app/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f,"utf8"));p.imports={"#engine/*":"./scripts/engine/*"};fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' \
  && for pkg in fit-file-parser buffer base64-js ieee754; do cp -R "node_modules/$pkg" /app/node_modules/; done

FROM nginx:1.29-alpine AS web
COPY --from=build /src/dist/runstat/browser /usr/share/nginx/html
# Remplace le default.conf de l'image nginx : un bloc server par zone de confiance (deploy/nginx/default.conf)
COPY deploy/nginx/ /etc/nginx/conf.d/

FROM node:24.14-alpine AS sync
ENV NODE_ENV=production TZ=Europe/Paris RUNSTAT_USERS=/app/users
WORKDIR /app
COPY --from=build /app /app
USER node
VOLUME /app/users
CMD ["node", "scripts/sync/server.mjs"]
