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

Copy the **RPC public key** from the logs:

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

Note its `rpcPublicKey` from the logs.

### 7 — Start the Orchestrator

```sh
cd wrk-ork
node worker.js --wtype wrk-ork-inference --env development --cluster 1
```

Grab the orchestrator's `rpcPublicKey` from the logs.

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
  "http://localhost:3000/inference/<jobId>?rackId=inference-rack-1"
```

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
- `orks` – list of orchestrator RPC keys to connect to

**Storage**: Uses Hyperbee to persist user accounts across restarts.

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

## Audit Logging & Tracing

All services emit structured audit logs in **NDJSON** (newline-delimited JSON) format to `stdout`. Each log event carries a `traceId` that propagates across service boundaries, making it easy to correlate events from a single user request as it flows through the platform.

### Architecture

Audit logging is implemented at two layers:

1. **HTTP Gateway (`app-node`)** – Logs all HTTP requests, RPC calls, authentication events, and errors
2. **Orchestrator (`wrk-ork`)** – Logs rack registration, heartbeats, failures, and routing decisions

Each service writes logs to `stdout` in NDJSON format. In production, redirect these to a log aggregation system (Loki, Elasticsearch, CloudWatch, etc.) for centralized querying.

**Trace ID propagation flow:**

```
HTTP Request → Gateway generates traceId
              ↓
         Gateway logs REQUEST_RECEIVED
              ↓
         Gateway calls Orchestrator RPC (includes traceId)
              ↓
         Orchestrator logs RACK_ROUTE_SELECTED (inherits traceId)
              ↓
         Gateway logs RPC_CALL_SUCCESS or RPC_CALL_ERROR
              ↓
         Gateway logs REQUEST_COMPLETED
```

All log events for a single request share the same `traceId`, enabling you to reconstruct the full request path using a simple grep or log query.

### Event Types

#### HTTP Gateway Events (`app-node`)

| Event Type                 | Description                     | When Logged                              |
| -------------------------- | ------------------------------- | ---------------------------------------- |
| `REQUEST_RECEIVED`         | HTTP request started            | Before route handler executes            |
| `REQUEST_COMPLETED`        | HTTP request finished           | After response is sent                   |
| `AUTH_SIGNUP_SUCCESS`      | User registration succeeded     | After user created in DB                 |
| `AUTH_SIGNUP_FAILURE`      | User registration failed        | On validation or DB error                |
| `AUTH_LOGIN_SUCCESS`       | User login succeeded            | After token generation                   |
| `AUTH_LOGIN_FAILURE`       | User login failed               | On invalid credentials                   |
| `AUTH_INVALID_TOKEN`       | Token verification failed       | On protected route access with bad token |
| `RPC_CALL_SUCCESS`         | Orchestrator RPC call succeeded | After successful RPC response            |
| `RPC_CALL_ERROR`           | Orchestrator RPC call failed    | On RPC timeout or error                  |
| `REQUEST_VALIDATION_ERROR` | Request body validation failed  | On schema mismatch                       |
| `INTERNAL_ERROR`           | Unexpected server error         | On uncaught exceptions                   |

#### Orchestrator Events (`wrk-ork`)

| Event Type                | Description                  | When Logged                                |
| ------------------------- | ---------------------------- | ------------------------------------------ |
| `RACK_REGISTERED`         | New rack joined the registry | On `registerRack` RPC call                 |
| `RACK_HEARTBEAT_RECEIVED` | Rack sent heartbeat          | On `heartbeatRack` RPC call                |
| `RACK_FAILURE_MARKED`     | Rack marked as failed        | On explicit failure signal or lease expiry |
| `RACK_ROUTE_SELECTED`     | Rack chosen for request      | During routing decision                    |
| `NO_RACKS_AVAILABLE`      | No healthy racks found       | When routing fails due to empty registry   |

### Log Format

All logs follow this structure:

```json
{
  "timestamp": "2026-03-08T14:32:15.123Z",
  "level": "info",
  "service": "app-node",
  "traceId": "a7b3c9d1e5f2",
  "event": "REQUEST_RECEIVED",
  "method": "POST",
  "url": "/inference",
  "userId": "user@example.com",
  "ip": "127.0.0.1"
}
```

**Common fields:**

- `timestamp` – ISO 8601 timestamp (UTC)
- `level` – `info`, `warn`, or `error`
- `service` – service name (`app-node`, `wrk-ork`, etc.)
- `traceId` – unique ID for request correlation (12-char hex string)
- `event` – event type (see tables above)

**Additional context fields** vary by event type (e.g., `method`, `url`, `statusCode`, `rackId`, `modelId`).

### Trace Propagation Example

Here's a full trace of a single inference request flowing through the platform:

#### 1. HTTP Gateway receives request

```json
{
  "timestamp": "2026-03-08T14:32:15.123Z",
  "level": "info",
  "service": "app-node",
  "traceId": "a7b3c9d1e5f2",
  "event": "REQUEST_RECEIVED",
  "method": "POST",
  "url": "/inference",
  "userId": "user@example.com",
  "ip": "127.0.0.1"
}
```

#### 2. Orchestrator selects rack

```json
{
  "timestamp": "2026-03-08T14:32:15.145Z",
  "level": "info",
  "service": "wrk-ork",
  "traceId": "a7b3c9d1e5f2",
  "event": "RACK_ROUTE_SELECTED",
  "rackId": "inference-rack-1",
  "tier": "premium",
  "dedicated": true,
  "routingStrategy": "round-robin"
}
```

#### 3. Gateway calls orchestrator successfully

```json
{
  "timestamp": "2026-03-08T14:32:15.234Z",
  "level": "info",
  "service": "app-node",
  "traceId": "a7b3c9d1e5f2",
  "event": "RPC_CALL_SUCCESS",
  "method": "forwardInference",
  "rackId": "inference-rack-1",
  "latencyMs": 89
}
```

#### 4. Gateway completes request

```json
{
  "timestamp": "2026-03-08T14:32:15.256Z",
  "level": "info",
  "service": "app-node",
  "traceId": "a7b3c9d1e5f2",
  "event": "REQUEST_COMPLETED",
  "statusCode": 200,
  "latencyMs": 133
}
```

All four events share the same `traceId: "a7b3c9d1e5f2"`, making it trivial to reconstruct the full request flow.

### Querying Logs by Trace ID

Since logs are NDJSON, you can use standard Unix tools to filter by trace ID:

```sh
# Find all events for a specific trace
grep '"traceId":"a7b3c9d1e5f2"' app-node.log

# Pretty-print with jq
grep '"traceId":"a7b3c9d1e5f2"' app-node.log | jq .

# Count events per trace
grep '"traceId"' app-node.log | jq -r .traceId | sort | uniq -c | sort -rn
```

For production systems, use your log aggregation platform's query language:

**Loki (LogQL):**

```logql
{service="app-node"} | json | traceId="a7b3c9d1e5f2"
```

**Elasticsearch:**

```json
{
  "query": {
    "term": { "traceId": "a7b3c9d1e5f2" }
  }
}
```

**CloudWatch Logs Insights:**

```
fields @timestamp, event, statusCode
| filter traceId = "a7b3c9d1e5f2"
| sort @timestamp asc
```

### Error Trace Example

When errors occur, the trace includes failure context:

```json
{"timestamp":"2026-03-08T14:45:22.123Z","level":"info","service":"app-node","traceId":"x9y8z7w6v5u4","event":"REQUEST_RECEIVED","method":"POST","url":"/inference"}
{"timestamp":"2026-03-08T14:45:22.456Z","level":"error","service":"app-node","traceId":"x9y8z7w6v5u4","event":"RPC_CALL_ERROR","method":"forwardInference","error":"RPC_TIMEOUT","message":"No response from orchestrator after 10000ms"}
{"timestamp":"2026-03-08T14:45:22.478Z","level":"error","service":"app-node","traceId":"x9y8z7w6v5u4","event":"REQUEST_COMPLETED","statusCode":503,"latencyMs":355}
```

This shows the request failed due to an RPC timeout, and the gateway returned HTTP 503.

### Best Practices

1. **Always include traceId in API responses** – Return the trace ID in HTTP headers or response bodies so clients can reference it when reporting issues
2. **Set log retention policies** – NDJSON logs can grow quickly; rotate daily and archive to object storage
3. **Index key fields** – If shipping to Elasticsearch/Loki, index `traceId`, `userId`, `event`, `statusCode` for fast queries
4. **Monitor error rates** – Alert on spikes in `RPC_CALL_ERROR`, `AUTH_LOGIN_FAILURE`, or `INTERNAL_ERROR` events
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
    "protectedRoutes": true
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
- `orks` – map of orchestrator cluster names to their RPC public keys

**Environment variable overrides:**

- `APP_SIGNUP_SECRET` – overrides `auth.signupSecret`
- `APP_TOKEN_SECRET` – overrides `auth.tokenSecret`

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
