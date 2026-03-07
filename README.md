# AI Inference Platform

A decentralised, microservice-based AI inference platform built on [Hyperswarm RPC](https://github.com/holepunchto/hyperswarm-rpc). Instead of relying on a central broker, services discover each other through a DHT-backed registry, making the platform naturally resilient to node failures and easy to scale horizontally.

This platform focuses on text generation with **GGUF quantized LLM models** from Hugging Face, using `node-llama-cpp`.

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

Edit `wrk-model/config/common.json` to define which models to load:

```json
{
  "debug": 0,
  "runtime": {
    "provider": "node-llama-cpp",
    "modelBaseDir": "./models",
    "modelCacheDir": "./models/.cache"
  },
  "models": [
    {
      "id": "tinyllama-1.1b",
      "name": "TinyLlama 1.1B Chat",
      "type": "text-generation",
      "format": "gguf",
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

**Popular GGUF models to try:**

- **TinyLlama 1.1B** (~700MB Q4) – Fast, great for testing
- **Phi-2 2.7B** (~1.6GB Q4) – Better quality, still fast
- **Mistral 7B Instruct** (~4GB Q4) – Production-grade quality
- **Llama-2 7B Chat** (~4GB Q4) – Meta's well-known model

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

Watch for download progress on first run:

```
{"modelId":"tinyllama-1.1b","file":"tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"} downloading model asset
{"modelId":"tinyllama-1.1b","provider":"node-llama-cpp"} model loaded
```

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

**Authentication**: All routes except `/auth/signup` and `/auth/login` require a valid Bearer token. Token verification happens in `requireAuth` middleware before each protected route handler executes.

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

Loads and manages GGUF models using `node-llama-cpp`. Handles model downloads from Hugging Face and text generation.

**Methods**:

- `listModels()` – return all configured models
- `runInference({ modelId, prompt, params })` – generate text

**Model loading**:

- If `source.type === "huggingface"`, downloads GGUF files to `runtime.modelCacheDir` on startup (if `autoload: true`)
- Resolves model `path` relative to the cache directory
- Supports `HF_TOKEN` environment variable for private repos (set via `source.tokenEnv`)

**Context management**: Each model maintains its own context window (`contextLength` config). Prompts exceeding this limit are truncated.

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

### Stub mode (no real LLM)

To test without downloading models, leave `runtime.provider` as `"stub"` in `wrk-model/config/common.json`. The Model Worker will return deterministic fake responses instead of running actual inference.

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

- `wrk-model/workers/model.wrk.js` → `listModels`, `runInference`
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
    "provider": "node-llama-cpp",
    "modelBaseDir": "./models",
    "modelCacheDir": "./models/.cache"
  },
  "models": [
    {
      "id": "tinyllama-1.1b",
      "name": "TinyLlama 1.1B Chat",
      "type": "text-generation",
      "format": "gguf",
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

- `runtime.provider` – `"stub"` (fake responses) or `"node-llama-cpp"` (real inference)
- `runtime.modelBaseDir` – directory for manually placed model files
- `runtime.modelCacheDir` – directory for auto-downloaded Hugging Face models
- `models[].id` – unique identifier used in API requests
- `models[].path` – filename relative to `modelCacheDir` (for HF downloads) or `modelBaseDir`
- `models[].source.type` – `"huggingface"` enables auto-download
- `models[].source.repo` – Hugging Face repo in `owner/repo` format
- `models[].source.files` – list of GGUF files to download
- `models[].source.tokenEnv` – environment variable name for HF token (optional)
- `models[].autoload` – download and load model on worker startup
- `models[].contextLength` – max tokens (prompt + response)

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

2. **No password recovery**: This is a minimal auth implementation. Add email verification and password reset flows for production use.

3. **HTTPS recommended**: The HTTP gateway does not enforce TLS. Run it behind a reverse proxy (nginx, Caddy) with HTTPS in production.

4. **Rate limiting**: No rate limiting is implemented. Add middleware like `fastify-rate-limit` to prevent abuse.

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

## License

Apache Licence 2.0
