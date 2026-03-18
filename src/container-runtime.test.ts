import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------
const mockLoadFromCluster = vi.fn();
const mockLoadFromDefault = vi.fn();
const mockListNamespacedPod = vi.fn();
const mockListNamespacedJob = vi.fn();
const mockDeleteNamespacedJob = vi.fn();

vi.mock('@kubernetes/client-node', () => {
  const mockBatchApi = {
    listNamespacedJob: mockListNamespacedJob,
    deleteNamespacedJob: mockDeleteNamespacedJob,
  };
  const mockCoreApi = {
    listNamespacedPod: mockListNamespacedPod,
  };
  return {
    KubeConfig: vi.fn().mockImplementation(() => ({
      loadFromCluster: mockLoadFromCluster,
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: vi.fn().mockImplementation((ApiClass: unknown) => {
        // Return the appropriate mock based on which API class
        if (ApiClass === BatchV1ApiClass) return mockBatchApi;
        return mockCoreApi;
      }),
    })),
    BatchV1Api: vi.fn(),
    CoreV1Api: vi.fn(),
  };
});

// Need a stable reference for the mock check
const BatchV1ApiClass = vi.fn();

vi.mock('./config.js', () => ({
  JOB_TTL_SECONDS: 600,
  K8S_NAMESPACE: 'test-ns',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  ensureK8sConnection,
  deleteJob,
  cleanupOrphanJobs,
} from './container-runtime.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('container-runtime (K8s client)', () => {
  describe('ensureK8sConnection', () => {
    it('loads in-cluster config first, falls back to default', async () => {
      // In-cluster load throws (not in cluster)
      mockLoadFromCluster.mockImplementationOnce(() => {
        throw new Error('not in cluster');
      });
      // Default load succeeds
      mockLoadFromDefault.mockImplementationOnce(() => {});
      // Connection verify succeeds
      mockListNamespacedPod.mockResolvedValueOnce({ body: { items: [] } });

      await ensureK8sConnection();
      expect(mockLoadFromCluster).toHaveBeenCalled();
      expect(mockLoadFromDefault).toHaveBeenCalled();
    });
  });

  describe('deleteJob', () => {
    it('deletes a job with background propagation', async () => {
      // First ensure we have a connection
      mockLoadFromCluster.mockImplementationOnce(() => {});
      mockListNamespacedPod.mockResolvedValueOnce({ body: { items: [] } });
      await ensureK8sConnection();

      mockDeleteNamespacedJob.mockResolvedValueOnce({});

      await deleteJob('test-job');
      expect(mockDeleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-job',
          namespace: 'test-ns',
        }),
      );
    });

    it('ignores 404 errors', async () => {
      mockLoadFromCluster.mockImplementationOnce(() => {});
      mockListNamespacedPod.mockResolvedValueOnce({ body: { items: [] } });
      await ensureK8sConnection();

      const err = new Error('not found') as Error & { statusCode: number };
      err.statusCode = 404;
      mockDeleteNamespacedJob.mockRejectedValueOnce(err);

      // Should not throw
      await expect(deleteJob('missing-job')).resolves.not.toThrow();
    });
  });

  describe('cleanupOrphanJobs', () => {
    it('deletes jobs past TTL', async () => {
      mockLoadFromCluster.mockImplementationOnce(() => {});
      mockListNamespacedPod.mockResolvedValueOnce({ body: { items: [] } });
      await ensureK8sConnection();

      const oldDate = new Date(Date.now() - 700 * 1000).toISOString();
      mockListNamespacedJob.mockResolvedValueOnce({
        body: {
          items: [
            {
              metadata: { name: 'old-job', creationTimestamp: oldDate },
              status: { succeeded: 1 },
            },
          ],
        },
      });
      mockDeleteNamespacedJob.mockResolvedValueOnce({});

      await cleanupOrphanJobs();
      expect(mockDeleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'old-job' }),
      );
    });
  });
});
