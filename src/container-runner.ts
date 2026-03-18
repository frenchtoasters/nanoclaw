/**
 * Container Runner for NanoClaw — Kubernetes Job Edition
 * Creates K8s Jobs for agent execution and collects output via pod logs.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import * as k8s from '@kubernetes/client-node';

import { getBatchApi, getCoreApi } from './container-runtime.js';
import {
  AGENT_IMAGE,
  ANTHROPIC_BASE_URL,
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  GROUPS_DIR,
  JOB_ACTIVE_DEADLINE,
  JOB_CPU_LIMIT,
  JOB_CPU_REQUEST,
  JOB_MEMORY_LIMIT,
  JOB_MEMORY_REQUEST,
  JOB_TTL_SECONDS,
  K8S_NAMESPACE,
  TIMEZONE,
} from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Interfaces — kept identical to Docker version for caller compatibility
// ---------------------------------------------------------------------------

export interface ContainerInput {
  groupFolder: string;
  chatJid: string;
  input: string;
  sessionId?: string;
  registeredGroup: RegisteredGroup;
  assistantName: string;
}

export interface ContainerOutput {
  response: string;
  sessionId: string;
  logs: string;
  exitCode: number | null;
}

export interface AvailableGroup {
  name: string;
  folder: string;
  jid: string;
  isMain: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique, DNS-safe K8s Job name */
function makeJobName(groupFolder: string): string {
  const safe = groupFolder
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40);
  const suffix = randomUUID().slice(0, 8);
  return `nanoclaw-${safe}-${suffix}`;
}

/** Build the K8s Job spec for an agent run */
function buildJobSpec(input: ContainerInput, name: string): k8s.V1Job {
  const isMain = input.registeredGroup.isMain === true;
  const groupFolder = input.registeredGroup.folder;

  // --- Environment variables ---
  const env: k8s.V1EnvVar[] = [
    { name: 'TZ', value: TIMEZONE },
    { name: 'GROUP_FOLDER', value: groupFolder },
    { name: 'CHAT_JID', value: input.chatJid },
    { name: 'ASSISTANT_NAME', value: input.assistantName },
    { name: 'INPUT_TEXT', value: input.input },
    {
      name: 'DATABASE_URL',
      valueFrom: {
        secretKeyRef: { name: 'nanoclaw-db', key: 'DATABASE_URL' },
      },
    },
    {
      name: 'ANTHROPIC_API_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'nanoclaw-llm',
          key: 'ANTHROPIC_API_KEY',
          optional: true,
        },
      },
    },
  ];
  if (input.sessionId) {
    env.push({ name: 'SESSION_ID', value: input.sessionId });
  }
  if (ANTHROPIC_BASE_URL) {
    env.push({ name: 'ANTHROPIC_BASE_URL', value: ANTHROPIC_BASE_URL });
  }

  // --- Volumes ---
  const volumes: k8s.V1Volume[] = [
    {
      name: 'group-storage',
      persistentVolumeClaim: { claimName: `${groupFolder}-pvc` },
    },
    {
      name: 'global-storage',
      persistentVolumeClaim: { claimName: 'global-pvc' },
    },
    {
      name: 'claude-config',
      configMap: {
        name: `${groupFolder}-claude-config`,
        optional: true,
      },
    },
  ];

  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: 'group-storage', mountPath: '/workspace/group' },
    {
      name: 'global-storage',
      mountPath: '/workspace/global',
      readOnly: !isMain,
    },
    {
      name: 'claude-config',
      mountPath: '/home/node/.claude',
      readOnly: true,
    },
  ];

  // Additional mounts from container config → pre-provisioned PVCs
  const additionalMounts =
    input.registeredGroup.containerConfig?.additionalMounts ?? [];
  for (const mount of additionalMounts) {
    const mountName = `extra-${mount.hostPath
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .slice(0, 50)}`;
    volumes.push({
      name: mountName,
      persistentVolumeClaim: { claimName: mountName },
    });
    const containerPath =
      mount.containerPath ??
      `/workspace/extra/${path.basename(mount.hostPath)}`;
    volumeMounts.push({
      name: mountName,
      mountPath: containerPath,
      readOnly: mount.readonly !== false,
    });
  }

  // --- Job spec ---
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: K8S_NAMESPACE,
      labels: { app: 'nanoclaw-agent', group: groupFolder },
    },
    spec: {
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      activeDeadlineSeconds: JOB_ACTIVE_DEADLINE,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: { app: 'nanoclaw-agent', group: groupFolder },
        },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'agent',
              image: AGENT_IMAGE,
              env,
              resources: {
                requests: {
                  cpu: JOB_CPU_REQUEST,
                  memory: JOB_MEMORY_REQUEST,
                },
                limits: { cpu: JOB_CPU_LIMIT, memory: JOB_MEMORY_LIMIT },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ConfigMap management
// ---------------------------------------------------------------------------

/**
 * Ensure the ConfigMap for the group's CLAUDE.md exists, creating/updating as needed.
 */
async function ensureClaudeConfigMap(groupFolder: string): Promise<void> {
  const coreApi = getCoreApi();
  const cmName = `${groupFolder}-claude-config`;

  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(
      path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md'),
      'utf-8',
    );
  } catch {
    // No CLAUDE.md for this group
  }

  const configMap: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: cmName,
      namespace: K8S_NAMESPACE,
      labels: { app: 'nanoclaw-agent', group: groupFolder },
    },
    data: { 'CLAUDE.md': claudeMd },
  };

  try {
    await coreApi.replaceNamespacedConfigMap({
      name: cmName,
      namespace: K8S_NAMESPACE,
      body: configMap,
    });
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { statusCode?: number } }).response?.statusCode
        : undefined;
    if (status === 404) {
      await coreApi.createNamespacedConfigMap({
        namespace: K8S_NAMESPACE,
        body: configMap,
      });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

/**
 * Wait for a K8s Job to finish, then retrieve pod logs.
 */
async function waitForJob(
  name: string,
  timeoutMs: number,
): Promise<{ logs: string; exitCode: number | null; succeeded: boolean }> {
  const batchApi = getBatchApi();
  const coreApi = getCoreApi();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const job = await batchApi.readNamespacedJob({
      name,
      namespace: K8S_NAMESPACE,
    });

    const succeeded = (job.status?.succeeded ?? 0) > 0;
    const failed = (job.status?.failed ?? 0) > 0;

    if (succeeded || failed) {
      let logs = '';
      try {
        const podList = await coreApi.listNamespacedPod({
          namespace: K8S_NAMESPACE,
          labelSelector: `job-name=${name}`,
        });
        const pods = podList.items ?? [];
        if (pods.length > 0) {
          const podName = pods[0].metadata!.name!;
          const logResponse = await coreApi.readNamespacedPodLog({
            name: podName,
            namespace: K8S_NAMESPACE,
            container: 'agent',
          });
          logs =
            typeof logResponse === 'string' ? logResponse : String(logResponse);
        }
      } catch (err) {
        logger.warn({ job: name, err }, 'Failed to retrieve job logs');
      }

      return { logs, exitCode: succeeded ? 0 : 1, succeeded };
    }

    // Poll every 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Timeout — delete the job
  logger.warn({ job: name }, 'Job timed out, deleting');
  try {
    await getBatchApi().deleteNamespacedJob({
      name,
      namespace: K8S_NAMESPACE,
      body: { propagationPolicy: 'Background' },
    });
  } catch {
    /* ignore */
  }

  return { logs: 'Job timed out', exitCode: null, succeeded: false };
}

/**
 * Parse agent output from job logs.
 * Expects output between `---OUTPUT_START---` and `---OUTPUT_END---` markers.
 */
function parseAgentOutput(logs: string): {
  response: string;
  sessionId: string;
} {
  const startMarker = '---OUTPUT_START---';
  const endMarker = '---OUTPUT_END---';
  const startIdx = logs.indexOf(startMarker);
  const endIdx = logs.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const outputJson = logs.slice(startIdx + startMarker.length, endIdx).trim();
    try {
      const parsed = JSON.parse(outputJson);
      return {
        response: parsed.response ?? '',
        sessionId: parsed.sessionId ?? parsed.session_id ?? '',
      };
    } catch {
      return { response: outputJson, sessionId: '' };
    }
  }

  // Fallback: treat entire log as response
  return { response: logs.trim(), sessionId: '' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an agent in a K8s Job. Creates the Job, waits for completion, returns output.
 */
export async function runContainerAgent(
  input: ContainerInput,
): Promise<ContainerOutput> {
  const name = makeJobName(input.groupFolder);
  const batchApi = getBatchApi();

  logger.info(
    { job: name, group: input.groupFolder, chatJid: input.chatJid },
    'Creating K8s Job for agent',
  );

  // Ensure ConfigMap for this group's CLAUDE.md
  await ensureClaudeConfigMap(input.registeredGroup.folder);

  // Create the Job
  const jobSpec = buildJobSpec(input, name);
  await batchApi.createNamespacedJob({
    namespace: K8S_NAMESPACE,
    body: jobSpec,
  });

  // Wait for completion and collect logs
  const result = await waitForJob(name, CONTAINER_TIMEOUT);
  const { response, sessionId } = parseAgentOutput(result.logs);

  logger.info(
    {
      job: name,
      exitCode: result.exitCode,
      succeeded: result.succeeded,
      responseLen: response.length,
    },
    'K8s Job completed',
  );

  return {
    response,
    sessionId: sessionId || input.sessionId || '',
    logs: result.logs,
    exitCode: result.exitCode,
  };
}

/**
 * Write a tasks snapshot for a group.
 * No-op in K8s mode — tasks are already in PostgreSQL, accessible via DATABASE_URL.
 */
export async function writeTasksSnapshot(
  _groupFolder: string,
  _registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  // No-op: agent Jobs query the DB directly
}

/**
 * Write a groups snapshot.
 * No-op in K8s mode — groups are in the registered_groups table.
 */
export async function writeGroupsSnapshot(
  _groups: AvailableGroup[],
): Promise<void> {
  // No-op: agent Jobs query the DB directly
}
