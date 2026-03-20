# Cloud Deployment Guide

This guide covers practical cloud deployment options for the AI Inference Platform, from simple single-VM setups to production-grade Kubernetes deployments.

## Scope

- Services covered: `app-node`, `wrk-ork`, `wrk-inference`, `wrk-model`
- Supports CPU-only and GPU-backed inference/model workers
- Focuses on production deployment patterns, scaling, and reliability

## Deployment Options

## 1) Single VM (Fastest to launch)

Run all services on one cloud VM (for example, EC2, GCE, Azure VM) using Node.js processes (`pm2` or systemd).

Best for:

- Demos
- Internal testing
- Low traffic workloads

Pros:

- Easiest setup
- Lowest operational overhead

Cons:

- Single point of failure
- Limited horizontal scalability

## 2) Multi-VM With Process Managers

Run each service group on separate VMs:

- VM A: `app-node` + `wrk-ork`
- VM B/C: `wrk-inference`
- VM D (GPU optional): `wrk-model`

Best for:

- Early production
- Moderate traffic

Pros:

- Better isolation
- Independent scaling by service type

Cons:

- Manual orchestration and failover
- More operational work than containers

## 3) Containers on One Host (Docker Compose)

Run all services as containers on one larger VM. Use named volumes for stores and bind mounts for config.

Best for:

- Teams moving toward containerized operations
- Staging environments

Pros:

- Reproducible runtime
- Easier dependency management

Cons:

- Still a single host unless expanded manually
- Limited self-healing

## 4) Kubernetes (Recommended for Production)

Deploy each service as separate Deployments (or StatefulSets where persistent local data matters), expose `app-node` via Ingress/LoadBalancer, and use HPA for scale.

Helm chart and deployment instructions are available in [.helm/README.md](.helm/README.md).

Best for:

- Production workloads
- Team-operated platforms with CI/CD

Pros:

- Self-healing and rolling updates
- Horizontal scale per service
- Native service discovery and policy control

Cons:

- Highest setup/ops complexity
- Requires cluster expertise

## 5) Split Plane (Common for AI workloads)

Run control plane services on Kubernetes and model workers on dedicated GPU nodes/VMs:

- Control plane: `app-node`, `wrk-ork`, `wrk-inference`
- Data plane: `wrk-model` on GPU infrastructure

Best for:

- Cost-optimized GPU usage
- Mixed CPU/GPU autoscaling

Pros:

- Better GPU utilization
- Separate scaling and release cadence

Cons:

- More networking/security coordination
- Additional observability requirements

## Option Selection Matrix

| Requirement                            | Suggested Option |
| -------------------------------------- | ---------------- |
| MVP in a day                           | Single VM        |
| Small production traffic               | Multi-VM         |
| Containerized staging                  | Docker Compose   |
| Production reliability and autoscaling | Kubernetes       |
| Heavy GPU workloads                    | Split Plane      |

## Core Cloud Design Decisions

## Networking

- Expose only `app-node` publicly.
- Keep `wrk-ork`, `wrk-inference`, and `wrk-model` on private subnets/networks.
- Restrict east-west traffic with security groups/network policies.

## Secrets

Store these in a managed secret store (not in git):

- `APP_SIGNUP_SECRET`
- `APP_TOKEN_SECRET`
- `HF_TOKEN` (if needed)

Use cloud-native secret managers:

- AWS Secrets Manager / SSM Parameter Store
- GCP Secret Manager
- Azure Key Vault

## Persistence

- Keep local `store/` directories on persistent disks/volumes.
- For shared gateway auth, use a shared filesystem and set `APP_AUTH_SHARED_STORE_DIR`.
- Back up `store/` directories on a schedule.

## Observability

- Ship structured JSON logs to centralized logging.
- Capture metrics: request latency, queue depth, failure rates, model load duration.
- Add alerting on:
  - HTTP 5xx rate
  - queue wait time
  - model worker crash/restart loops

## High Availability Baseline

For production, target at least:

- 2x `app-node` instances behind a load balancer
- `wrk-ork`: typically a single orchestrator instance (replication depends on your orchestration/sharding strategy; run 2 only if your ork supports clustering)
- 2x `wrk-inference` instances (or more depending on throughput)
- 1-2x `wrk-model` instances (or more, depending on model/GPU capacity)

## Example Cloud Mappings

## AWS

- Compute: EC2 / EKS
- Load balancing: ALB/NLB
- Shared auth store: EFS (if shared auth store is required)
- Persistent local stores: EBS
- Secrets: Secrets Manager
- Logs/metrics: CloudWatch + OpenSearch/Grafana stack

## GCP

- Compute: GCE / GKE
- Load balancing: Cloud Load Balancing
- Shared auth store: Filestore
- Persistent local stores: Persistent Disk
- Secrets: Secret Manager
- Logs/metrics: Cloud Logging + Cloud Monitoring

## Azure

- Compute: VMSS / AKS
- Load balancing: Azure Load Balancer / Application Gateway
- Shared auth store: Azure Files
- Persistent local stores: Managed Disks
- Secrets: Key Vault
- Logs/metrics: Azure Monitor + Log Analytics

## Rollout Checklist

1. Provision network, compute, and storage.
2. Configure secrets in a secret manager.
3. Prepare Helm values and pre-install items:

- Fill `appNode.auth.signupSecret` and `appNode.auth.tokenSecret` in `.helm/values.prod.yaml` (do not commit these values).
- Ensure `registerRacks.enabled: false` for the initial Helm install so pods can start and emit their RPC public keys. See `.helm/README.md` for the one-time registration flow: collect `rpcPublicKey` values, enable `registerRacks` once to register racks, then disable it for future upgrades.

4. Deploy `wrk-model` and validate model load.
5. Deploy `wrk-inference` and verify RPC to model worker (default: 2 inference replicas in typical deployments).
6. Deploy `wrk-ork` and register racks (one-time job as noted above).
7. Deploy `app-node` behind a load balancer.
8. Run smoke tests (`/auth/signup`, `/auth/login`, `/inference`, `/inference/:jobId`).
9. Enable backups, dashboards, and alerts.

## Notes

- Start with Multi-VM or Kubernetes based on team maturity.
- Keep deployment topology aligned with your sharding model (per-rack isolated stores + orchestrator ownership index).
- Prefer immutable deployments and automated rollbacks for production changes.
