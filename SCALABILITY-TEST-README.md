# Scalability Test Runbook

Use this runbook to check four things in one pass:

- requests spread across multiple inference racks
- traffic reroutes when a rack is marked down
- premium users prefer the dedicated premium rack
- `app-node` can fail over between orchestrators

## 1) Suggested test topology

This setup gives useful signal without being heavy:

- `wrk-model`: 1 instance (`model-rack-1`)
- shared `wrk-inference`: 3 instances (`inference-rack-1`, `inference-rack-2`, `inference-rack-3`)
- premium `wrk-inference`: 1 instance (`inference-rack-premium-1`)
- `wrk-ork-inference`: 1 instance minimum (2 if you also want ork failover)
- `app-node`: 1 instance

If your model process exits with code `134`, you can still validate routing and failover because `runInference` returns `jobId` and `rackId` right away.

## 2) Start services

Run each service in its own terminal.

### 2.1 Model worker

```bash
cd wrk-model
node worker.js --wtype wrk-model --env development --debug true --rack model-rack-1
```

### 2.2 Shared inference workers

```bash
cd wrk-inference
node worker.js --wtype wrk-inference --env development --debug true --rack inference-rack-1
```

```bash
cd wrk-inference
node worker.js --wtype wrk-inference --env development --debug true --rack inference-rack-2
```

```bash
cd wrk-inference
node worker.js --wtype wrk-inference --env development --debug true --rack inference-rack-3
```

### 2.3 Premium inference worker

```bash
cd wrk-inference
node worker.js --wtype wrk-inference --env development --debug true --rack inference-rack-premium-1
```

### 2.4 Orchestrator

```bash
cd wrk-ork
node worker.js --wtype wrk-ork-inference --env development --cluster 1
```

### 2.5 HTTP gateway

```bash
cd app-node
node worker.js --wtype wrk-node-http --env development --port 3000
```

## 3) Collect RPC keys

From the repo root, pull keys from status files:

```bash
jq -r '.rpcPublicKey' wrk-model/status/wrk-model-model-rack-1.json
jq -r '.rpcPublicKey' wrk-inference/status/wrk-inference-inference-rack-1.json
jq -r '.rpcPublicKey' wrk-inference/status/wrk-inference-inference-rack-2.json
jq -r '.rpcPublicKey' wrk-inference/status/wrk-inference-inference-rack-3.json
jq -r '.rpcPublicKey' wrk-inference/status/wrk-inference-inference-rack-premium-1.json
```

Export them:

```bash
export ORK_KEY="<cluster-1-ork-rpc-key>"
export MODEL_KEY="<model-rack-1-rpc-key>"
export INF1_KEY="<inference-rack-1-rpc-key>"
export INF2_KEY="<inference-rack-2-rpc-key>"
export INF3_KEY="<inference-rack-3-rpc-key>"
export PREM_KEY="<inference-rack-premium-1-rpc-key>"
```

## 4) Register racks

Register model rack:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m registerRack -d '{"id":"model-rack-1","type":"model","info":{"rpcPublicKey":"'"$MODEL_KEY"'"}}' -t 10000
```

Register shared inference racks:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m registerRack -d '{"id":"inference-rack-1","type":"inference","info":{"rpcPublicKey":"'"$INF1_KEY"'","dedicated":false}}' -t 10000
npx --yes hp-rpc-cli -s "$ORK_KEY" -m registerRack -d '{"id":"inference-rack-2","type":"inference","info":{"rpcPublicKey":"'"$INF2_KEY"'","dedicated":false}}' -t 10000
npx --yes hp-rpc-cli -s "$ORK_KEY" -m registerRack -d '{"id":"inference-rack-3","type":"inference","info":{"rpcPublicKey":"'"$INF3_KEY"'","dedicated":false}}' -t 10000
```

Register premium rack:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m registerRack -d '{"id":"inference-rack-premium-1","type":"inference","info":{"rpcPublicKey":"'"$PREM_KEY"'","tier":"premium","dedicated":true,"leaseMs":30000}}' -t 10000
```

Quick verify:

```bash
curl -s 'http://localhost:3000/racks?type=inference' | jq .
```

## 5) Create test users

Use the signup secret from `app-node/config/common.json`:

```bash
export SIGNUP_SECRET="super_secret_token_123"
```

Create users for each role:

```bash
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' -d '{"email":"user.scaling@example.com","password":"secret123","signup_secret":"'"$SIGNUP_SECRET"'","roles":["user"]}' | jq .
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' -d '{"email":"premium.scaling@example.com","password":"secret123","signup_secret":"'"$SIGNUP_SECRET"'","roles":["premium"]}' | jq .
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' -d '{"email":"enterprise.scaling@example.com","password":"secret123","signup_secret":"'"$SIGNUP_SECRET"'","roles":["enterprise"]}' | jq .
```

Login and export tokens:

```bash
export TOKEN_USER="$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"user.scaling@example.com","password":"secret123"}' | jq -r '.token')"
export TOKEN_PREMIUM="$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"premium.scaling@example.com","password":"secret123"}' | jq -r '.token')"
export TOKEN_ENTERPRISE="$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"enterprise.scaling@example.com","password":"secret123"}' | jq -r '.token')"
```

## 6) Run routing and failover checks

### 6.1 Shared-user distribution

Send 120 requests as a normal user:

```bash
for i in $(seq 1 120); do
  curl -s -X POST http://localhost:3000/inference \
    -H "Authorization: Bearer $TOKEN_USER" \
    -H 'Content-Type: application/json' \
    -d '{"modelId":"tinyllama-1.1b","prompt":"scale test user '$i'"}' | jq -r '.rackId'
done | sort | uniq -c
```

What you should see:

- traffic spread across `inference-rack-1`, `inference-rack-2`, and `inference-rack-3`
- premium rack not taking most standard-user traffic

### 6.2 Premium affinity

Send 40 premium-user requests:

```bash
for i in $(seq 1 40); do
  curl -s -X POST http://localhost:3000/inference \
    -H "Authorization: Bearer $TOKEN_PREMIUM" \
    -H 'Content-Type: application/json' \
    -d '{"modelId":"tinyllama-1.1b","prompt":"scale test premium '$i'"}' | jq -r '.rackId'
done | sort | uniq -c
```

What you should see:

- most traffic goes to `inference-rack-premium-1`
- if premium is unavailable, shared fallback still works

### 6.3 Shared rack failover

Mark `inference-rack-1` as down:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m markRackFailure -d '{"id":"inference-rack-1","threshold":1,"error":"manual-failover-test"}' -t 10000
```

Send 40 user requests:

```bash
for i in $(seq 1 40); do
  curl -s -X POST http://localhost:3000/inference \
    -H "Authorization: Bearer $TOKEN_USER" \
    -H 'Content-Type: application/json' \
    -d '{"modelId":"tinyllama-1.1b","prompt":"failover test '$i'"}' | jq -r '.rackId'
done | sort | uniq -c
```

What you should see:

- `inference-rack-1` disappears from routing
- traffic shifts to live shared racks

Bring rack back:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m heartbeatRack -d '{"id":"inference-rack-1"}' -t 10000
```

### 6.4 Premium fallback

Mark premium rack as down:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m markRackFailure -d '{"id":"inference-rack-premium-1","threshold":1,"error":"premium-down"}' -t 10000
```

Send 20 premium requests:

```bash
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:3000/inference \
    -H "Authorization: Bearer $TOKEN_PREMIUM" \
    -H 'Content-Type: application/json' \
    -d '{"modelId":"tinyllama-1.1b","prompt":"premium fallback '$i'"}' | jq -r '.rackId'
done | sort | uniq -c
```

What you should see:

- requests continue to succeed
- traffic lands on shared racks while premium is down

Restore premium rack:

```bash
npx --yes hp-rpc-cli -s "$ORK_KEY" -m heartbeatRack -d '{"id":"inference-rack-premium-1"}' -t 10000
```

## 8) Done criteria

Consider this validation successful when all of the following are true:

- shared-user traffic is distributed across shared racks
- premium traffic prefers dedicated premium rack
- manual rack failure reroutes traffic quickly
- premium traffic falls back cleanly when premium rack is down
