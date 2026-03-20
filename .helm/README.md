# Helm Deployment Guide

This folder contains a Helm chart for deploying the AI Inference Platform on Kubernetes.

## Why Helm?

- **No image rebuilds for config changes**: Update secrets, RPC keys, and configuration without rebuilding Docker images.
- **Externalized configuration**: Runtime settings are defined in `values.yaml`, ConfigMaps, and Secrets.
- **Easy scaling**: Increase replicas for app-node, inference, and model services without manual process management.
- **Environment flexibility**: Easily switch between development and production by changing values.

## What is externalized

- `APP_SIGNUP_SECRET` and `APP_TOKEN_SECRET` (Kubernetes Secret)
- `HF_TOKEN` (optional Kubernetes Secret)
- `app-node/config/common.json` (ConfigMap)
- `wrk-inference/config/common.json` (ConfigMap)
- **Persistent storage** (PersistentVolumeClaims for app-node, wrk-ork, wrk-inference, wrk-model)

This means you can update keys and RPC config with `helm upgrade` and a values file, without creating new images.

## Persistence Configuration

Each service optionally uses persistent storage for caching and state. All services have persistence enabled by default in `values.yaml`:

- **app-node**: Stores user authentication state and shared RPC store (2Gi default)
- **wrk-ork**: Stores orchestration state and RPC metadata (2Gi default)
- **wrk-inference**: Stores inference job results and cache per replica (2Gi per replica default)
- **wrk-model**: Stores model cache and metadata per replica (10Gi default)

To disable persistence for a service:

```yaml
appNode:
  persistence:
    enabled: false
```

To customize storage size and storage class:

```yaml
inference:
  persistence:
    enabled: true
    size: 30Gi
    storageClassName: fast-nvme # optional; uses default if omitted
```

**Note**: `wrk-inference` and `wrk-model` use StatefulSets with `volumeClaimTemplates`, creating per-replica PVCs. Deployments (app-node, wrk-ork) use shared PVCs.

## Chart File Structure

Here's where each file goes and what it does in your Kubernetes cluster:

```
.helm/
├── Chart.yaml                         # Helm chart metadata
├── values.yaml                        # Default configuration (do not modify for deployments)
├── values.prod.yaml                   # ← YOUR copy, contains your secrets and image repos
│
└── templates/
    ├── _helpers.tpl                  # Shared template helpers
    │
    # CORE DEPLOYMENTS
    ├── app-node-deployment.yaml       # Creates the API gateway pods
    ├── ork-deployment.yaml            # Creates the orchestrator pods
    ├── ui-deployment.yaml             # Creates the web UI pods
    │
    # WORKER SERVICES (StatefulSets for persistent state)
    ├── inference-statefulset.yaml     # Creates inference worker pods
    ├── model-statefulset.yaml         # Creates model worker pods
    │
    # SERVICES (Kubernetes networking)
    ├── app-node-service.yaml          # Exposes app-node internally
    ├── ui-service.yaml                # Exposes UI internally
    ├── inference-headless-service.yaml # DNS for inference workers
    ├── model-headless-service.yaml     # DNS for model workers
    │
    # INGRESS (External access)
    ├── ui-ingress.yaml                # Routes external traffic to UI
    ├── api-ingress.yaml               # Routes external traffic to API
    │
    # CONFIGURATION
    ├── configmap-app-node.yaml        # Mounts app-node config file
    ├── configmap-inference.yaml        # Mounts inference config file
    │
    # SECRETS
    ├── secret-auth.yaml               # Creates auth secret with APP_SIGNUP_SECRET, APP_TOKEN_SECRET
    ├── secret-model.yaml              # Creates HF_TOKEN secret
    │
    # PERSISTENT STORAGE
    ├── app-node-pvc.yaml              # Creates storage volume for app-node
    ├── ork-pvc.yaml                   # Creates storage volume for ork
    ├── inference-pvc.yaml             # Creates storage volumes for inference (per replica)
    ├── model-pvc.yaml                 # Creates storage volumes for model (per replica)
    │
    # OPTIONAL
    ├── register-racks-job.yaml        # (Optional) Job to register racks with hp-rpc-cli
    └── NOTES.txt                      # Post-install deployment instructions
```

**Key relationship:**

- `values.prod.yaml` → contains all your configuration
- `Chart.yaml` → defines what templates to use
- `templates/*.yaml` → create Kubernetes resources based on values.prod.yaml

---

### Phase 1: Build Docker Images

All Docker images must be built **before** deploying to Kubernetes. Run these commands from the repository root directory:

```bash
cd /path/to/ai-inference-platform

# Build app-node (gateway service)
# Copy: app-node/Dockerfile + wrk-base/ + app-node/
docker build -f app-node/Dockerfile -t myregistry/ai-app-node:0.0.2 .

# Build UI console (frontend)
# Copy: ui-console/Dockerfile + ui-console/src/ + ui-console/package.json
docker build -f ui-console/Dockerfile -t myregistry/ai-ui-console:0.0.2 .

# Build wrk-ork (orchestrator)
# Copy: wrk-ork/Dockerfile + wrk-base/ + wrk-ork/
docker build -f wrk-ork/Dockerfile -t myregistry/ai-wrk-ork:0.0.2 .

# Build wrk-inference (inference worker)
# Copy: wrk-inference/Dockerfile + wrk-base/ + wrk-inference/
docker build -f wrk-inference/Dockerfile -t myregistry/ai-wrk-inference:0.0.2 .

# Build wrk-model (model worker)
# Copy: wrk-model/Dockerfile + wrk-base/ + wrk-model/
docker build -f wrk-model/Dockerfile -t myregistry/ai-wrk-model:0.0.2 .
```

### Phase 1.1: Linux vs macOS/Apple Silicon Dockerfile behavior

Backend Dockerfiles now include both command variants (one commented, one active) so builds are explicit by platform:

- Linux (x86_64): keep minimal system packages and use prebuilt native addons when available.
- macOS/Apple Silicon with Minikube (linux/arm64): install build toolchain and force native addon build from source.

The pattern used in backend Dockerfiles is:

```dockerfile
# Linux (x86_64) path: prebuilt native addons usually work, so minimal packages are enough.
# RUN apt-get update \
#   && apt-get install -y --no-install-recommends git ca-certificates \
#   && rm -rf /var/lib/apt/lists/*
# macOS/Apple Silicon -> Minikube linux/arm64 path: include toolchain for native addon builds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ cmake \
  && rm -rf /var/lib/apt/lists/*

# Linux (x86_64) path: uses prebuilt native addons when available.
# RUN npm install --omit=dev --workspace wrk-base --workspace <service>
# macOS/Apple Silicon -> Minikube linux/arm64 path: force native build from source.
RUN npm_config_build_from_source=true npm install --omit=dev --workspace wrk-base --workspace <service> \
  && npm rebuild rocksdb-native --build-from-source
```

If you are building directly inside Minikube on macOS/Apple Silicon, prefer:

```bash
minikube image build -t wrk-inference:0.0.2 -f wrk-inference/Dockerfile .
minikube image build -t wrk-model:0.0.2 -f wrk-model/Dockerfile .
minikube image build -t wrk-ork:0.0.2 -f wrk-ork/Dockerfile .
minikube image build -t app-node:0.0.2 -f app-node/Dockerfile .
minikube image build -t ui-console:0.0.2 -f ui-console/Dockerfile .
```

**Replace `myregistry` with your Docker registry** (e.g., `docker.io/mycompany`, `gcr.io/myproject`, or local `localhost:5000` for local testing).

Push all images to your registry:

```bash
docker push myregistry/ai-app-node:0.0.2
docker push myregistry/ai-ui-console:0.0.2
docker push myregistry/ai-wrk-ork:0.0.2
docker push myregistry/ai-wrk-inference:0.0.2
docker push myregistry/ai-wrk-model:0.0.2
```

### Phase 2: Generate Secrets

Generate random secrets for authentication:

```bash
# Generate APP_SIGNUP_SECRET (64 hex characters)
SIGNUP_SECRET=$(openssl rand -hex 64)
echo "SIGNUP_SECRET: $SIGNUP_SECRET"

# Generate APP_TOKEN_SECRET (64 hex characters)
TOKEN_SECRET=$(openssl rand -hex 64)
echo "TOKEN_SECRET: $TOKEN_SECRET"
```

**Save these values** — you'll need them in Phase 3.

### Phase 3: Create values file

Copy `values.yaml` to a new file for your deployment environment:

```bash
# Copy the default values as a starting point
cp .helm/values.yaml .helm/values.prod.yaml
```

Edit `.helm/values.prod.yaml` and update **at minimum** these sections:

#### 3.1: Set image repositories and tags

```yaml
# At the top of values.prod.yaml, under each service:

ui:
  image:
    repository: myregistry/ai-ui-console # ← CHANGE THIS
    tag: 0.0.2 # ← Match your build tag

appNode:
  image:
    repository: myregistry/ai-app-node # ← CHANGE THIS
    tag: 0.0.2

ork:
  image:
    repository: myregistry/ai-wrk-ork # ← CHANGE THIS
    tag: 0.0.2

inference:
  image:
    repository: myregistry/ai-wrk-inference # ← CHANGE THIS
    tag: 0.0.2

model:
  image:
    repository: myregistry/ai-wrk-model # ← CHANGE THIS
    tag: 0.0.2
```

#### 3.2: Set authentication secrets

```yaml
appNode:
  auth:
    signupSecret: "PASTE_YOUR_SIGNUP_SECRET_HERE" # ← From Phase 2
    tokenSecret: "PASTE_YOUR_TOKEN_SECRET_HERE" # ← From Phase 2
    tokenTtlSeconds: 86400
    protectedRoutes: true
```

#### 3.3: (Optional) Set HuggingFace token

```yaml
model:
  hfToken: "hf_YOUR_HUGGINGFACE_TOKEN_HERE" # ← Leave empty if not using HF models
```

#### 3.4: Configure ingress (for external access)

```yaml
ingress:
  enabled: true # ← Change to true to expose
  className: nginx # ← Use your cluster's ingress class
  host: ai.example.com # ← Your domain
  annotations: {}
  tls: []
```

#### 3.5: Configure persistence (optional but recommended)

```yaml
appNode:
  persistence:
    enabled: true
    size: 2Gi
    storageClassName: "" # ← Leave empty for default storage class

ork:
  persistence:
    enabled: true
    size: 2Gi

inference:
  persistence:
    enabled: true
    size: 2Gi

model:
  persistence:
    enabled: true
    size: 10Gi
```

### Phase 4: Deploy with Helm

Before running the initial `helm install`, ensure you've set `appNode.auth.signupSecret` and `appNode.auth.tokenSecret` in `.helm/values.prod.yaml` (generated in Phase 2).

Also ensure the one-time rack registration job is disabled for the initial install so the cluster can start and generate RPC keys. In your values file set:

```yaml
# For the initial install (do NOT register racks yet)
registerRacks:
  enabled: false
```

Install the chart (pods will start and each worker will print its `rpcPublicKey` in logs):
Create the namespace and install the chart:

```bash
# Create namespace
kubectl create namespace ai-platform

# Install Helm release
helm install ai-platform ./.helm \
  -n ai-platform \
  -f ./.helm/values.prod.yaml
```

Verify the deployment:

```bash
# Check all pods are running
kubectl get pods -n ai-platform

# Check services
kubectl get svc -n ai-platform

# Check persistent volumes
kubectl get pvc -n ai-platform
```

### Phase 5: Configure RPC Keys (recommended flow for multi-rack setups)

After the pods are running , retrieve RPC public keys.

Pod name guidance — use these placeholders when collecting RPC keys. Do not run automated searches; pick the pod name that matches your cluster output.

- Model pod (StatefulSet, default 1 replica): `<model-rack-1>` or the statefulset pod name that ends with `-wrk-model-0`.
- Inference pods (StatefulSet, default 2 replicas): `<inference-rack-1>` and `<inference-rack-2>` or pod names ending with `-wrk-inference-0` and `-wrk-inference-1`.
- Ork pod (Deployment, usually 1 replica): `<wrk-ork>` or the deployment pod name containing `wrk-ork` or `ork`.

Example commands (replace placeholders with the exact pod names from `kubectl get pods -n ai-platform`):

```bash
# List pods to see exact names
kubectl get pods -n ai-platform

# View model pod logs (replace <model-pod>)
kubectl logs -n ai-platform <model-pod> --tail=200

# View inference pod logs (replace <inference-pod-1> and <inference-pod-2>)
kubectl logs -n ai-platform <inference-pod-1> --tail=200
kubectl logs -n ai-platform <inference-pod-2> --tail=200

# View ork pod logs (replace <ork-pod>)
kubectl logs -n ai-platform <ork-pod> --tail=200
```

Inspect the logs you opened for the `rpcPublicKey` lines and copy those values into `.helm/values.prod.yaml`:

```yaml
rpc:
  orkRpcPublicKey: "PASTE_ORK_RPC_KEY_HERE"

inference:
  modelWorkerRpcKey: "PASTE_MODEL_RPC_KEY_HERE"
```

One-time rack registration (after keys are added): enable the registration job, run a `helm upgrade` to register all racks once, then disable the job for future upgrades (registration is a one-time operation).

```bash
# 1) Enable registration in values file
registerRacks.enabled: true

# 2) Upgrade to run the registration job
helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml

# 3) Wait for the register job to complete and verify
kubectl get jobs -n ai-platform
kubectl logs -n ai-platform job/register-racks -f --tail=200 || true

# 4) Disable registration again (prevent re-registration on future upgrades)
# set registerRacks.enabled: false in values.prod.yaml
```

Why this flow? Registering racks is a one-time action that binds a generated RPC public key to an external registry. Running it before keys exist or repeatedly for each upgrade can cause confusion — therefore the recommended flow is: start pods with registration disabled, collect keys, enable registration once to perform the one-time registration, then disable for subsequent upgrades.

## RPC Keys Explained

**What are RPC keys?** Each worker service (ork, inference, model) generates a unique `rpcPublicKey` when it starts. These are public identifiers used to identify and connect to each service within the RPC network.

**When do you need them?**

- `rpc.orkRpcPublicKey`: Required by app-node to contact the orchestrator
- `inference.modelWorkerRpcKey`: Required by wrk-inference to contact the model service

**How to get them:**

1. After deployment, check pod logs for the public key output
2. Extract the key value from the logs
3. Add to your values file
4. Upgrade the chart — **app-node restarts automatically** to pick up the new key

**Example workflow:**

```bash
# Check ork pod logs for rpcPublicKey
kubectl logs -n ai-platform deployment/ai-platform-ai-inference-platform-wrk-ork | grep rpcPublicKey

# Output should look like:
# "rpcPublicKey":"63ab796831e1bab1e047fa7a066f498dbeaeac9e6d59b61a1ded0001bdd21b2d"

# Then add to values.prod.yaml:
# rpc:
#   orkRpcPublicKey: "63ab796831e1bab1e047fa7a066f498dbeaeac9e6d59b61a1ded0001bdd21b2d"

# Upgrade — app-node pod will automatically roll to pick up the new key
helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml

# Wait for rollout
kubectl rollout status deployment/ai-platform-ai-inference-platform-app-node -n ai-platform
```

> **Why do app-node and wrk-inference restart automatically?** Both services mount their ConfigMaps using `subPath`, which Kubernetes does **not** hot-reload. To work around this, `app-node-deployment.yaml` and `inference-statefulset.yaml` each include a `checksum/config` annotation on their pod templates. When ConfigMap content changes (triggered by a values change), the checksum changes, Kubernetes detects a new pod spec, and performs a rolling restart automatically.

**Getting `modelWorkerRpcKey` (for wrk-inference):**

```bash
# Check model pod logs for rpcPublicKey
kubectl logs -n ai-platform statefulset/ai-platform-ai-inference-platform-wrk-model | grep rpcPublicKey

# Output should look like:
# "rpcPublicKey":"664c3273336463f9c94afe97d22a1e15ef46b76f1889747cd30a4604169c7903"

# Then add to values.prod.yaml:
# inference:
#   modelWorkerRpcKey: "664c3273336463f9c94afe97d22a1e15ef46b76f1889747cd30a4604169c7903"

# Upgrade — wrk-inference pods will automatically roll to pick up the new key
helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml

# Wait for rollout
kubectl rollout status statefulset/ai-platform-ai-inference-platform-wrk-inference -n ai-platform
```

## ## Reference: values.yaml Keys

### Global settings

```yaml
global:
  env: development # "development" or "production"
  debug: true # Enable debug logging
  imagePullPolicy: IfNotPresent # Image pull policy
```

### UI service

```yaml
ui:
  enabled: true
  replicaCount: 1 # Number of web frontend replicas
  image:
    repository: myregistry/ai-ui-console # Full image path
    tag: 0.0.2
  service:
    type: ClusterIP # Or LoadBalancer for direct access
    port: 80
```

### App-node (API gateway)

```yaml
appNode:
  replicaCount: 1
  image:
    repository: myregistry/ai-app-node
    tag: 0.0.2
  inference:
    maxInFlight: 1 # API backpressure guard
    defaultMaxTokens: 48 # Used when client does not send max_tokens
    maxTokensCap: 48 # Hard cap for incoming max_tokens
  service:
    type: ClusterIP
    port: 3000
  auth:
    signupSecret: "hex-string" # 64 random hex chars
    tokenSecret: "hex-string" # 64 random hex chars
    tokenTtlSeconds: 86400 # JWT expiry in seconds
    protectedRoutes: true # Require auth for all routes
    sharedStoreDir: "" # Custom store directory
    existingSecret: "" # Use existing k8s Secret instead
  persistence:
    enabled: true
    size: 2Gi
    storageClassName: "" # Leave empty for default
```

### Ork (orchestrator)

```yaml
ork:
  replicaCount: 1 # Usually stays at 1
  image:
    repository: myregistry/ai-wrk-ork
    tag: 0.0.2
  cluster: 1 # Cluster ID
  persistence:
    enabled: true
    size: 2Gi
    storageClassName: ""
```

### Inference worker

```yaml
inference:
  replicas: 2 # Number of inference worker pods
  image:
    repository: myregistry/ai-wrk-inference
    tag: 0.0.2
  rackPrefix: inference-rack- # ← pod 0 = inference-rack-1, pod 1 = inference-rack-2, etc.
  modelWorkerRpcKey: "" # RPC key to model service (from Phase 5)
  modelRequestTimeoutMs: 180000 # Timeout for inference -> model RPC calls
  persistence:
    enabled: true
    size: 2Gi
    storageClassName: ""
```

### Model worker

```yaml
model:
  replicas: 1 # Number of model worker pods
  image:
    repository: myregistry/ai-wrk-model
    tag: 0.0.2
  rackPrefix: model-rack- # ← pod 0 = model-rack-1, pod 1 = model-rack-2, etc.
  resources:
    requests:
      memory: 3Gi
      cpu: 2000m
    limits:
      memory: 8Gi
      cpu: 8000m
  hfToken: "hf_..." # HuggingFace token (optional)
  existingSecret: "" # Use existing k8s Secret instead
  persistence:
    enabled: true
    size: 10Gi
    storageClassName: ""
```

### RPC configuration

```yaml
rpc:
  orkRpcPublicKey: "" # RPC public key from ork pod (from Phase 5)
```

### Ingress (optional, for external access)

```yaml
ingress:
  enabled: false # Set to true to expose services
  className: nginx # Your ingress controller class
  host: ai.example.com # Your domain
  annotations: {}
  tls: []
```

### Rack registration job (optional)

```yaml
registerRacks:
  # Default: disabled for initial install. Enable only for the one-time
  # registration pass after RPC keys have been collected.
  enabled: false
  image:
    repository: node
    tag: 20-bookworm-slim
  timeoutMs: 10000
  inferenceRacks:
    - id: inference-rack-1
      rpcPublicKey: ""
    - id: inference-rack-2
      rpcPublicKey: ""
  modelRackId: model-rack-1
  modelRpcPublicKey: ""
```

Set one entry in `registerRacks.inferenceRacks` per inference rack. By default this chart runs 2 inference pods, so the defaults include `inference-rack-1` and `inference-rack-2`.

---

## Ollama provider & model registration (optional)

If you plan to run Ollama as a local model provider, follow this flow:

- Deploy or enable Ollama in your cluster (either via this chart if supported, or as a separate deployment).
- Make sure racks are already registered (see the one-time registration flow above). Keep `registerRacks.enabled: false` for Helm upgrades after registration.
- Wait for the Ollama pod to reach `Running`.

Example commands to interact with the Ollama pod:

```bash
# List pods and find the Ollama pod name
kubectl get pods -n ai-platform

# Pick the Ollama pod (replace <ollama-pod> with the actual name)
kubectl exec -it -n ai-platform <ollama-pod> -- /bin/sh

# Inside the Ollama container you can pull or add a model, for example:
ollama pull <model-name>
# or run/serve a model file
ollama serve <model-file> --model <model-name> &

# Verify available models
ollama models
```

Register the model with the AI Inference Platform:

- Use the Admin UI (`Admin → Models`) to add and register the model, pointing to the Ollama-backed model rack.
- Or use the app-node admin API (the Admin UI uses the same API) to POST model metadata and binding information.

After registering the model, test an inference request via the UI or a curl to `app-node`.

---

## Support & Next Steps

- For detailed setup instructions, see [README.md](../README.md) (local dev guide)
- For cloud deployment specifics, see [CLOUD-DEPLOYMENT-README.md](../CLOUD-DEPLOYMENT-README.md)
- For Kubernetes best practices: [Kubernetes Documentation](https://kubernetes.io/docs/)
- For Helm best practices: [Helm Documentation](https://helm.sh/docs/)

## Secret & Configuration Management

### How secrets are stored

Kubernetes stores secrets separately from your values file for security. When you set them in values.prod.yaml, Helm automatically creates Kubernetes Secret objects:

```yaml
# In .helm/values.prod.yaml:
appNode:
  auth:
    signupSecret: "your-secret-here"
    tokenSecret: "your-secret-here"
```

↓ Helm converts this to ↓

```yaml
# Kubernetes Secret (created by secret-auth.yaml template):
apiVersion: v1
kind: Secret
metadata:
  name: ai-platform-auth
type: Opaque
data:
  APP_SIGNUP_SECRET: <encoded>
  APP_TOKEN_SECRET: <encoded>
```

### Using existing Kubernetes Secrets

If you already have secrets in your cluster, reference them instead:

```yaml
appNode:
  auth:
    existingSecret: my-existing-auth-secret
    signupSecret: ""
    tokenSecret: ""
```

**Important:** When using `existingSecret`, leave the individual secret fields empty.

### Checking secrets in cluster

```bash
# List all secrets in namespace
kubectl get secrets -n ai-platform

# View auth secret keys (not values, for security)
kubectl describe secret ai-platform-auth -n ai-platform

# View actual value (use carefully - contains sensitive data)
kubectl get secret ai-platform-auth -n ai-platform -o jsonpath='{.data.APP_TOKEN_SECRET}' | base64 -d
```

## Scaling Services

Modify replica counts in your values file to scale services up or down:

```yaml
# In .helm/values.prod.yaml:

ui:
  replicaCount: 2 # Scale web frontend: 1 (default) → N replicas

appNode:
  replicaCount: 3 # Scale API gateway: 2 (default) → N replicas

ork:
  replicaCount: 1 # Orchestrator: usually stays at 1

inference:
  replicas:
    4 # Scale inference: 2 (default) → N replicas
    # Each pod gets a rack assignment (inference-rack-1, inference-rack-2, etc.)

model:
  replicas:
    2 # Scale model workers: 1 (default) → N replicas
    # Each pod gets a rack assignment (model-rack-1, model-rack-2, etc.)
```

Apply scaling changes:

```bash
helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml
```

Watch the new pods start:

```bash
kubectl get pods -n ai-platform -w
```

## Common Operations

### Update a secret without rebuilding images

```bash
# Edit your values file with new secret value
nano .helm/values.prod.yaml
#
# Change:
# appNode:
#   auth:
#     tokenSecret: "new-secret-value"

# Apply the change
helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml

# Pods will restart automatically with new secrets
kubectl get pods -n ai-platform -w
```

### Update a config value

Same process as secrets — edit values.prod.yaml and run `helm upgrade`.

> **Note on ConfigMap mounts:** Kubernetes does not automatically reload files mounted via `subPath` when a ConfigMap changes. Both `app-node` and `wrk-inference` handle this with a `checksum/config` pod annotation — `helm upgrade` will automatically roll those pods whenever their ConfigMap content changes. No manual restart needed.

### View current deployment configuration

```bash
# Get values currently deployed
helm get values ai-platform -n ai-platform

# Get all rendered templates (what was actually deployed)
helm get manifest ai-platform -n ai-platform
```

### Check pod logs for errors

```bash
# View logs for a specific pod
kubectl logs -n ai-platform <pod-name>

# Follow logs in real-time
kubectl logs -n ai-platform <pod-name> -f

# View logs from all pods of a service
kubectl logs -n ai-platform -l app.kubernetes.io/component=wrk-inference
```

### Rollback to previous deployment

```bash
# List deployment history
helm history ai-platform -n ai-platform

# Rollback to previous version
helm rollback ai-platform 1 -n ai-platform
```

## Troubleshooting

### Pods stuck in Pending state

**Symptom:** `kubectl get pods` shows `Pending`

**Cause:** Usually storage (PVC) or resource constraints.

```bash
# Check events for details
kubectl describe pod <pod-name> -n ai-platform

# Check PVC availability
kubectl get pvc -n ai-platform

# If PVC is stuck, check storage class
kubectl get storageclass
```

**Solution:**

- Ensure your cluster has a default storage class: `kubectl get storageclass`
- Or explicitly set `storageClassName` in values.prod.yaml

### Image pull failures

**Symptom:** Pod status shows `ImagePullBackOff` or `ErrImagePull`

**Cause:** Wrong image path or registry credentials.

**Solution:**

1. Verify image repositories in values.prod.yaml
2. Ensure images are pushed to registry: `docker push myregistry/ai-app-node:0.0.2`
3. If private registry, add image pull secrets to values.yaml

### Pods crashing immediately

**Symptom:** Pod status shows `CrashLoopBackOff`

**Solution:**

1. Check pod logs: `kubectl logs <pod-name> -n ai-platform`
2. Common issues:
   - Missing secrets: verify `secret-auth.yaml` was created
   - Wrong RPC keys: check `rpc.orkRpcPublicKey` value
   - Config file mount errors: check ConfigMap contents

```bash
# Verify ConfigMap was created
kubectl get configmap -n ai-platform

# Check ConfigMap contents
kubectl get configmap ai-platform-app-node -n ai-platform -o yaml
```

### Services cannot communicate

**Symptom:** Timeout errors between pods

**Solution:**

1. Verify service endpoints: `kubectl get endpoints -n ai-platform`
2. Check DNS resolution inside a pod:

```bash
# Connect to a pod
kubectl exec -it <pod-name> -n ai-platform -- sh

# Inside pod, test DNS:
nslookup ai-platform-wrk-ork
curl http://ai-platform-app-node:3000/health
```

### Persistent volume full

**Symptom:** Pod errors about disk space

**Solution:**

1. Check PVC usage: `kubectl describe pvc <pvc-name> -n ai-platform`
2. Increase size in values.prod.yaml (requires manual PV expansion or recreating PVC)
3. Clean old data if safe to do so

### Helm deployment fails

**Symptom:** `helm upgrade` returns errors

**Solution:**

1. Validate syntax: `helm lint ./.helm`
2. Dry-run to see what will be deployed: `helm upgrade ai-platform ./.helm -n ai-platform -f ./.helm/values.prod.yaml --dry-run`
3. Check for YAML syntax errors in values.prod.yaml (indent, quotes, etc.)

## Verification Checklist

After deploying, verify everything is working:

```bash
# 1. All pods running
kubectl get pods -n ai-platform
# Expected: All pods should show "Running" status

# 2. Services have endpoints
kubectl get svc -n ai-platform
# Expected: Each service should show ClusterIP and port

# 3. PVCs bound (if persistence enabled)
kubectl get pvc -n ai-platform
# Expected: All should show "Bound" status

# 4. ConfigMaps created
kubectl get configmap -n ai-platform
# Expected: Should see ai-platform-app-node and ai-platform-inference

# 5. Secrets created
kubectl get secret -n ai-platform
# Expected: Should see ai-platform-auth and ai-platform-model

# 6. Ports are accessible (if using port-forward)
kubectl port-forward -n ai-platform svc/ai-platform-app-node 3000:3000
# Then: curl http://localhost:3000/health

# 7. UI is accessible (if ingress enabled)
# Navigate to your ingress host (from values.prod.yaml ingress.host)
```

## Ingress routing for UI + API

When `ingress.enabled=true`, the chart creates:

- `ui-ingress`: routes `/` to the UI service
- `api-ingress`: routes `/api/*` to `app-node` and rewrites to backend paths (`/auth`, `/models`, `/inference`, ...)

The UI uses `/api` as its default API base path, so this ingress split works without rebuilding the frontend image.
