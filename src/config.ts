import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DATABASE_URL',
  'AGENT_IMAGE',
  'ANTHROPIC_BASE_URL',
  'K8S_NAMESPACE',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// --- PostgreSQL ---
export const DATABASE_URL =
  process.env.DATABASE_URL ||
  envConfig.DATABASE_URL ||
  'postgresql://localhost:5432/nanoclaw';

// --- Kubernetes ---
// Agent container image for K8s Jobs (required in production)
export const AGENT_IMAGE =
  process.env.AGENT_IMAGE || envConfig.AGENT_IMAGE || 'nanoclaw-agent:latest';

// Namespace for K8s resources (Jobs, CronJobs, Secrets, ConfigMaps)
export const K8S_NAMESPACE =
  process.env.K8S_NAMESPACE || envConfig.K8S_NAMESPACE || 'nanoclaw';

// LLM provider base URL — passed as env var to agent containers
export const ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL || envConfig.ANTHROPIC_BASE_URL || '';

// Job resource limits
export const JOB_CPU_REQUEST = process.env.JOB_CPU_REQUEST || '250m';
export const JOB_CPU_LIMIT = process.env.JOB_CPU_LIMIT || '1000m';
export const JOB_MEMORY_REQUEST = process.env.JOB_MEMORY_REQUEST || '256Mi';
export const JOB_MEMORY_LIMIT = process.env.JOB_MEMORY_LIMIT || '1Gi';

// TTL for completed/failed Jobs (seconds). Default 10 minutes.
export const JOB_TTL_SECONDS = parseInt(
  process.env.JOB_TTL_SECONDS || '600',
  10,
);

// Active deadline for Jobs (seconds). Default 30 minutes.
export const JOB_ACTIVE_DEADLINE = parseInt(
  process.env.JOB_ACTIVE_DEADLINE || '1800',
  10,
);

// --- Paths ---
// Absolute paths — still used for local config files and group definitions
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// --- Container / execution ---
// CONTAINER_IMAGE kept as alias for backwards compat in non-k8s code paths
export const CONTAINER_IMAGE = AGENT_IMAGE;
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
