# FLIGHT PLAN: NanoClaw Kubernetes Native Migration

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Ops (Architecture Refactor & Cloud Native Shift)
> **Classification**: Official
> **Flight Director**: Auto-authorized
> **T-Minus**: Immediate

---

## EXECUTIVE SUMMARY

### Mission Objective

> **Primary Objective**: Fork and refactor NanoClaw to operate natively within a Kubernetes cluster, migrating execution to K8s Jobs, storage to RWX PVCs, and state to PostgreSQL.
>
> **Success Criteria**:
>
> - NanoClaw Orchestrator pod successfully provisions Agent K8s Jobs instead of local Docker containers.
> - State is successfully persisted across Postgres and ReadWriteMany (RWX) volumes without locking contention.
> - K8s CronJobs successfully trigger scheduled tasks natively.

### Deliverables

- Fork pointing to `frenchtoasters` remote.
- Kubernetes manifest templates (Deployment, StatefulSet, RBAC, RWX PVC).
- Refactored `container-runner.ts` using `@kubernetes/client-node`.
- Refactored `db.ts` utilizing PostgreSQL.
- Setup skills for Kubernetes Secrets and Cloud Identity configurations.

### Mission Profile

- **Estimated Duration**: Medium
- **Parallel Execution**: YES - 3 waves
- **Flight Phases**: Phase 1 → Phase 2 → Phase 3 → Phase 4

---

## PHASE 1: REQUIREMENTS DEFINITION

### Requirements Traceability Matrix (NASA-STD-8739.8B)

| Req ID  | Requirement Description                                      | Design Component           | Implementation                                   | Test/Verification         | Status |
| ------- | ------------------------------------------------------------ | -------------------------- | ------------------------------------------------ | ------------------------- | ------ |
| REQ-001 | Replace Docker execution with K8s Jobs                       | `container-runner.ts`      | Job creation logic via `@kubernetes/client-node` | Verify `kubectl get jobs` | Open   |
| REQ-002 | Migrate SQLite to PostgreSQL                                 | `db.ts`                    | Postgres driver integration (e.g. pg/knex)       | Integration tests         | Open   |
| REQ-003 | Replace local scheduler with K8s CronJob/Job                 | `task-scheduler.ts`        | K8s native scheduler translation                 | Verify CronJob manifests  | Open   |
| REQ-004 | Use RWX PVC for `/workspace/group`                           | Deployment YAMLs           | VolumeMounts in Orchestrator and Jobs            | R/W verification test     | Open   |
| REQ-005 | Inject image tags via ENV, rely on in-cluster ServiceAccount | Orchestrator Config        | `config.ts` mapping                              | Startup validation        | Open   |
| REQ-006 | Skill: Setup K8s Auth Secrets                                | `skills/kubernetes.ts`     | Secret creation via API                          | Skill execution test      | Open   |
| REQ-007 | Skill: Config AWS/GCP Identity                               | `skills/cloud-identity.ts` | Output IAM bindings documentation/CLI commands   | Skill execution test      | Open   |

| REQ-008 | Setup Global Volume (`groups/global`) | Deployment YAMLs | Shared RWX PVC accessible by all pods | R/W verification across jobs | Open |
| REQ-009 | Session ConfigMap (`data/sessions/{group}/.claude`) | `container-runner.ts` | ConfigMap volume mount for agent profiles | Mount verification | Open |
| REQ-010 | Custom Volume Mounting & Skill | `skills/volumes.ts` | Allow passing volume names in config + skill | E2E custom volume mount | Open |

### Constraints & Boundaries

- **MUST HAVE**: Minimal changes to `router.ts` and core message handling.
- **MUST HAVE**: RBAC roles and permissions defined for the Orchestrator pod.
- **MUST NOT HAVE**: Cloud IAM skills that attempt to apply IAM rules via K8s service accounts automatically (too much blast radius). Output commands for the user instead.

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

### Hazard Analysis & Software Risk Management

| ID  | Hazard Description      | Severity | Probability | Mitigation Strategy                                                                        | Abort Trigger          |
| --- | ----------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| H1  | K8s Job Sprawl          | Major    | High        | Set `ttlSecondsAfterFinished` on all created Agent Jobs.                                   | Jobs exceed 500        |
| H2  | IPC Failure over RWX    | Critical | Med         | Migrate IPC from file-watching to Postgres `LISTEN/NOTIFY` or polling state from DB.       | IPC timeout rate > 20% |
| H3  | Stuck/Failed K8s Jobs   | Major    | High        | Add watcher/timeout in Orchestrator for Pod status (OOMKilled/ImagePullBackOff).           | API error loop         |
| H4  | Concurrent DB Locks     | Major    | Low         | Resolved by PostgreSQL migration (RWO StatefulSet).                                        | Corrupt schema         |
| H5  | Missing CronJob Context | Major    | High        | K8s CronJobs must receive a payload (CLI args) to know which group/channel triggered them. | Null contexts          |

---

## TODOs

### WAVE 1: Infrastructure, Configuration, and Database Foundation

> _CRITICAL: Execute Wave 1 tasks using `git worktrees` if parallelizing, to avoid clobbering base config files._

- [ ] 1.1 **Initialize Fork & Dependencies**
      **What to do**: Set the git remote to `frenchtoasters`. Install `@kubernetes/client-node` and PostgreSQL driver (e.g., `pg`). Remove SQLite-specific bindings.
      **Agent-Executed QA Scenarios**:
  - `npm install` completes successfully.
  - Verify SQLite driver is fully removed from `package.json`.

- [ ] 1.2 **Migrate `db.ts` to PostgreSQL**
      **What to do**: Rewrite `src/db.ts` to connect to a Postgres database specified by environment variables. Ensure schema initialization handles Postgres syntax (e.g., `SERIAL PRIMARY KEY` instead of `INTEGER PRIMARY KEY AUTOINCREMENT`).
      **Agent-Executed QA Scenarios**:
  - Initialize the database via tests.
  - Ensure concurrent reads/writes do not throw lock errors.
  - Verify missing DB connection throws a clear, trappable error (not a silent crash).

- [ ] 1.3 **Implement Kubernetes Base Configuration**
      **What to do**: Update `src/config.ts` to rely natively on the pod's `ServiceAccount` (in-cluster config via `@kubernetes/client-node`) rather than expecting a `KUBECONFIG` env var at runtime. Process `AGENT_IMAGE` (the container image for Jobs), and custom LLM Base URL variables. Kubeconfig should be utilized strictly during installation/deployment time by tools outside the pod.
      **Agent-Executed QA Scenarios**:
  - In-cluster config automatically authenticates without crashing.

---

### WAVE 2: Execution, IPC, and Scheduling

> _Depends on Wave 1. Can be executed in parallel using `git worktrees`._

- [ ] 2.1 **Refactor `container-runner.ts` to Kubernetes Jobs**
      **What to do**: Replace Docker daemon logic with `@kubernetes/client-node` API calls. Launch Agent tasks as ephemeral K8s `Job` objects using the `AGENT_IMAGE` env var.
      _CRITICAL VOLUME MAPPINGS_: - Mount the group-specific RWX PVC to `/workspace/group`. - Mount a cluster-wide RWX PVC for `groups/global` so it's accessible globally to all agent pods. - Map `data/sessions/{group}/.claude` (and related files) to a dynamically generated Kubernetes `ConfigMap` and mount it into the Job pod. - Allow custom extra volumes to be defined in NanoClaw's configuration and append them to the Job's `volumes` and `volumeMounts` spec.
      Set `ttlSecondsAfterFinished` to ensure cluster hygiene.
      **Agent-Executed QA Scenarios**:
  - Valid `Job` YAML definition generated matching standard pod spec.
  - Job handles missing image gracefully (Orchestrator tracks `ImagePullBackOff` or times out).
  - All standard volume types (PVCs and ConfigMaps) properly map into the container spec.

- [ ] 2.2 **Refactor IPC Mechanism (`ipc.ts`)**
      **What to do**: Replace file-based IPC watching with Postgres `LISTEN/NOTIFY` (or an equivalent robust K8s-friendly polling mechanism on the DB). RWX volume file-watching is unreliable and must be deprecated for process signaling.
      **Agent-Executed QA Scenarios**:
  - Agent job writes completion status to DB. Orchestrator detects it under 1 second.
  - Test simulated Job failure (OOMKilled) – ensure Orchestrator IPC times out gracefully instead of hanging forever.

- [ ] 2.3 **Refactor Scheduler to K8s Native (`task-scheduler.ts`)**
      **What to do**: Instead of a local setInterval loop, generate Kubernetes `CronJob` manifests for recurring tasks and K8s `Job` manifests for delayed one-offs. Ensure payload context (like group ID and message intent) is passed as CLI args or DB reference to the cron pods.
      **Agent-Executed QA Scenarios**:
  - `CronJob` successfully created via API with appropriate schedule string.
  - `Job` correctly receives and parses context arguments on startup.

---

### WAVE 3: Setup Skills and Kubernetes Manifests

> _Depends on Wave 1 & 2._

- [ ] 3.1 **Create Auth Secret Management Skill**
      **What to do**: Add a skill (e.g. `/k8s-setup-secrets`) that takes user credentials and interacts with the K8s API to create or update a `Secret` object holding all necessary auth tokens. Ensure the Orchestrator maps this Secret to new Agent Jobs.
      **Agent-Executed QA Scenarios**:
  - Skill correctly generates a valid Opaque Secret.
  - Subsequent `Job` creations automatically include the `envFrom` referring to the secret.

- [ ] 3.2 **Create Cloud Identity Guidance Skills**
      **What to do**: Add skills (e.g., `/aws-irsa-setup`, `/gcp-workload-identity`) that detect the environment and output the exact `gcloud` or `eksctl` commands required to bind a cloud role to the Orchestrator/Agent ServiceAccount.
      _CRITICAL_: Do NOT attempt to execute these commands automatically. Output documentation.
      **Agent-Executed QA Scenarios**:
  - Execution returns accurately formatted CLI documentation for the specific cloud.

- [ ] 3.3 **Generate Kubernetes Deployment Manifests**
      **What to do**: Create a `k8s/` directory. Write manifests for:
  1. `statefulset-postgres.yaml` (RWO volume)
  2. `deployment-orchestrator.yaml`
  3. `pvc-workspace.yaml` (RWX class)
  4. `rbac.yaml` (Role/RoleBinding permitting `Job`, `CronJob`, `Secret`, and `Pod` management).
     **Agent-Executed QA Scenarios**:
  - `kubectl apply --dry-run=client -k k8s/` passes successfully.

- [ ] 3.4 **Create Custom Volume Management Skill**
      **What to do**: Create a skill (e.g., `/k8s-create-volume`) that assists users in defining and deploying new PersistentVolumeClaims (PVCs) within the cluster. It should generate the YAML, apply it via `@kubernetes/client-node`, and output instructions on how to add the newly created volume to the NanoClaw agent configuration.
      **Agent-Executed QA Scenarios**:
  - Skill correctly applies a standard RWO/RWX PVC manifest via K8s API.
  - Returns clear instructions for config inclusion.

---

## PHASE 4: VERIFICATION & VALIDATION (V&V)

### Verification Matrix

| Verification Type | Method                                   | Acceptance Criteria                                             | Status  |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------- | ------- |
| Unit/Integration  | Run modified test suite                  | 100% pass on DB and Container-Runner specs                      | Pending |
| System            | Deploy to minikube / kind                | Orchestrator runs without CrashLoopBackOff                      | Pending |
| Functional        | Send message via channel                 | Orchestrator creates K8s Job, Job completes, IPC returns result | Pending |
| State             | Agent creates file in `/workspace/group` | File is visible to Orchestrator and subsequent Jobs             | Pending |
| Lifecycle         | Job completion                           | Job is deleted automatically after TTL                          | Pending |

---

## Final Mission Certification

- [ ] MISSION SUCCESS: All objectives achieved, no hazards manifested.
