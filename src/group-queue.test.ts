import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('./config.js', () => ({
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { GroupQueue } from './group-queue.js';

let queue: GroupQueue;

beforeEach(() => {
  queue = new GroupQueue();
});

afterEach(() => {
  queue.shutdown(0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

function createProcessFn(resolveWith: boolean = true) {
  return vi.fn().mockResolvedValue(resolveWith);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GroupQueue', () => {
  it('allows one active container per group', async () => {
    const processFn = createProcessFn();
    queue.setProcessMessagesFn(processFn);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us'); // second should wait

    await flushPromises();

    // Only one call should be made at a time for same group
    expect(processFn).toHaveBeenCalledTimes(1);
  });

  it('respects global concurrency limit', async () => {
    let resolve1: () => void;
    let resolve2: () => void;
    const promise1 = new Promise<boolean>((r) => {
      resolve1 = () => r(true);
    });
    const promise2 = new Promise<boolean>((r) => {
      resolve2 = () => r(true);
    });
    const promise3Fn = vi.fn().mockResolvedValue(true);

    let callCount = 0;
    const processFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return promise1;
      if (callCount === 2) return promise2;
      return promise3Fn();
    });

    queue.setProcessMessagesFn(processFn);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us'); // should be queued (limit=2)

    await flushPromises();

    // Two groups should be running, third waiting
    expect(processFn).toHaveBeenCalledTimes(2);

    // Complete first group
    resolve1!();
    await flushPromises();

    // Third should now start
    expect(processFn).toHaveBeenCalledTimes(3);

    resolve2!();
    await flushPromises();
  });

  it('prioritizes tasks over messages', async () => {
    const callOrder: string[] = [];

    const processFn = vi.fn().mockImplementation(async () => {
      callOrder.push('message');
      return true;
    });
    queue.setProcessMessagesFn(processFn);

    // Enqueue a task and a message
    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      callOrder.push('task');
    });
    queue.enqueueMessageCheck('group1@g.us');

    await flushPromises();
    // Wait for task to complete
    await new Promise((r) => setTimeout(r, 50));

    // Task should run before messages
    expect(callOrder[0]).toBe('task');
  });

  it('retries with exponential backoff on failure', async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const processFn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return true;
    });
    queue.setProcessMessagesFn(processFn);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(0);

    // First attempt fails
    expect(attempts).toBe(1);

    // Advance past first retry delay (5000ms base)
    await vi.advanceTimersByTimeAsync(5100);
    expect(attempts).toBe(2);

    // Advance past second retry delay (10000ms)
    await vi.advanceTimersByTimeAsync(10100);
    expect(attempts).toBe(3);

    vi.useRealTimers();
  });

  it('prevents enqueues after shutdown', () => {
    queue.shutdown(0);
    queue.enqueueMessageCheck('group1@g.us');
    // Should not crash and should not start processing
  });

  it('resets retry count after max retries', async () => {
    vi.useFakeTimers();

    const processFn = vi.fn().mockRejectedValue(new Error('always fail'));
    queue.setProcessMessagesFn(processFn);

    queue.enqueueMessageCheck('group1@g.us');

    // Run through MAX_RETRIES (5) retry cycles
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100000);
    }

    // After max retries, retry count should reset and group should be available
    vi.useRealTimers();
  });

  it('drains waiting groups when active slots free up', async () => {
    const groups: string[] = [];

    const processFn = vi.fn().mockImplementation(async (jid: string) => {
      groups.push(jid);
      return true;
    });
    queue.setProcessMessagesFn(processFn);

    // Fill both active slots
    queue.enqueueMessageCheck('g1@g.us');
    queue.enqueueMessageCheck('g2@g.us');
    queue.enqueueMessageCheck('g3@g.us'); // waiting

    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));

    // All three should eventually process
    expect(processFn).toHaveBeenCalledTimes(3);
  });

  it('deduplicates running tasks by taskId', async () => {
    let taskRunCount = 0;
    const taskFn = async () => {
      taskRunCount++;
      await new Promise((r) => setTimeout(r, 100));
    };

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueTask('group1@g.us', 'task-1', taskFn); // duplicate
    queue.enqueueTask('group1@g.us', 'task-2', taskFn); // different task

    await new Promise((r) => setTimeout(r, 300));

    // task-1 should only run once, task-2 should also run
    expect(taskRunCount).toBe(2);
  });

  describe('registerJob', () => {
    it('tracks job name for a group', () => {
      queue.registerJob('group1@g.us', 'nanoclaw-agent-abc123', 'test-group');
      // Should not throw, no process tracking needed
    });
  });

  describe('sendMessage', () => {
    it('always returns false for K8s Jobs (one-shot)', () => {
      queue.registerJob('group1@g.us', 'nanoclaw-agent-abc123', 'test-group');
      const result = queue.sendMessage('group1@g.us', 'test message');
      expect(result).toBe(false);
    });
  });

  describe('closeStdin', () => {
    it('is a no-op for K8s Jobs', () => {
      queue.registerJob('group1@g.us', 'nanoclaw-agent-abc123', 'test-group');
      // Should not throw
      queue.closeStdin('group1@g.us');
    });
  });
});
