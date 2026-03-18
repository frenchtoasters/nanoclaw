/**
 * Kubernetes runtime abstraction for NanoClaw.
 * Replaces Docker runtime — provides K8s client initialization and Job lifecycle management.
 */
import * as k8s from '@kubernetes/client-node';

import { JOB_TTL_SECONDS, K8S_NAMESPACE } from './config.js';
import { logger } from './logger.js';

let kc: k8s.KubeConfig;
let batchApi: k8s.BatchV1Api;
let coreApi: k8s.CoreV1Api;

/** Get the K8s BatchV1Api (for Jobs, CronJobs) */
export function getBatchApi(): k8s.BatchV1Api {
  return batchApi;
}

/** Get the K8s CoreV1Api (for ConfigMaps, Secrets, Pods, logs) */
export function getCoreApi(): k8s.CoreV1Api {
  return coreApi;
}

/** Get the KubeConfig instance */
export function getKubeConfig(): k8s.KubeConfig {
  return kc;
}

/**
 * Initialize K8s client.
 * Uses in-cluster config when running as a pod, falls back to default kubeconfig for dev.
 */
export async function ensureK8sConnection(): Promise<void> {
  kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
    logger.info('Loaded in-cluster Kubernetes config');
  } catch {
    kc.loadFromDefault();
    logger.info('Loaded default kubeconfig');
  }

  batchApi = kc.makeApiClient(k8s.BatchV1Api);
  coreApi = kc.makeApiClient(k8s.CoreV1Api);

  // Verify connectivity with a lightweight API call
  try {
    await coreApi.listNamespacedPod({ namespace: K8S_NAMESPACE, limit: 1 });
    logger.info(
      { namespace: K8S_NAMESPACE },
      'Kubernetes API connection verified',
    );
  } catch (err) {
    logger.error(
      { err, namespace: K8S_NAMESPACE },
      'Failed to connect to Kubernetes API',
    );
    throw err;
  }
}

/**
 * Delete a K8s Job by name, including its child pods.
 */
export async function deleteJob(jobName: string): Promise<void> {
  try {
    await batchApi.deleteNamespacedJob({
      name: jobName,
      namespace: K8S_NAMESPACE,
      body: { propagationPolicy: 'Background' },
    });
    logger.debug({ job: jobName }, 'Deleted K8s Job');
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { statusCode?: number } }).response?.statusCode
        : undefined;
    if (status !== 404) throw err;
    // 404 = already deleted, ignore
  }
}

/**
 * Clean up completed/failed Jobs that have exceeded the TTL.
 * Jobs with `ttlSecondsAfterFinished` should self-clean, but this is a safety net.
 */
export async function cleanupOrphanJobs(): Promise<void> {
  try {
    const response = await batchApi.listNamespacedJob({
      namespace: K8S_NAMESPACE,
      labelSelector: 'app=nanoclaw-agent',
    });

    const jobs = response.items ?? [];
    const now = Date.now();
    let cleaned = 0;

    for (const job of jobs) {
      const completionTime =
        job.status?.completionTime ??
        job.status?.conditions?.find(
          (c) => c.type === 'Failed' || c.type === 'Complete',
        )?.lastTransitionTime;

      if (!completionTime) continue;

      const age =
        now -
        new Date(
          completionTime instanceof Date
            ? completionTime.toISOString()
            : completionTime,
        ).getTime();
      if (age > JOB_TTL_SECONDS * 1000) {
        try {
          await deleteJob(job.metadata!.name!);
          cleaned++;
        } catch (err) {
          logger.warn(
            { job: job.metadata?.name, err },
            'Failed to clean up orphan job',
          );
        }
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up orphan K8s Jobs');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to list jobs for orphan cleanup');
  }
}
