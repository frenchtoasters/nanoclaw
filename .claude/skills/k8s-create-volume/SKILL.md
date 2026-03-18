---
name: k8s-create-volume
description: Create and manage PersistentVolumeClaims for NanoClaw agent storage. Use to add custom volumes beyond the default group/global PVCs.
---

# Custom Volume Management

Assists in creating PersistentVolumeClaims (PVCs) for NanoClaw agent containers. Default PVCs (`{group}-pvc`, `global-pvc`) are created by the base manifests. This skill adds custom volumes.

## Default Volume Architecture

| PVC Name            | Access Mode   | Mount Path          | Purpose                              |
| ------------------- | ------------- | ------------------- | ------------------------------------ |
| `{groupFolder}-pvc` | ReadWriteMany | `/workspace/group`  | Group-specific persistent storage    |
| `global-pvc`        | ReadWriteMany | `/workspace/global` | Shared read-only (except main group) |
| Custom PVCs         | User-defined  | User-defined        | Additional storage needs             |

## Phase 1: Gather Requirements

Ask the user:

1. **Name**: PVC name (e.g., `datasets`, `model-cache`)
2. **Size**: Storage size (e.g., `10Gi`, `100Gi`)
3. **Access Mode**: `ReadWriteOnce` (single node) or `ReadWriteMany` (multi-node)
4. **Storage Class**: Use cluster default or specify (e.g., `gp3`, `standard-rwx`, `efs-sc`)
5. **Mount Path**: Where to mount in agent containers (e.g., `/workspace/datasets`)
6. **Read-only**: Should agents mount this read-only?

## Phase 2: Generate PVC YAML

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <PVC_NAME>
  namespace: nanoclaw
  labels:
    app: nanoclaw
    component: custom-storage
spec:
  accessModes:
    - <ACCESS_MODE>
  storageClassName: <STORAGE_CLASS> # omit for cluster default
  resources:
    requests:
      storage: <SIZE>
```

## Phase 3: Apply PVC

```bash
# Preview
kubectl apply --dry-run=client -f pvc.yaml

# Apply
kubectl apply -f pvc.yaml

# Verify
kubectl get pvc <PVC_NAME> -n nanoclaw
```

## Phase 4: Configure NanoClaw to Mount the Volume

Custom volumes are added to agent Jobs via the `containerConfig.additionalMounts` field on a registered group.

### Option A: Update Group Registration

In the group's registration (via IPC or directly), add the mount:

```json
{
  "containerConfig": {
    "additionalMounts": [
      {
        "source": "<PVC_NAME>",
        "target": "<MOUNT_PATH>",
        "readOnly": false
      }
    ]
  }
}
```

### Option B: Update container-runner.ts

For cluster-wide custom volumes, add to the `buildJobSpec()` function in `src/container-runner.ts`:

```typescript
// Add to volumes array:
{
  name: '<PVC_NAME>',
  persistentVolumeClaim: { claimName: '<PVC_NAME>' }
}

// Add to volumeMounts array:
{
  name: '<PVC_NAME>',
  mountPath: '<MOUNT_PATH>',
  readOnly: <true|false>
}
```

## Phase 5: Verify

```bash
# Check PVC is bound
kubectl get pvc <PVC_NAME> -n nanoclaw

# Test mount in a temporary pod
kubectl run volume-test \
  --namespace=nanoclaw \
  --image=busybox \
  --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "test",
        "image": "busybox",
        "command": ["sh", "-c", "ls -la <MOUNT_PATH> && echo SUCCESS"],
        "volumeMounts": [{"name": "test-vol", "mountPath": "<MOUNT_PATH>"}]
      }],
      "volumes": [{"name": "test-vol", "persistentVolumeClaim": {"claimName": "<PVC_NAME>"}}]
    }
  }'
kubectl logs volume-test -n nanoclaw
kubectl delete pod volume-test -n nanoclaw
```

## Storage Class Notes

| Provider  | RWO Class                  | RWX Class                          |
| --------- | -------------------------- | ---------------------------------- |
| AWS EKS   | `gp3` (default)            | `efs-sc` (requires EFS CSI driver) |
| GCP GKE   | `standard` / `premium-rwo` | `standard-rwx` (Filestore)         |
| Azure AKS | `managed-premium`          | `azurefile-premium`                |
| Minikube  | `standard`                 | `standard` (single-node)           |

For RWX on AWS, install the EFS CSI driver:

```bash
helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver -n kube-system
```
