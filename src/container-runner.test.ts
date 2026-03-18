import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// Mock container-runtime (K8s client)
const mockCreateNamespacedJob = vi.fn();
const mockReadNamespacedJob = vi.fn();
const mockListNamespacedPod = vi.fn();
const mockReadNamespacedPodLog = vi.fn();
const mockCreateNamespacedConfigMap = vi.fn();
const mockReplaceNamespacedConfigMap = vi.fn();
const mockReadNamespacedConfigMap = vi.fn();

vi.mock('./container-runtime.js', () => ({
  getBatchApi: () => ({
    createNamespacedJob: mockCreateNamespacedJob,
    readNamespacedJob: mockReadNamespacedJob,
  }),
  getCoreApi: () => ({
    listNamespacedPod: mockListNamespacedPod,
    readNamespacedPodLog: mockReadNamespacedPodLog,
    createNamespacedConfigMap: mockCreateNamespacedConfigMap,
    replaceNamespacedConfigMap: mockReplaceNamespacedConfigMap,
    readNamespacedConfigMap: mockReadNamespacedConfigMap,
  }),
}));

vi.mock('./config.js', () => ({
  AGENT_IMAGE: 'test-agent:latest',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ASSISTANT_NAME: 'TestBot',
  CONTAINER_TIMEOUT: 300000,
  GROUPS_DIR: '/tmp/groups',
  JOB_ACTIVE_DEADLINE: 1800,
  JOB_CPU_LIMIT: '2',
  JOB_CPU_REQUEST: '0.5',
  JOB_MEMORY_LIMIT: '4Gi',
  JOB_MEMORY_REQUEST: '1Gi',
  JOB_TTL_SECONDS: 600,
  K8S_NAMESPACE: 'test-ns',
  TIMEZONE: 'UTC',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue('# Test CLAUDE.md'),
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  runContainerAgent,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: 'always',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
};

const testInput: ContainerInput = {
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  input: 'Hello, agent!',
  registeredGroup: testGroup,
  assistantName: 'TestBot',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('container-runner (K8s Jobs)', () => {
  it('creates a Job and returns output on success', async () => {
    // ConfigMap create succeeds (new)
    mockReadNamespacedConfigMap.mockRejectedValueOnce({ statusCode: 404 });
    mockCreateNamespacedConfigMap.mockResolvedValueOnce({});

    // Job creation succeeds
    mockCreateNamespacedJob.mockResolvedValueOnce({});

    // Job completes successfully after polling
    mockReadNamespacedJob
      .mockResolvedValueOnce({
        body: { status: { succeeded: undefined, failed: undefined } },
      })
      .mockResolvedValueOnce({
        body: { status: { succeeded: 1 } },
      });

    // Pod list for log retrieval
    mockListNamespacedPod.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: 'test-pod' } }] },
    });

    // Pod logs with output markers
    const logOutput = [
      'Starting agent...',
      '---OUTPUT_START---',
      JSON.stringify({
        response: 'Hello from agent!',
        sessionId: 'sess-123',
      }),
      '---OUTPUT_END---',
      'Agent finished.',
    ].join('\n');
    mockReadNamespacedPodLog.mockResolvedValueOnce({ body: logOutput });

    const result = await runContainerAgent(testInput);

    expect(result.response).toBe('Hello from agent!');
    expect(result.sessionId).toBe('sess-123');
    expect(result.exitCode).toBe(0);
    expect(mockCreateNamespacedJob).toHaveBeenCalledOnce();
  });

  it('returns error output when Job fails', async () => {
    // ConfigMap already exists → update
    mockReadNamespacedConfigMap.mockResolvedValueOnce({});
    mockReplaceNamespacedConfigMap.mockResolvedValueOnce({});

    // Job creation succeeds
    mockCreateNamespacedJob.mockResolvedValueOnce({});

    // Job fails
    mockReadNamespacedJob.mockResolvedValueOnce({
      body: { status: { failed: 1 } },
    });

    // Pod list for log retrieval
    mockListNamespacedPod.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: 'fail-pod' } }] },
    });

    // Pod logs without output markers
    mockReadNamespacedPodLog.mockResolvedValueOnce({
      body: 'Error: something went wrong',
    });

    const result = await runContainerAgent(testInput);

    expect(result.response).toBe('');
    expect(result.exitCode).toBe(1);
    expect(result.logs).toContain('something went wrong');
  });

  it('writeTasksSnapshot and writeGroupsSnapshot are no-ops', async () => {
    const { writeTasksSnapshot, writeGroupsSnapshot } =
      await import('./container-runner.js');
    // Should not throw
    await writeTasksSnapshot('folder', {});
    await writeGroupsSnapshot([]);
  });
});
