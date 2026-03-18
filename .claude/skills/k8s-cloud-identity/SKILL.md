---
name: k8s-cloud-identity
description: Guidance for configuring cloud IAM identity (AWS IRSA or GCP Workload Identity) for NanoClaw pods. Outputs CLI commands only — does NOT auto-execute.
---

# Cloud Identity Setup

Configures cloud IAM so NanoClaw pods can access cloud services (LLM APIs, managed databases, storage) without embedding long-lived credentials.

**CRITICAL: This skill outputs documentation and CLI commands only. It does NOT execute cloud IAM commands automatically.**

## Detect Environment

Ask the user which cloud they're running on, or detect from context:

```bash
# AWS EKS detection
kubectl get configmap -n kube-system aws-auth 2>/dev/null && echo "AWS EKS detected"

# GCP GKE detection
kubectl get configmap -n kube-system gke-config 2>/dev/null && echo "GCP GKE detected"
```

---

## AWS IRSA (IAM Roles for Service Accounts)

### Prerequisites

- EKS cluster with OIDC provider enabled
- `eksctl` or `aws` CLI installed
- IAM permissions to create roles and policies

### Step 1: Enable OIDC Provider (if not already)

```bash
# Get cluster name
CLUSTER_NAME=$(kubectl config current-context | cut -d/ -f2)

# Check if OIDC provider exists
aws eks describe-cluster --name $CLUSTER_NAME \
  --query "cluster.identity.oidc.issuer" --output text

# Enable if needed
eksctl utils associate-iam-oidc-provider \
  --cluster $CLUSTER_NAME \
  --approve
```

### Step 2: Create IAM Policy

Create a policy with the minimum permissions NanoClaw needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    }
  ]
}
```

```bash
aws iam create-policy \
  --policy-name NanoClawAgentPolicy \
  --policy-document file://nanoclaw-policy.json
```

### Step 3: Create Service Account with IAM Role

```bash
eksctl create iamserviceaccount \
  --name nanoclaw-agent \
  --namespace nanoclaw \
  --cluster $CLUSTER_NAME \
  --role-name NanoClawAgentRole \
  --attach-policy-arn arn:aws:iam::$ACCOUNT_ID:policy/NanoClawAgentPolicy \
  --approve \
  --override-existing-serviceaccounts
```

### Step 4: Annotate Orchestrator Service Account

```bash
eksctl create iamserviceaccount \
  --name nanoclaw-orchestrator \
  --namespace nanoclaw \
  --cluster $CLUSTER_NAME \
  --role-name NanoClawOrchestratorRole \
  --attach-policy-arn arn:aws:iam::$ACCOUNT_ID:policy/NanoClawAgentPolicy \
  --approve \
  --override-existing-serviceaccounts
```

### Step 5: Update K8s Manifests

Ensure the Deployment and Job specs reference the annotated service accounts:

```yaml
# In k8s/deployment-orchestrator.yaml
spec:
  template:
    spec:
      serviceAccountName: nanoclaw-orchestrator

# In container-runner.ts buildJobSpec() — already uses K8S_NAMESPACE
# Add serviceAccountName to the Job spec if needed
```

---

## GCP Workload Identity

### Prerequisites

- GKE cluster with Workload Identity enabled
- `gcloud` CLI installed and authenticated
- IAM permissions to create service accounts and bindings

### Step 1: Enable Workload Identity on Cluster

```bash
# Check if already enabled
gcloud container clusters describe $CLUSTER_NAME \
  --zone $ZONE \
  --format="value(workloadIdentityConfig.workloadPool)"

# Enable if needed
gcloud container clusters update $CLUSTER_NAME \
  --zone $ZONE \
  --workload-pool=$PROJECT_ID.svc.id.goog
```

### Step 2: Create GCP Service Account

```bash
gcloud iam service-accounts create nanoclaw-agent \
  --display-name="NanoClaw Agent"
```

### Step 3: Grant Permissions

```bash
# For Vertex AI / Anthropic via Google
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:nanoclaw-agent@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### Step 4: Bind K8s SA to GCP SA

```bash
gcloud iam service-accounts add-iam-policy-binding \
  nanoclaw-agent@$PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:$PROJECT_ID.svc.id.goog[nanoclaw/nanoclaw-agent]"
```

### Step 5: Annotate K8s Service Account

```bash
kubectl annotate serviceaccount nanoclaw-agent \
  --namespace nanoclaw \
  --overwrite \
  iam.gke.io/gcp-service-account=nanoclaw-agent@$PROJECT_ID.iam.gserviceaccount.com
```

Do the same for the orchestrator service account if it needs cloud access.

---

## Verification

```bash
# Test that the service account token is being projected
kubectl run identity-test \
  --namespace nanoclaw \
  --image=google/cloud-sdk:slim \
  --serviceaccount=nanoclaw-agent \
  --restart=Never \
  --command -- gcloud auth list

kubectl logs identity-test -n nanoclaw
kubectl delete pod identity-test -n nanoclaw
```

## Notes

- IRSA and Workload Identity both work by projecting a short-lived token into pods via a projected service account token volume. No code changes needed in NanoClaw.
- The orchestrator and agent Jobs can use different service accounts with different permission sets.
- For self-managed clusters (not EKS/GKE), use a similar OIDC federation approach or fall back to K8s Secrets with long-lived credentials.
