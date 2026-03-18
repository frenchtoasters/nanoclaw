# Kubernetes Deployment Guide

This fork replaces NanoClaw's local Docker + SQLite architecture with Kubernetes-native execution and PostgreSQL. Agents run as K8s Jobs instead of local containers, IPC uses Postgres LISTEN/NOTIFY instead of filesystem polling, and all state lives in PostgreSQL.

## Architecture Changes

```
Original:  Channels --> SQLite --> Polling loop --> Docker container --> Response (filesystem IPC)
K8s fork:  Channels --> PostgreSQL --> Polling loop --> K8s Job --> Response (PG LISTEN/NOTIFY)
```

| Component        | Original                                      | K8s Fork                                      |
| ---------------- | --------------------------------------------- | --------------------------------------------- |
| Database         | SQLite (file-based)                           | PostgreSQL (connection pool)                  |
| Agent execution  | Docker containers via `child_process.spawn()` | K8s Jobs via `@kubernetes/client-node`        |
| IPC              | Filesystem polling (`data/ipc/*.json`)        | Postgres LISTEN/NOTIFY + `ipc_commands` table |
| Task scheduling  | Internal poll loop                            | Internal poll loop + K8s Job per task run     |
| Secrets          | `.env` file + credential proxy                | K8s Secrets (`nanoclaw-llm`, `nanoclaw-db`)   |
| Concurrency      | Process-level (`ChildProcess`)                | Job-level (`registerJob` tracking)            |
| Group storage    | Local filesystem                              | RWX PersistentVolumeClaims                    |
| Config injection | Docker volume mount of `CLAUDE.md`            | ConfigMap per group                           |

## Prerequisites

- Kubernetes cluster (1.25+) — EKS, GKE, AKS, or local (minikube/kind)
- `kubectl` configured for your cluster
- Container registry accessible from the cluster
- RWX-capable StorageClass (EFS on AWS, Filestore on GCP, NFS on bare metal)

## Quick Start

### 1. Create the namespace and RBAC

```bash
kubectl apply -k k8s/
```

This creates:

- `nanoclaw` namespace
- `nanoclaw-orchestrator` ServiceAccount with a Role granting access to Jobs, CronJobs, Pods, Pods/log, ConfigMaps, Secrets, and PVCs
- PostgreSQL StatefulSet (single replica, 5Gi PVC)
- Orchestrator Deployment (single replica)
- 3 workspace PVCs: `global-pvc` (RWX, 5Gi), `groups-pvc` (RWX, 1Gi), `store-pvc` (RWO, 1Gi)

### 2. Configure Secrets

Two Secrets are required:

```bash
# LLM provider API key
kubectl create secret generic nanoclaw-llm \
  --namespace=nanoclaw \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-...' \
  --dry-run=client -o yaml | kubectl apply -f -

# Database connection (if using the bundled StatefulSet)
kubectl create secret generic nanoclaw-db \
  --namespace=nanoclaw \
  --from-literal=DATABASE_URL='postgresql://postgres:changeme@postgres.nanoclaw.svc.cluster.local:5432/nanoclaw' \
  --from-literal=POSTGRES_USER='postgres' \
  --from-literal=POSTGRES_PASSWORD='changeme' \
  --dry-run=client -o yaml | kubectl apply -f -
```

> **Production:** Use a managed database (RDS, Cloud SQL, etc.) instead of the bundled StatefulSet. Remove `statefulset-postgres.yaml` from `k8s/kustomization.yaml` and point `DATABASE_URL` at your managed instance.

### 3. Set your StorageClass

Edit `k8s/pvc-workspace.yaml` — uncomment and set `storageClassName` for your cluster:

| Provider  | StorageClass   | Notes                                    |
| --------- | -------------- | ---------------------------------------- |
| AWS EKS   | `efs-sc`       | Requires EFS CSI driver                  |
| GCP GKE   | `standard-rwx` | Filestore CSI driver                     |
| Azure AKS | `azurefile`    | Azure File share                         |
| Minikube  | `standard`     | Only supports RWO — use hostPath for dev |

### 4. Build and push container images

```bash
# Orchestrator image
docker build -t your-registry/nanoclaw-orchestrator:latest .
docker push your-registry/nanoclaw-orchestrator:latest

# Agent image (used for K8s Jobs)
docker build -t your-registry/nanoclaw-agent:latest -f container/Dockerfile .
docker push your-registry/nanoclaw-agent:latest
```

Update the image references in `k8s/deployment-orchestrator.yaml`:

- `spec.template.spec.containers[0].image` → your orchestrator image
- `AGENT_IMAGE` env var → your agent image

### 5. Apply and verify

```bash
kubectl apply -k k8s/

# Wait for PostgreSQL to be ready
kubectl wait --for=condition=ready pod -l component=postgres -n nanoclaw --timeout=120s

# Wait for orchestrator
kubectl wait --for=condition=ready pod -l component=orchestrator -n nanoclaw --timeout=120s

# Check logs
kubectl logs -l component=orchestrator -n nanoclaw -f
```

## Environment Variables

All config is via environment variables on the orchestrator Deployment.

### Required

| Variable       | Description                        | Default                                |
| -------------- | ---------------------------------- | -------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string       | `postgresql://localhost:5432/nanoclaw` |
| `AGENT_IMAGE`  | Container image for agent K8s Jobs | `nanoclaw-agent:latest`                |

### Kubernetes

| Variable                    | Description                      | Default                                     |
| --------------------------- | -------------------------------- | ------------------------------------------- |
| `K8S_NAMESPACE`             | Namespace for Jobs and resources | `nanoclaw` (auto-detected via Downward API) |
| `JOB_TTL_SECONDS`           | TTL for completed/failed Jobs    | `600` (10 min)                              |
| `JOB_ACTIVE_DEADLINE`       | Max runtime for a single Job     | `1800` (30 min)                             |
| `JOB_CPU_REQUEST`           | CPU request per agent Job        | `250m`                                      |
| `JOB_CPU_LIMIT`             | CPU limit per agent Job          | `1000m`                                     |
| `JOB_MEMORY_REQUEST`        | Memory request per agent Job     | `256Mi`                                     |
| `JOB_MEMORY_LIMIT`          | Memory limit per agent Job       | `1Gi`                                       |
| `MAX_CONCURRENT_CONTAINERS` | Max concurrent agent Jobs        | `5`                                         |

### Application

| Variable             | Description                  | Default                       |
| -------------------- | ---------------------------- | ----------------------------- |
| `ASSISTANT_NAME`     | Trigger name (e.g. `@Andy`)  | `Andy`                        |
| `ANTHROPIC_BASE_URL` | LLM endpoint override        | _(empty = default Anthropic)_ |
| `CONTAINER_TIMEOUT`  | Agent timeout (ms)           | `1800000` (30 min)            |
| `IDLE_TIMEOUT`       | Idle timeout (ms)            | `1800000` (30 min)            |
| `TZ`                 | Timezone for cron scheduling | `UTC`                         |

## Volume Architecture

Agent Jobs get these mounts:

| Mount Path           | Source                                  | Access                    | Purpose                   |
| -------------------- | --------------------------------------- | ------------------------- | ------------------------- |
| `/workspace/group`   | PVC `{groupFolder}-pvc`                 | RW                        | Group-specific workspace  |
| `/workspace/global`  | PVC `global-pvc`                        | RO (non-main) / RW (main) | Shared data across groups |
| `/home/node/.claude` | ConfigMap `{groupFolder}-claude-config` | RO                        | `CLAUDE.md` and settings  |

The orchestrator reads group `CLAUDE.md` files from the `groups-pvc` mount and creates/updates a ConfigMap for each group before launching a Job.

## RBAC

The `nanoclaw-orchestrator` ServiceAccount has the minimum permissions needed:

| Resource                 | Verbs                                              | Purpose                   |
| ------------------------ | -------------------------------------------------- | ------------------------- |
| `batch/jobs`             | create, get, list, watch, delete, deletecollection | Agent Job lifecycle       |
| `batch/cronjobs`         | create, get, list, watch, update, delete           | Scheduled tasks           |
| `pods`                   | get, list, watch                                   | Job pod status            |
| `pods/log`               | get                                                | Read agent output         |
| `configmaps`             | create, get, update, patch, delete                 | Group CLAUDE.md injection |
| `secrets`                | get, list                                          | Verify secrets exist      |
| `persistentvolumeclaims` | create, get, list, watch, delete                   | Custom volume skill       |

## How Agent Jobs Work

1. A message arrives via a channel (WhatsApp, Telegram, etc.)
2. The orchestrator formats the message and creates a `ContainerInput`
3. The orchestrator ensures a ConfigMap exists with the group's `CLAUDE.md`
4. A K8s Job is created with:
   - Environment variables: group context, chat JID, input text, session ID
   - Secrets: `ANTHROPIC_API_KEY` from `nanoclaw-llm`, `DATABASE_URL` from `nanoclaw-db`
   - Volume mounts: group PVC, global PVC, CLAUDE.md ConfigMap
   - Resource limits, TTL, and active deadline
   - Labels: `app=nanoclaw-agent`, `group={groupFolder}`
5. The orchestrator polls the Job status every 2 seconds
6. On completion, it reads the pod logs and parses the response between `---OUTPUT_START---` and `---OUTPUT_END---` markers
7. The response is routed back through the channel
8. Completed Jobs are cleaned up by K8s TTL (default 10 minutes)

## IPC (Inter-Process Communication)

Agent Jobs communicate with the orchestrator via PostgreSQL:

1. Agent Jobs write commands to the `ipc_commands` table (task scheduling, group registration, etc.)
2. The orchestrator listens for `NOTIFY ipc` events on a dedicated PostgreSQL connection
3. A 30-second fallback poll catches any missed notifications
4. Commands are processed in order and marked as processed

This replaces the filesystem-based IPC (`data/ipc/*.json`) used in the Docker version.

## Production Considerations

### Use a managed database

The bundled PostgreSQL StatefulSet is fine for development. For production, use a managed service:

- **AWS:** RDS for PostgreSQL
- **GCP:** Cloud SQL for PostgreSQL
- **Azure:** Azure Database for PostgreSQL

Remove `statefulset-postgres.yaml` from `k8s/kustomization.yaml` and update the `nanoclaw-db` Secret with the managed instance connection string.

### Cloud Identity (optional)

For clusters that need cloud service access (S3, GCS, etc.) without static credentials:

- **AWS EKS:** Use IAM Roles for Service Accounts (IRSA)
- **GCP GKE:** Use Workload Identity

Run `/k8s-cloud-identity` for step-by-step guidance with the CLI commands needed.

### Scaling considerations

- The orchestrator runs as a **single replica** — no leader election is implemented
- Agent Jobs scale horizontally up to `MAX_CONCURRENT_CONTAINERS`
- Job sprawl is mitigated by `JOB_TTL_SECONDS` and `cleanupOrphanJobs()` on startup
- OOMKilled/evicted Jobs are detected by the orchestrator's job watcher with timeout

### Monitoring

```bash
# Active agent Jobs
kubectl get jobs -l app=nanoclaw-agent -n nanoclaw

# Orchestrator logs
kubectl logs -l component=orchestrator -n nanoclaw -f

# Failed Jobs
kubectl get jobs -l app=nanoclaw-agent -n nanoclaw --field-selector status.successful=0
```

## Skills

| Skill                 | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `/k8s-setup-secrets`  | Create or rotate `nanoclaw-llm` and `nanoclaw-db` Secrets |
| `/k8s-cloud-identity` | AWS IRSA / GCP Workload Identity setup guidance           |
| `/k8s-create-volume`  | Create PVCs and configure custom volume mounts            |

## Differences from Upstream NanoClaw

This fork intentionally does **not** change:

- `src/router.ts` — message formatting and outbound routing
- `src/channels/` — channel registration and message handling
- `src/types.ts` — core interfaces
- Group `CLAUDE.md` memory model

This fork **replaces**:

- `better-sqlite3` → `pg` (all database functions are now async)
- Docker container spawning → K8s Job creation via `@kubernetes/client-node`
- Filesystem IPC → PostgreSQL LISTEN/NOTIFY
- Local credential proxy → K8s Secrets
- `ChildProcess` tracking → Job name tracking in `GroupQueue`

## Troubleshooting

**Jobs stuck in Pending:**
Check node resources and image pull status:

```bash
kubectl describe job <job-name> -n nanoclaw
kubectl get events -n nanoclaw --sort-by='.lastTimestamp'
```

**Orchestrator can't create Jobs:**
Verify RBAC:

```bash
kubectl auth can-i create jobs --as=system:serviceaccount:nanoclaw:nanoclaw-orchestrator -n nanoclaw
```

**Database connection failures:**
Check the Secret and PostgreSQL pod:

```bash
kubectl get secret nanoclaw-db -n nanoclaw -o jsonpath='{.data.DATABASE_URL}' | base64 -d
kubectl logs -l component=postgres -n nanoclaw
```

**Agent output not parsed:**
Check that the agent image writes output between `---OUTPUT_START---` and `---OUTPUT_END---` markers to stdout. View raw logs:

```bash
kubectl logs <pod-name> -n nanoclaw
```
