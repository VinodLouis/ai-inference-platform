# AI Inference Platform

A decentralised, microservice-based AI inference platform built on [Hyperswarm RPC](https://www.npmjs.com/package/hyperswarm). Instead of relying on a central broker, services discover each other through a DHT-backed registry, making the platform naturally resilient to node failures and easy to scale horizontally.

This platform focuses on text generation with a **two-provider runtime model**: local GGUF inference via `llama-cpp` and remote inference via `ollama`, with dynamic model registration at runtime.

---

## Repository layout

```
ai-inference-platform/
├── wrk-base/          # Shared base worker (inherited by all services)
├── wrk-ork/           # Orchestrator – service registry + request routing
├── wrk-inference/     # Inference Worker – job queue + model execution
├── wrk-model/         # Model Worker – LLM management + text generation
└── app-node/          # HTTP Gateway – REST ↔ RPC bridge for clients
```

---

## Requirements

| Dependency | Version |
| ---------- | ------- |
| Node.js    | ≥ 18.x  |
| npm        | ≥ 9.x   |

No other tooling needed. All Hyperswarm/Hyperbee primitives are installed via npm.

---

## Quick-start

Each service runs in its own terminal. Follow these steps in order.

### 1 — Install dependencies

From the root:

```sh
npm install
```

Or install each package individually:

```sh
cd wrk-base    && npm install && cd ..
cd wrk-ork     && npm install && cd ..
cd wrk-inference && npm install && cd ..
cd wrk-model   && npm install && cd ..
cd app-node    && npm install && cd ..
```

### 2 — Setup config files

Each package has a `setup-configs.sh` script. Run it in each directory:

```sh
cd wrk-base && ./setup-configs.sh && cd ..
cd wrk-ork && ./setup-configs.sh && cd ..
cd wrk-inference && ./setup-configs.sh && cd ..
cd wrk-model && ./setup-configs.sh && cd ..
cd app-node && ./setup-configs.sh && cd ..
```

This copies all `.example` files to their actual config files.

### 3 — Configure the Model Worker

Edit `wrk-model/config/common.json` to configure providers and the default autoload ***REMOVED***

```json
{
  "debug": 0,
  "runtime": {
    "providers": [
      {
        "type": "llama-cpp",
        "enabled": true,
        "settings": {
          "modelBaseDir": "./models",
          "modelCacheDir": "./models/.cache"
        }
      },
      {
        "type": "ollama",
        "enabled": true,
        "endpoint": "http://localhost:11434"
      }
    ]
  },
  "models": [
    {
      "id": "tinyllama-1.1b",
      "name": "TinyLlama 1.1B Chat",
      "provider": "llama-cpp",
      "type": "text-generation",
      "format": "gguf",
      "quantization": "Q4_K_M",
      "path": "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "source": {
        "type": "huggingface",
        "repo": "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
        "revision": "main",
        "files": ["tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"],
        "tokenEnv": "HF_TOKEN"
      },
      "autoload": true,
      "contextLength": 2048
    }
  ]
}
```

**Default startup ***REMOVED*****

- **TinyLlama 1.1B Chat** (`llama-cpp`) – auto-downloaded and auto-loaded on `wrk-model` startup

**Optional runtime models to register later:**

- **Phi-2 2.7B Q4** (`llama-cpp`) – local GGUF via Hugging Face auto-download
- **Gemma 3 1B** (`ollama`) – simple runtime registration and serving

**Quantization levels** (smaller = faster, less memory):

- `Q4_K_M` – 4-bit (recommended for most use cases)
- `Q5_K_M` – 5-bit (better quality, larger)
- `Q8_0` – 8-bit (near-original quality, 2x size)

GGUF models from TheBloke come with built-in tokenizers, so no separate files needed.

### 4 — Set Hugging Face token (optional)

Only needed for private repos:

```sh
export HF_TOKEN=hf_xxxxxxxxxx
```

### 5 — Start the Model Worker

```sh
cd wrk-model
node worker.js --wtype wrk-model --env development --debug true --rack model-rack-1
```

Watch for download and load progress on startup:

```
{"modelId":"tinyllama-1.1b","file":"tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"} downloading model asset
{"modelId":"tinyllama-1.1b","provider":"llama-cpp"} model loaded
```

Then, if needed, register additional runtime models (Phi-2 and Gemma):

- [wrk-model/PROVIDERS.md](wrk-model/PROVIDERS.md)

Copy the **RPC public key** from either the terminal logs or the status file (`wrk-model/status/wrk-model-model-rack-1.json`):

```
{"rpcPublicKey":"<MODEL_RPC_KEY>", ...}
```

### 6 — Configure and start the Inference Worker

Edit `wrk-inference/config/common.json` with the Model Worker's public key:

```json
{
  "debug": 0,
  "modelWorkerRpcKey": "<MODEL_RPC_KEY>"
}
```

Start the worker:

```sh
cd wrk-inference
node worker.js --wtype wrk-inference --env development --debug true --rack inference-rack-1
```

Note its `rpcPublicKey` from either the terminal logs or the status file (`wrk-inference/status/wrk-inference-inference-rack-1.json`).

### 7 — Start the Orchestrator

```sh
cd wrk-ork
node worker.js --wtype wrk-ork-inference --env development --cluster 1
```

Grab the orchestrator's `rpcPublicKey` from either the terminal logs or the status file (`wrk-ork/status/wrk-ork-inference-1.json`).

### 8 — Register workers with the Orchestrator

Use `hp-rpc-cli` (included as an npx-runnable tool):

```sh
# Register the Inference Worker
npx hp-rpc-cli \
  -s <ORK_RPC_KEY> \
  -m registerRack \
  -d '{"id":"inference-rack-1","type":"inference","info":{"rpcPublicKey":"<INFERENCE_RPC_KEY>"}}' \
  -t 10000

# Register the Model Worker
npx hp-rpc-cli \
  -s <ORK_RPC_KEY> \
  -m registerRack \
  -d '{"id":"model-rack-1","type":"model","info":{"rpcPublicKey":"<MODEL_RPC_KEY>"}}' \
  -t 10000
```

### 9 — Configure and start the HTTP Gateway

Edit `app-node/config/common.json`:

```json
{
  "debug": 0,
  "auth": {
    "signupSecret": "dev-secret-change-in-production",
    "tokenSecret": "your-random-256-bit-secret-here",
    "tokenTtlSeconds": 86400,
    "protectedRoutes": true
  },
  "orks": {
    "cluster-1": {
      "rpcPublicKey": "<ORK_RPC_KEY>"
    }
  }
}
```

**Important:** Replace the auth secrets with strong random strings in production. The `signupSecret` gates who can register users; `tokenSecret` signs authentication tokens.

**Recommended values:**

- `signupSecret`: random secret for controlling who can call `/auth/signup` (minimum 32 random bytes = 64 hex chars)
- `tokenSecret`: different random secret used to sign access tokens (minimum 32 random bytes, recommended 64 random bytes = 128 hex chars)

Generate both with OpenSSL:

```sh
# signupSecret (32 bytes)
openssl rand -hex 32

# tokenSecret (64 bytes)
openssl rand -hex 64
```

Best practice: keep these secrets in environment variables or a secret manager, use different values per environment, and avoid committing real secrets to git.

Start the gateway:

```sh
cd app-node
node worker.js --wtype wrk-node-http --env development --port 3000
```

That's it. Your platform is running.

---

## HTTP API

All endpoints run on the `app-node` HTTP gateway (default port 3000).

**Public endpoints** (no auth required):

- `POST /auth/signup` – Register a user
- `POST /auth/login` – Get an access token

**Protected endpoints** (require `Authorization: Bearer <token>`):

- `POST /inference` – Submit a text generation job
- `GET /inference/:jobId` – Check job status and retrieve results
- `DELETE /inference/:jobId` – Cancel a queued/running job
- `GET /inference` – List jobs for a specific rack (`rackId` query required)
- `GET /models` – List available models
- `GET /racks` – List registered service racks

### Authentication

#### Register a user

```sh
curl -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "password": "secret123",
    "signup_secret": "dev-secret-change-in-production",
    "roles": ["user"]
  }'
```

The `signup_secret` must match the value in your config. This prevents unauthorized registrations.

**Response:**

```json
{
  "email": "user@example.com",
  "roles": ["user"]
}
```

#### Login and get a token

```sh
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"secret123"}' \
  | jq -r .token)
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": {
    "email": "user@example.com",
    "roles": ["user"]
  }
}
```

Tokens expire after 24 hours by default (configurable via `tokenTtlSeconds`).

### Text Generation

#### Submit an inference job

```sh
curl -X POST http://localhost:3000/inference \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "modelId": "tinyllama-1.1b",
    "prompt": "Write a haiku about recursion:",
    "params": {
      "max_tokens": 50,
      "temperature": 0.8,
      "top_p": 0.95
    }
  }'
```

**Parameters:**

- `max_tokens` (default: 50) – Max tokens to generate
- `temperature` (default: 1.0) – Sampling randomness (0.0–2.0)
- `top_p` (default: 1.0) – Nucleus sampling threshold
- `top_k` (default: 50) – Top-k sampling

**Response:**

```json
{
  "jobId": "a7b3c...",
  "status": "queued",
  "rackId": "inference-rack-1"
}
```

#### Poll job status

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/inference/<jobId>"
```

`rackId` is optional for this endpoint. If supplied, it is used directly.
If omitted, the orchestrator resolves job ownership using its `job-ownership`
Hyperbee index (`jobId -> rackId`).

**While running:**

```json
{
  "id": "a7b3c...",
  "status": "running",
  "modelId": "tinyllama-1.1b",
  "prompt": "Write a haiku about recursion:",
  "createdAt": 1709812345678
}
```

**When completed:**

```json
{
  "id": "a7b3c...",
  "status": "completed",
  "result": {
    "output": "Functions call themselves,\nEndless loops within the code,\nStack overflow waits.",
    "tokens": 18,
    "latencyMs": 2340
  }
}
```

#### List available models

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/models
```

**Response:**

```json
[
  {
    "id": "tinyllama-1.1b",
    "name": "TinyLlama 1.1B Chat",
    "type": "text-generation",
    "format": "gguf",
    "loaded": true
  }
]
```

#### List service racks

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/racks?type=inference"
```

---

## How it works

The inference path flows like this:

```
Client → HTTP Gateway → Orchestrator → Inference Worker → Model Worker
         (app-node)     (wrk-ork)      (wrk-inference)    (wrk-model)
```

### HTTP Gateway (`app-node`)

Exposes REST endpoints. The `/inference` route forwards requests to the orchestrator via Hyperswarm RPC.

**Authentication**: All routes except `/auth/signup` and `/auth/login` require a valid Bearer token. Token verification happens in `requireAuth` middleware before each protected route handler executes. User credentials are stored persistently in Hyperbee.

**Config**: `app-node/config/common.json` contains:

- `auth.signupSecret` – required to register new users
- `auth.tokenSecret` – used to sign and verify JWT-like tokens
- `auth.tokenTtlSeconds` – token expiration (default 86400 = 24 hours)
- `auth.protectedRoutes` – enable/disable auth enforcement
- `auth.sharedStoreDir` – shared filesystem path for the user database (for multi-gateway deployments)
- `orks` – list of orchestrator RPC keys to connect to

**Storage**: Uses Hyperbee to persist user accounts across restarts. When `auth.sharedStoreDir` is set, all gateway instances share one user database on a network filesystem; otherwise each instance uses its own local store.

### Orchestrator (`wrk-ork`)

Maintains a registry of inference and model racks. Routes inference requests to available workers using round-robin load balancing.

**Registration**: Workers call `registerRack` on startup to announce their RPC public key and capabilities.

**Query methods**:

- `getAvailableRacks(type)` – list all racks of a given type
- `forwardInference(rackId, payload)` – proxy request to specific inference worker

### Inference Worker (`wrk-inference`)

Manages a job queue and executes inference by calling the Model Worker.

**Methods**:

- `createInferenceJob({ modelId, prompt, params })` – enqueue a new job
- `getInferenceJob(jobId)` – retrieve job status and results
- `listAvailableModels()` – proxy model list from Model Worker

**Job lifecycle**: `queued` → `running` → `completed`/`failed`

**Storage**: Uses Hyperbee (embedded key-value store) to persist job state across restarts.

### Model Worker (`wrk-model`)

Manages models across `llama-cpp` and `ollama`, including runtime registration, model loading/unloading, and inference execution.

**Methods**:

- `listModels()` – return all configured + runtime-registered models
- `registerModel({ id, provider, ... })` – register a model at runtime
- `runModel({ modelId, prompt, params })` – generate text

**Model loading**:

- If `source.type === "huggingface"`, downloads GGUF files to provider cache settings when loading/registering
- Resolves model `path` relative to provider base/cache settings
- Supports `HF_TOKEN` environment variable for private repos (set via `source.tokenEnv`)

**Context management**: Each model maintains its own context window (`contextLength` config). Prompts exceeding this limit are truncated.

---

## Data Sharding & Storage Isolation

Every service instance maintains its own **isolated Hyperbee store**, scoped by the `--rack` (or instance) name. There is no shared database — data is partitioned at the process level.

### Goals

- Keep hot-path data local to each worker rack.
- Avoid a global shared write store for all service data.
- Provide fast lookup for job status/cancel by `jobId`.

### Request Routing

#### Submit Job

1. Client calls `POST /inference`.
2. Gateway sends `routeInference` to orchestrator.
3. Orchestrator picks an inference rack (tier-aware round-robin).
4. Selected inference rack creates the job and returns `jobId`.
5. Orchestrator stores ownership in `job-ownership`.

#### Get Status / Cancel

1. Client calls `GET /inference/:jobId` or `DELETE /inference/:jobId`.
2. If `rackId` is provided, orchestrator uses it directly.
3. If `rackId` is omitted, orchestrator resolves `rackId` from `job-ownership`.
4. Orchestrator forwards request to the owning inference rack.

### Why This Is Better Than One Shared Store

- Preserves per-rack isolation and horizontal scale.
- Avoids high lock contention and broad failure blast radius from one shared data path.
- Keeps only a small global index in orchestrator.

### Per-Rack Store Layout

When a worker starts with `--rack inference-rack-1`, its Hyperbee data lives under `store/inference-rack-1/`. Multiple instances of the same service type each get their own directory:

```
wrk-inference/
  store/
    inference-rack-1/    ← Instance 1's jobs
      CORESTORE
      db/
    inference-rack-2/    ← Instance 2's jobs
      CORESTORE
      db/
    inference-rack-3/    ← Instance 3's jobs
      CORESTORE
      db/
```

### What Each Service Stores

| Service         | Hyperbee Name    | Data                               | Sharding Key             |
| --------------- | ---------------- | ---------------------------------- | ------------------------ |
| `wrk-ork`       | `racks`          | Rack registry (all rack entries)   | Per orchestrator cluster |
| `wrk-ork`       | `job-ownership`  | Job owner index (`jobId → rackId`) | Per orchestrator cluster |
| `wrk-inference` | `jobs`           | Job records for this rack only     | Per inference rack       |
| `wrk-model`     | `runtime-models` | Runtime-registered models          | Per model rack           |
| `app-node`      | `users`          | User accounts (email → record)     | Shared (configurable)    |

### How This Achieves Sharding

1. **Job data is partitioned by inference rack.** When you run three inference workers (`inference-rack-1`, `inference-rack-2`, `inference-rack-3`), each one stores only the jobs it processed.

2. **The orchestrator maintains global routing indexes.**

- `racks` maps rack IDs to RPC keys.
- `job-ownership` maps `jobId` to owning `rackId`.
  This enables status/cancel lookups by `jobId` without scanning all inference racks.

3. **User data can be shared across gateways.** By setting `auth.sharedStoreDir` in `app-node/config/common.json` (or the `APP_AUTH_SHARED_STORE_DIR` env var) to a path on a network filesystem (NFS, EFS, shared Docker volume), all gateway instances share a single `users` Hyperbee. Users sign up once and can authenticate through any gateway. When `sharedStoreDir` is not set, the default behaviour is unchanged — each gateway keeps its own local user store.

4. **Model registrations are per-model-rack.** Runtime-registered models live in the specific `wrk-model` instance that received the registration. The orchestrator aggregates model lists by querying all model racks at request time.

### Implications

- **Horizontal scaling** adds capacity without data migration: spin up `inference-rack-4` and register it with the orchestrator. It starts with an empty job store.
- **Fast job lookup path**: `GET /inference/:jobId` and `DELETE /inference/:jobId` can resolve ownership by `jobId` through the orchestrator index (optional `rackId` still supported).
- **No full cross-rack job listing**: listing all jobs across all racks still requires querying each rack individually (the orchestrator proxies `listJobs` to a specific rack).
- **Rack removal is clean**: deregistering a rack (`forgetRacks`) removes it from routing. Its local store can be archived or deleted independently.
- **No replication built-in**: Hyperbee stores are single-node. For durability, back up the `store/` directories.

### Operational Notes

- `GET /inference` (list jobs) remains rack-scoped and requires explicit `rackId`.
- Back up `store/` directories periodically; Hyperbee does not provide automatic multi-node replication by default.

### Shared Auth Store

By default, each `app-node` gateway instance keeps its own user database. When running multiple gateways behind a load balancer, this means users registered on gateway A are unknown to gateway B.

To solve this, point all gateways at the same directory on a shared filesystem:

**Option 1 — Config file** (`app-node/config/common.json`):

```json
{
  "auth": {
    "sharedStoreDir": "/mnt/shared/auth-store"
  }
}
```

**Option 2 — Environment variable:**

```sh
export APP_AUTH_SHARED_STORE_DIR=/mnt/shared/auth-store
```

When set, the gateway opens a **dedicated Corestore + Hyperbee** at that path instead of using its per-instance store. All gateways read and write to the same Hyperbee, giving strong consistency with no replication lag.

**Requirements:**

- The shared path must be accessible from every gateway instance (NFS mount, AWS EFS, GlusterFS, or a Docker named volume on the same host).
- Hyperbee uses file-level locking, so the filesystem must support POSIX `flock()` semantics. NFS v4 and EFS both support this.
- For single-host multi-process deployments, a local directory works fine.

**Example: Docker Compose with a shared volume:**

```yaml
services:
  gateway-1:
  ***REMOVED*** ai-inference-gateway
    volumes:
      - auth-store:/data/auth-store
    environment:
      APP_AUTH_SHARED_STORE_DIR: /data/auth-store
    ports:
      - "3001:3000"

  gateway-2:
  ***REMOVED*** ai-inference-gateway
    volumes:
      - auth-store:/data/auth-store
    environment:
      APP_AUTH_SHARED_STORE_DIR: /data/auth-store
    ports:
      - "3002:3000"

volumes:
  auth-store:
```

When `sharedStoreDir` is empty or omitted, the gateway uses its local per-instance store (the original behaviour).

---

## Audit Logging & Tracing

All services emit structured audit logs in **NDJSON** (newline-delimited JSON) format to `stdout` via [Pino](https://github.com/pinojs/pino). Each log event carries a `traceId` (UUID v4) that propagates across service boundaries, making it possible to correlate events from a single user request as it flows through the platform.

### Architecture

Audit logging is implemented via a shared module ([wrk-base/lib/audit.js](wrk-base/lib/audit.js)) that is attached to every worker through the base class. All four service layers emit audit events:

1. **HTTP Gateway (`app-node`)** – Logs HTTP requests, RPC calls to the orchestrator, and concurrency-limit rejections
2. **Orchestrator (`wrk-ork`)** – Logs rack registration, rack listing, rack removal, and inference routing decisions
3. **Inference Worker (`wrk-inference`)** – Logs job lifecycle (queued → running → completed/failed), RPC calls to Model Worker
4. **Model Worker (`wrk-model`)** – Logs model inference execution and errors

Every worker also logs a `LIFECYCLE` event at startup (emitted from `wrk-base`).

Each service writes logs to `stdout` in NDJSON format. In production, redirect these to a log aggregation system (Loki, Elasticsearch, CloudWatch, etc.) for centralized querying.

**Trace ID propagation flow:**

```
HTTP Request → Gateway generates traceId (UUID v4)
              ↓
         Gateway logs REQUEST for "POST /inference"
              ↓
         Gateway logs RPC_CALL to orchestrator
              ↓
         Gateway sends { ...body, traceId } to orchestrator via RPC
              ↓
         Orchestrator logs REQUEST for "routeInference"
              ↓
         Orchestrator logs RPC_CALL to inference worker
              ↓
         Inference Worker inherits traceId via getOrCreateTraceId(req)
              ↓
         Inference Worker logs JOB_STATUS changes
              ↓
         Inference Worker logs RPC_CALL / RPC_RESPONSE to Model Worker
              ↓
         Model Worker inherits traceId via getOrCreateTraceId(req)
              ↓
         Model Worker logs REQUEST / RESPONSE / ERROR for "runModel"
```

All log events for a single request share the same `traceId`, enabling you to reconstruct the full request path.

### Event Types

The audit module defines the following event types (used in the `eventType` field of every log entry):

| Event Type     | Description                            | Where Used                                              |
| -------------- | -------------------------------------- | ------------------------------------------------------- |
| `REQUEST`      | Incoming request received              | All services – entry point of each RPC method / route   |
| `RESPONSE`     | Outgoing response sent                 | All services – after processing completes               |
| `ERROR`        | Error condition                        | All services – on failures or exceptions                |
| `LIFECYCLE`    | Service start/stop/ready               | `wrk-base` – emitted once when any worker starts        |
| `RPC_CALL`     | Outgoing RPC call to another service   | Gateway → Ork, Ork → Inference, Inference → Model       |
| `RPC_RESPONSE` | Response received from another service | Ork ← Inference, Inference ← Model                      |
| `DATA_ACCESS`  | Database/store read or write           | Available but not currently called in application code  |
| `AUTH`         | Authentication/authorization event     | Available but not currently called in application code  |
| `JOB_STATUS`   | Job state change                       | `wrk-inference` – on queued, running, completed, failed |

### Log Format

Logs are output by Pino in NDJSON format. Each audit event is a JSON object at the `info` (or `error`) level with an `audit: true` marker field:

```json
{
  "level": 30,
  "time": 1741444335123,
  "pid": 42561,
  "hostname": "node-1",
  "name": "wrk:wrk-node-http:42561",
  "audit": true,
  "eventType": "REQUEST",
  "timestamp": "2026-03-08T14:32:15.123Z",
  "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "method": "POST /inference",
  "modelId": "tinyllama-1.1b",
  "userId": "user@example.com",
  "ip": "127.0.0.1"
}
```

**Standard fields on every audit event:**

- `audit` – always `true` (marker to distinguish audit logs from general logs)
- `eventType` – one of the event types listed above
- `timestamp` – ISO 8601 timestamp (UTC) set by the audit module
- `traceId` – UUID v4 for request correlation (e.g. `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`)

**Pino envelope fields** (added automatically):

- `level` – numeric log level (30 = info, 50 = error)
- `time` – Unix epoch milliseconds
- `pid` – process ID
- `hostname` – machine hostname
- `name` – logger name (format: `wrk:<wtype>:<pid>`)

**Additional context fields** vary by event and service (e.g., `method`, `modelId`, `jobId`, `rackId`, `durationMs`, `error`, `stack`).

### Trace Propagation Example

Here is a realistic trace of a single inference request flowing through all four services. All events share the same `traceId`.

#### 1. HTTP Gateway receives the request

```json
{
  "level": 30,
  "time": 1741444335123,
  "name": "wrk:wrk-node-http:42561",
  "audit": true,
  "eventType": "REQUEST",
  "timestamp": "2026-03-08T14:32:15.123Z",
  "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "method": "POST /inference",
  "modelId": "tinyllama-1.1b",
  "userId": "user@example.com",
  "ip": "127.0.0.1"
}
```

#### 2. Gateway calls orchestrator RPC

```json
{
  "level": 30,
  "time": 1741444335130,
  "name": "wrk:wrk-node-http:42561",
  "audit": true,
  "eventType": "RPC_CALL",
  "timestamp": "2026-03-08T14:32:15.130Z",
  "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "targetService": "a1b2c3d4e5f6...",
  "method": "routeInference",
  "modelId": "tinyllama-1.1b"
}
```

#### 3. Orchestrator logs the routing request and RPC call to inference worker

```json
{"level":30,"time":1741444335145,"name":"wrk:wrk-ork-***REMOVED***42570","audit":true,"eventType":"REQUEST","timestamp":"2026-03-08T14:32:15.145Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","method":"routeInference","modelId":"tinyllama-1.1b","hasPrompt":true}
{"level":30,"time":1741444335150,"name":"wrk:wrk-ork-***REMOVED***42570","audit":true,"eventType":"RPC_CALL","timestamp":"2026-03-08T14:32:15.150Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","targetService":"inference-rack-1","method":"runInference","modelId":"tinyllama-1.1b"}
```

#### 4. Inference Worker logs job creation and calls Model Worker

```json
{"level":30,"time":1741444335200,"name":"wrk:wrk-***REMOVED***42580","audit":true,"eventType":"REQUEST","timestamp":"2026-03-08T14:32:15.200Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","method":"runInference","modelId":"tinyllama-1.1b","promptLength":30}
{"level":30,"time":1741444335210,"name":"wrk:wrk-***REMOVED***42580","audit":true,"eventType":"JOB_STATUS","timestamp":"2026-03-08T14:32:15.210Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","jobId":"c3d4e5f6-...","status":"queued","modelId":"tinyllama-1.1b"}
{"level":30,"time":1741444335220,"name":"wrk:wrk-***REMOVED***42580","audit":true,"eventType":"RPC_CALL","timestamp":"2026-03-08T14:32:15.220Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","targetService":"a9b8c7d6...","method":"runModel","jobId":"c3d4e5f6-...","modelId":"tinyllama-1.1b"}
```

#### 5. Model Worker executes inference and responds

```json
{"level":30,"time":1741444335300,"name":"wrk:wrk-***REMOVED***42590","audit":true,"eventType":"REQUEST","timestamp":"2026-03-08T14:32:15.300Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","method":"runModel","modelId":"tinyllama-1.1b"}
{"level":30,"time":1741444337640,"name":"wrk:wrk-***REMOVED***42590","audit":true,"eventType":"RESPONSE","timestamp":"2026-03-08T14:32:17.640Z","traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","method":"runModel","durationMs":2340,"tokens":18}
```

#### 6. Gateway completes the response

```json
{
  "level": 30,
  "time": 1741444337700,
  "name": "wrk:wrk-node-http:42561",
  "audit": true,
  "eventType": "RESPONSE",
  "timestamp": "2026-03-08T14:32:17.700Z",
  "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "method": "POST /inference",
  "durationMs": 2577,
  "jobId": "c3d4e5f6-...",
  "status": "queued"
}
```

### Querying Logs by Trace ID

Since logs are NDJSON, you can use standard Unix tools to filter by trace ID:

```sh
# Find all events for a specific trace (pipe all service logs together)
cat app-node.log ork.log inference.log model.log \
  | grep '"traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"'

# Pretty-print with jq
grep '"traceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"' *.log | jq .

# List unique trace IDs by frequency
grep '"traceId"' *.log | jq -r .traceId | sort | uniq -c | sort -rn

# Show only audit events (ignore regular Pino log lines)
grep '"audit":true' *.log | jq .
```

For production systems, use your log aggregation platform's query language:

**Loki (LogQL):**

```logql
{job="ai-inference"} | json | traceId="f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

**Elasticsearch:**

```json
{
  "query": {
    "term": { "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
  }
}
```

**CloudWatch Logs Insights:**

```
fields @timestamp, eventType, method, traceId
| filter traceId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
| sort @timestamp asc
```

### Error Trace Example

When errors occur, the audit logger captures the error message and stack trace:

```json
{"level":30,"time":1741447522123,"name":"wrk:wrk-node-http:42561","audit":true,"eventType":"REQUEST","timestamp":"2026-03-08T14:45:22.123Z","traceId":"e8a3b1c2-d4f5-6789-abcd-ef0123456789","method":"POST /inference","modelId":"tinyllama-1.1b","userId":"user@example.com","ip":"127.0.0.1"}
{"level":30,"time":1741447522130,"name":"wrk:wrk-node-http:42561","audit":true,"eventType":"RPC_CALL","timestamp":"2026-03-08T14:45:22.130Z","traceId":"e8a3b1c2-d4f5-6789-abcd-ef0123456789","targetService":"a1b2c3d4...","method":"routeInference","modelId":"tinyllama-1.1b"}
{"level":50,"time":1741447522456,"name":"wrk:wrk-ork-***REMOVED***42570","audit":true,"eventType":"ERROR","timestamp":"2026-03-08T14:45:22.456Z","traceId":"e8a3b1c2-d4f5-6789-abcd-ef0123456789","method":"routeInference","error":"ERR_NO_INFERENCE_WORKERS","modelId":"tinyllama-1.1b"}
```

This shows the request failed because no inference workers were registered with the orchestrator.

### What Is and Isn't Covered

The audit module ([wrk-base/lib/audit.js](wrk-base/lib/audit.js)) provides helper functions for 9 event types and is attached to every worker via `this.audit`. Currently, the following helpers are **actively called** in application code:

- `generateTraceId()` / `getOrCreateTraceId(req)` – all services
- `logRequest()` / `logResponse()` – all services
- `logError()` – all services
- `logRpcCall()` / `logRpcResponse()` – gateway, orchestrator, inference worker
- `logJobStatus()` – inference worker
- `logLifecycle()` – base worker (startup)
- `createTimer()` – gateway, model worker

The `logDataAccess()` and `logAuth()` helpers (for `DATA_ACCESS` and `AUTH` events) are defined in the module but **not yet called** in application code. They are available for future use by any worker via `this.audit.logDataAccess(...)`.

### Best Practices

1. **Set log retention policies** – NDJSON logs can grow quickly; rotate daily and archive to object storage
2. **Index key fields** – If shipping to Elasticsearch/Loki, index `traceId`, `eventType`, `method`, and `jobId` for fast queries
3. **Filter by `audit: true`** – Use this marker to separate structured audit events from general Pino log output
4. **Monitor error rates** – Alert on spikes in `ERROR` events, particularly for methods like `routeInference` or `runModel`
5. **Correlate with metrics** – Combine trace logs with metrics (request rate, latency histograms) for full observability

---

## Testing & Development

### CLI testing with `hp-rpc-cli`

Test RPC methods directly without HTTP:

```sh
# List models
npx hp-rpc-cli \
  -s <INFERENCE_RPC_KEY> \
  -m listAvailableModels \
  -t 30000

# Create inference job
npx hp-rpc-cli \
  -s <INFERENCE_RPC_KEY> \
  -m createInferenceJob \
  -d '{"modelId":"tinyllama-1.1b","prompt":"Hello world","params":{"max_tokens":20}}' \
  -t 30000

# Check job status
npx hp-rpc-cli \
  -s <INFERENCE_RPC_KEY> \
  -m getInferenceJob \
  -d '{"jobId":"<JOB_ID>"}' \
  -t 30000
```

For adding runtime models later (Gemma 3 1B + Phi-2 2.7B), see:

- [wrk-model/PROVIDERS.md](wrk-model/PROVIDERS.md)

---

## Code Style & Linting

All JavaScript code follows [StandardJS](https://standardjs.com/) style (no semicolons, 2-space indent).

### Lint all packages at once (from root):

```sh
npm run lint        # check all workspaces
npm run lint:fix    # auto-fix all workspaces
```

### Lint individual packages:

```sh
cd wrk-model && npm run lint:fix
cd wrk-inference && npm run lint:fix
# ... etc
```

StandardJS is configured as a dev dependency in each package and will automatically fix most formatting issues.

---

## Project Structure

Each worker inherits from `wrk-base/worker.js`, which provides:

- **Hyperswarm RPC server** – listens for incoming RPC calls
- **Hyperswarm RPC client** – connects to other services
- **Hyperbee storage** – embedded key-value store for persistence
- **Status reporting** – writes JSON status files to `status/` directory
- **Config loading** – merges `config/common.json` with environment-specific overrides

Workers implement their own RPC method handlers. For example:

- `wrk-model/workers/model.wrk.js` → `listModels`, `registerModel`, `runModel`
- `wrk-inference/workers/inference.wrk.js` → `createInferenceJob`, `getInferenceJob`
- `wrk-ork/workers/inference.ork.wrk.js` → `registerRack`, `forwardInference`

The HTTP gateway (`app-node`) uses Fastify to expose REST endpoints that translate to RPC calls.

---

## Configuration Deep Dive

### Model Worker (`wrk-model/config/common.json`)

```json
{
  "debug": 0,
  "runtime": {
    "providers": [
      {
        "type": "llama-cpp",
        "enabled": true,
        "settings": {
          "modelBaseDir": "./models",
          "modelCacheDir": "./models/.cache"
        }
      },
      {
        "type": "ollama",
        "enabled": true,
        "endpoint": "http://localhost:11434"
      }
    ]
  },
  "models": [
    {
      "id": "tinyllama-1.1b",
      "name": "TinyLlama 1.1B Chat",
      "provider": "llama-cpp",
      "type": "text-generation",
      "format": "gguf",
      "quantization": "Q4_K_M",
      "path": "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "source": {
        "type": "huggingface",
        "repo": "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
        "revision": "main",
        "files": ["tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"],
        "tokenEnv": "HF_TOKEN"
      },
      "autoload": true,
      "contextLength": 2048
    }
  ]
}
```

**Fields:**

- `runtime.providers[]` – list of enabled inference providers
- `runtime.providers[].type` – provider kind (`"llama-cpp"` or `"ollama"`)
- `runtime.providers[].settings.modelBaseDir` – llama-cpp base directory for model files
- `runtime.providers[].settings.modelCacheDir` – llama-cpp cache directory for Hugging Face downloads
- `runtime.providers[].endpoint` – ollama HTTP endpoint
- `models[]` – static startup models
- `models[].autoload` – download and load model on worker startup

### Inference Worker (`wrk-inference/config/common.json`)

```json
{
  "debug": 0,
  "modelWorkerRpcKey": "<MODEL_RPC_KEY>"
}
```

**Fields:**

- `modelWorkerRpcKey` – RPC public key of the Model Worker to connect to

### HTTP Gateway (`app-node/config/common.json`)

```json
{
  "debug": 0,
  "auth": {
    "signupSecret": "dev-secret-change-in-production",
    "tokenSecret": "your-random-256-bit-secret-here",
    "tokenTtlSeconds": 86400,
    "protectedRoutes": true,
    "sharedStoreDir": ""
  },
  "orks": {
    "cluster-1": {
      "rpcPublicKey": "<ORK_RPC_KEY>"
    }
  }
}
```

**Fields:**

- `auth.signupSecret` – shared secret required to register new users (prevents open signups)
- `auth.tokenSecret` – secret key for signing JWT-like tokens (CHANGE IN PRODUCTION!)
- `auth.tokenTtlSeconds` – token expiration time in seconds (default 86400 = 24 hours)
- `auth.protectedRoutes` – enable/disable auth enforcement (set `false` to disable auth globally)
- `auth.sharedStoreDir` – path to a shared directory for the user database (NFS/EFS); when set, all gateways share a single user store. Leave empty for per-instance storage (default).
- `orks` – map of orchestrator cluster names to their RPC public keys

**Environment variable overrides:**

- `APP_SIGNUP_SECRET` – overrides `auth.signupSecret`
- `APP_TOKEN_SECRET` – overrides `auth.tokenSecret`
- `APP_AUTH_SHARED_STORE_DIR` – overrides `auth.sharedStoreDir`

---

## Security Notes

1. **Change default secrets in production**: The `signupSecret` and `tokenSecret` in `app-node/config/common.json` are placeholders. Generate strong random secrets before deploying.

2. **User storage is persistent**: The auth module stores users in Hyperbee (embedded key-value database). User data persists across server restarts and is stored in `app-node/store/`.

3. **No password recovery**: This is a minimal auth implementation. Add email verification and password reset flows for production use.

4. **HTTPS recommended**: The HTTP gateway does not enforce TLS. Run it behind a reverse proxy (nginx, Caddy) with HTTPS in production.

5. **Rate limiting**: No rate limiting is implemented. Add middleware like `fastify-rate-limit` to prevent abuse.

---

## Troubleshooting

### Model download fails with 403 Forbidden

Some Hugging Face repos require authentication. Set `HF_TOKEN`:

```sh
export HF_TOKEN=hf_xxxxxxxxxx
```

Ensure `source.tokenEnv` in your model config points to `"HF_TOKEN"`.

### Inference job stays in "queued" forever

Check that:

1. The Inference Worker is running and registered with the Orchestrator
2. The Model Worker RPC key in `wrk-inference/config/common.json` is correct
3. The model loaded successfully (check `wrk-model` logs for errors)

### Auth always returns 401 Unauthorized

Verify:

1. You logged in and received a valid token
2. The `Authorization: Bearer <token>` header is present in your request
3. `auth.protectedRoutes` is `true` in `app-node/config/common.json`
4. The token hasn't expired (default 24 hours)

---

## Dynamic Runtime Model Registration

One of the strongest use cases of this platform is dynamically registering models at runtime (no service restart), so you can roll out or switch LLMs quickly.

For the focused runtime flow (Gemma 3 1B + Phi-2 2.7B), registration commands, unload commands, and verification, see:

- [wrk-model/PROVIDERS.md](wrk-model/PROVIDERS.md)

---

## Scalability Testing

For full step-by-step scalability validation (instance counts, rack topology, user role combinations, failover checks, premium routing checks, and ork failover), see:

- [SCALABILITY-TEST-README.md](SCALABILITY-TEST-README.md)

---

## License

Apache Licence 2.0
