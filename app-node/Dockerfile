FROM node:20-bookworm-slim

# Linux (x86_64) path: prebuilt native addons usually work, so minimal packages are enough.
# RUN apt-get update \
#   && apt-get install -y --no-install-recommends git ca-certificates \
#   && rm -rf /var/lib/apt/lists/*
# macOS/Apple Silicon -> Minikube linux/arm64 path: include toolchain for native addon builds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ cmake \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only copy manifests needed to resolve this workspace and its file: dependency (wrk-base)
COPY package.json ./
COPY wrk-base/package.json ./wrk-base/
COPY app-node/package.json ./app-node/

# Linux (x86_64) path: uses prebuilt native addons when available.
# RUN npm install --omit=dev --workspace wrk-base --workspace app-node
# macOS/Apple Silicon -> Minikube linux/arm64 path: force native build from source.
RUN npm_config_build_from_source=true npm install --omit=dev --workspace wrk-base --workspace app-node \
  && npm rebuild rocksdb-native --build-from-source \
  && node -e "const fs=require('fs');const p='/app/node_modules/svc-facs-httpd/index.js';let s=fs.readFileSync(p,'utf8');const from='port: this.opts.port || this.conf.port';const to='port: this.opts.port || this.conf.port,\\n      host: this.opts.host || this.conf.host || \\\"0.0.0.0\\\"';if(!s.includes(from)) throw new Error('listen signature not found');fs.writeFileSync(p,s.replace(from,to));"

COPY wrk-base ./wrk-base
COPY app-node ./app-node

WORKDIR /app/app-node
RUN chmod +x setup-configs.sh && ./setup-configs.sh

EXPOSE 3000
CMD ["node", "worker.js"]
