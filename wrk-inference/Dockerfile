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
COPY wrk-inference/package.json ./wrk-inference/

# Linux (x86_64) path: uses prebuilt native addons when available.
# RUN npm install --omit=dev --workspace wrk-base --workspace wrk-inference
# macOS/Apple Silicon -> Minikube linux/arm64 path: force native build from source.
RUN npm_config_build_from_source=true npm install --omit=dev --workspace wrk-base --workspace wrk-inference \
  && npm rebuild rocksdb-native --build-from-source

COPY wrk-base ./wrk-base
COPY wrk-inference ./wrk-inference

WORKDIR /app/wrk-inference
RUN chmod +x setup-configs.sh && ./setup-configs.sh

CMD ["node", "worker.js"]
