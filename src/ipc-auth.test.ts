import { describe, it, expect, beforeEach, vi } from 'vitest';

import { processTaskIpc, IpcDeps } from './ipc.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';
import type { AvailableGroup } from './container-runner.js';

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main Group',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other Group',
  folder: 'other-group',
  trigger: 'always',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
  isMain: false,
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third Group',
  folder: 'third-group',
  trigger: 'always',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
  isMain: false,
};

// ---------------------------------------------------------------------------
// Test deps
// ---------------------------------------------------------------------------
let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(async () => {
  await _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  await setRegisteredGroup('main@g.us', MAIN_GROUP);
  await setRegisteredGroup('other@g.us', OTHER_GROUP);
  await setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: async (jid: string, name: string, folder: string) => {
      const newGroup: RegisteredGroup = {
        name,
        folder,
        trigger: 'always',
        added_at: new Date().toISOString(),
        requiresTrigger: true,
        isMain: false,
      };
      groups[jid] = newGroup;
      await setRegisteredGroup(jid, newGroup);
    },
    syncGroups: async () => {},
    getAvailableGroups: (): AvailableGroup[] => [],
    writeGroupsSnapshot: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Helper: build schedule_task payload
// ---------------------------------------------------------------------------
function schedulePayload(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'test prompt',
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 60000).toISOString(),
    chat_jid: 'chat@g.us',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schedule_task authorization
// ---------------------------------------------------------------------------
describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ targetJid: 'other@g.us' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for own group', async () => {
    await processTaskIpc(
      deps,
      OTHER_GROUP.folder,
      'schedule_task',
      schedulePayload(),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      deps,
      OTHER_GROUP.folder,
      'schedule_task',
      schedulePayload({ targetJid: 'third@g.us' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });

  it('rejects scheduling for unregistered target', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ targetJid: 'unknown@g.us' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pause_task authorization
// ---------------------------------------------------------------------------
describe('pause_task authorization', () => {
  let taskId: string;

  beforeEach(async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ id: 'task-1', targetJid: 'other@g.us' }),
    );
    taskId = 'task-1';
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'pause_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('paused');
  });

  it('group can pause own task', async () => {
    await processTaskIpc(deps, OTHER_GROUP.folder, 'pause_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('paused');
  });

  it('foreign group cannot pause task', async () => {
    await processTaskIpc(deps, THIRD_GROUP.folder, 'pause_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// resume_task authorization
// ---------------------------------------------------------------------------
describe('resume_task authorization', () => {
  let taskId: string;

  beforeEach(async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ id: 'task-1', targetJid: 'other@g.us' }),
    );
    taskId = 'task-1';
    await processTaskIpc(deps, MAIN_GROUP.folder, 'pause_task', {
      id: taskId,
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'resume_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('active');
  });

  it('group can resume own task', async () => {
    await processTaskIpc(deps, OTHER_GROUP.folder, 'resume_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('active');
  });

  it('foreign group cannot resume task', async () => {
    await processTaskIpc(deps, THIRD_GROUP.folder, 'resume_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task?.status).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// cancel_task authorization
// ---------------------------------------------------------------------------
describe('cancel_task authorization', () => {
  let taskId: string;

  beforeEach(async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ id: 'task-1', targetJid: 'other@g.us' }),
    );
    taskId = 'task-1';
  });

  it('main group can cancel any task', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'cancel_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task).toBeNull();
  });

  it('group can cancel own task', async () => {
    await processTaskIpc(deps, OTHER_GROUP.folder, 'cancel_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task).toBeNull();
  });

  it('foreign group cannot cancel task', async () => {
    await processTaskIpc(deps, THIRD_GROUP.folder, 'cancel_task', {
      id: taskId,
    });
    const task = await getTaskById(taskId);
    expect(task).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// register_group authorization
// ---------------------------------------------------------------------------
describe('register_group authorization', () => {
  it('non-main cannot register groups', async () => {
    await processTaskIpc(deps, OTHER_GROUP.folder, 'register_group', {
      jid: 'new@g.us',
      name: 'New Group',
      folder: 'new-group',
    });
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('rejects unsafe folder path', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'register_group', {
      jid: 'new@g.us',
      name: 'New Group',
      folder: '../../etc',
    });
    expect(groups['new@g.us']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refresh_groups authorization
// ---------------------------------------------------------------------------
describe('refresh_groups authorization', () => {
  it('non-main cannot refresh groups', async () => {
    const syncSpy = vi.fn(async () => {});
    deps.syncGroups = syncSpy;
    await processTaskIpc(deps, OTHER_GROUP.folder, 'refresh_groups', {});
    expect(syncSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// schedule_task – schedule types
// ---------------------------------------------------------------------------
describe('schedule types', () => {
  it('accepts cron schedule', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ schedule_type: 'cron', schedule_value: '0 9 * * *' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].schedule_type).toBe('cron');
  });

  it('rejects invalid cron', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ schedule_type: 'cron', schedule_value: 'not-a-cron' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });

  it('accepts interval schedule', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({
        schedule_type: 'interval',
        schedule_value: '3600000',
      }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].schedule_type).toBe('interval');
  });

  it('rejects invalid interval', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ schedule_type: 'interval', schedule_value: 'abc' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });

  it('rejects zero interval', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ schedule_type: 'interval', schedule_value: '0' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ schedule_type: 'once', schedule_value: 'not-a-date' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// schedule_task – context_mode
// ---------------------------------------------------------------------------
describe('context_mode', () => {
  it('defaults to isolated', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ context_mode: undefined }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('accepts group context_mode', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ context_mode: 'group' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts isolated context_mode', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ context_mode: 'isolated' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('invalid context_mode defaults to isolated', async () => {
    await processTaskIpc(
      deps,
      MAIN_GROUP.folder,
      'schedule_task',
      schedulePayload({ context_mode: 'bogus' }),
    );
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// ---------------------------------------------------------------------------
// register_group – success
// ---------------------------------------------------------------------------
describe('register_group success', () => {
  it('main can register a new group', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'register_group', {
      jid: 'new@g.us',
      name: 'New Group',
      folder: 'new-group',
    });
    expect(groups['new@g.us']).toBeDefined();
    expect(groups['new@g.us'].folder).toBe('new-group');
    const persisted = await getRegisteredGroup('new@g.us');
    expect(persisted).not.toBeNull();
  });

  it('rejects when required fields are missing', async () => {
    await processTaskIpc(deps, MAIN_GROUP.folder, 'register_group', {
      jid: 'new@g.us',
      // missing name and folder
    });
    expect(groups['new@g.us']).toBeUndefined();
  });
});
