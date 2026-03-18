---
name: k8s-setup-secrets
description: Create or update Kubernetes Secrets for NanoClaw API keys and database credentials. Use when setting up a new cluster or rotating credentials.
---

# K8s Secret Management

Creates and manages Kubernetes Secrets used by NanoClaw agent Jobs and the orchestrator.

## Secrets Architecture

NanoClaw uses two Secrets (Opaque type):

| Secret Name    | Purpose                  | Keys                |
| -------------- | ------------------------ | ------------------- |
| `nanoclaw-llm` | LLM provider credentials | `ANTHROPIC_API_KEY` |
| `nanoclaw-db`  | PostgreSQL connection    | `DATABASE_URL`      |

Agent Jobs reference these via `envFrom` in the Job spec (see `src/container-runner.ts` `buildJobSpec()`).

## Phase 1: Pre-flight

Check if secrets already exist:

```bash
kubectl get secret nanoclaw-llm -n nanoclaw 2>/dev/null && echo "LLM secret exists" || echo "LLM secret missing"
kubectl get secret nanoclaw-db -n nanoclaw 2>/dev/null && echo "DB secret exists" || echo "DB secret missing"
```

## Phase 2: Create Secrets

### LLM Provider Secret

Ask the user for their Anthropic API key (or other LLM provider key):

```bash
kubectl create secret generic nanoclaw-llm \
  --namespace=nanoclaw \
  --from-literal=ANTHROPIC_API_KEY='<USER_API_KEY>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Database Secret

Ask the user for the PostgreSQL connection string:

```bash
kubectl create secret generic nanoclaw-db \
  --namespace=nanoclaw \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/nanoclaw' \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Phase 3: Rotate Credentials

To update an existing secret without downtime:

```bash
# Update LLM key
kubectl create secret generic nanoclaw-llm \
  --namespace=nanoclaw \
  --from-literal=ANTHROPIC_API_KEY='<NEW_KEY>' \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart orchestrator to pick up new secret
kubectl rollout restart deployment/nanoclaw-orchestrator -n nanoclaw
```

New agent Jobs automatically use the updated secret on next creation.

## Phase 4: Verify

```bash
# Confirm secrets exist with expected keys
kubectl get secret nanoclaw-llm -n nanoclaw -o jsonpath='{.data}' | jq 'keys'
kubectl get secret nanoclaw-db -n nanoclaw -o jsonpath='{.data}' | jq 'keys'

# Verify a test Job can access the secret
kubectl run nanoclaw-secret-test \
  --namespace=nanoclaw \
  --image=busybox \
  --restart=Never \
  --env-from=secret:nanoclaw-llm \
  --command -- sh -c 'echo "ANTHROPIC_API_KEY is set: $(test -n "$ANTHROPIC_API_KEY" && echo yes || echo no)"'
kubectl logs nanoclaw-secret-test -n nanoclaw
kubectl delete pod nanoclaw-secret-test -n nanoclaw
```

## Notes

- Secrets are namespace-scoped. Ensure `K8S_NAMESPACE` in config matches.
- The orchestrator itself reads `DATABASE_URL` from its own environment (set via the Deployment spec), not from the Secret directly.
- Agent Jobs get both secrets injected via `env` entries in `buildJobSpec()`.
