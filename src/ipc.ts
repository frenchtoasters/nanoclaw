/**
 * IPC (Inter-Process Communication) for NanoClaw — PostgreSQL LISTEN/NOTIFY Edition
 *
 * Agent K8s Jobs write commands to the `ipc_commands` table and call pg_notify('ipc').
 * The orchestrator listens on the `ipc` channel and processes commands as they arrive.
 */
import pg from 'pg';

import {
  createTask,
  deleteTask,
  getPool,
  getTaskById,
  updateTask,
} from './db.js';
import { DATABASE_URL } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { computeNextRun } from './task-scheduler.js';
import { AvailableGroup } from './container-runner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpcDeps {
  sendMessage: (
    groupFolder: string,
    chatJid: string,
    text: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, name: string, folder: string) => Promise<void>;
  syncGroups: () => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (groups: AvailableGroup[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let listenerClient: pg.Client | null = null;

async function ensureIpcSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ipc_commands (
      id SERIAL PRIMARY KEY,
      group_folder TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      processed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ipc_unprocessed
      ON ipc_commands(processed) WHERE processed = FALSE;
  `);
}

// ---------------------------------------------------------------------------
// Command processing
// ---------------------------------------------------------------------------

/** Drain all unprocessed IPC commands from the database */
async function processIpcCommands(deps: IpcDeps): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT * FROM ipc_commands WHERE processed = FALSE ORDER BY id ASC LIMIT 100`,
  );

  for (const row of rows) {
    try {
      if (row.command_type === 'message') {
        await processMessageIpc(deps, row.group_folder, row.payload);
      } else {
        await processTaskIpc(
          deps,
          row.group_folder,
          row.command_type,
          row.payload,
        );
      }
    } catch (err) {
      logger.error(
        { id: row.id, command_type: row.command_type, err },
        'Failed to process IPC command',
      );
    }
    // Mark processed regardless — failed commands are logged, not retried forever
    await pool.query('UPDATE ipc_commands SET processed = TRUE WHERE id = $1', [
      row.id,
    ]);
  }
}

/** Route an outbound message from agent to channel */
async function processMessageIpc(
  deps: IpcDeps,
  groupFolder: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const chatJid =
    (payload.chatJid as string) ?? (payload.chat_jid as string) ?? '';
  const text =
    (payload.text as string) ??
    (payload.content as string) ??
    (payload.message as string) ??
    '';

  if (!chatJid || !text) {
    logger.warn(
      { groupFolder, payload },
      'Invalid message IPC: missing chatJid or text',
    );
    return;
  }

  await deps.sendMessage(groupFolder, chatJid, text);
  logger.info({ groupFolder, chatJid }, 'Routed IPC message to channel');
}

/** Check if a group folder belongs to the main (elevated) group */
function isMainGroup(groupFolder: string, deps: IpcDeps): boolean {
  const groups = deps.registeredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === groupFolder && group.isMain) return true;
  }
  return false;
}

/** Process a task-related IPC command */
export async function processTaskIpc(
  deps: IpcDeps,
  groupFolder: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const isMain = isMainGroup(groupFolder, deps);

  switch (commandType) {
    case 'schedule_task': {
      // Resolve target group from targetJid
      const targetJid =
        (payload.targetJid as string) ?? (payload.target_jid as string);
      let targetFolder = groupFolder;
      let targetChatJid =
        (payload.chat_jid as string) ?? (payload.chatJid as string) ?? '';

      if (targetJid) {
        const groups = deps.registeredGroups();
        const targetGroup = groups[targetJid];
        if (!targetGroup) {
          logger.warn(
            { targetJid, groupFolder },
            'schedule_task: target JID not registered',
          );
          break;
        }
        // Authorization: non-main can only schedule for own group
        if (!isMain && targetGroup.folder !== groupFolder) {
          logger.warn(
            { targetJid, groupFolder },
            'schedule_task: unauthorized cross-group',
          );
          break;
        }
        targetFolder = targetGroup.folder;
        if (!targetChatJid) targetChatJid = targetJid;
      }

      // Validate schedule
      const scheduleType = ((payload.schedule_type as string) ??
        (payload.scheduleType as string) ??
        'once') as ScheduledTask['schedule_type'];
      const scheduleValue =
        (payload.schedule_value as string) ??
        (payload.scheduleValue as string) ??
        '';

      // Validate context_mode
      const rawContextMode =
        (payload.context_mode as string) ??
        (payload.contextMode as string) ??
        'isolated';
      const contextMode =
        rawContextMode === 'group' || rawContextMode === 'isolated'
          ? rawContextMode
          : 'isolated';

      const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
        id:
          (payload.id as string) ??
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        group_folder: targetFolder,
        chat_jid: targetChatJid,
        prompt: (payload.prompt as string) ?? '',
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode as ScheduledTask['context_mode'],
        next_run: null,
        status: 'active',
        created_at: new Date().toISOString(),
      };

      const nextRun = computeNextRun({
        ...task,
        last_run: null,
        last_result: null,
      } as ScheduledTask);
      if (nextRun === null && scheduleType !== 'once') {
        logger.warn(
          { groupFolder, scheduleType, scheduleValue },
          'schedule_task: invalid schedule',
        );
        break;
      }
      // For 'once' type, validate the date
      if (scheduleType === 'once') {
        const d = new Date(scheduleValue);
        if (isNaN(d.getTime())) {
          logger.warn(
            { groupFolder, scheduleValue },
            'schedule_task: invalid once timestamp',
          );
          break;
        }
        task.next_run = d.toISOString();
      } else {
        task.next_run = nextRun;
      }
      // For cron, validate by checking if computeNextRun returned null
      if (scheduleType === 'cron' && nextRun === null) {
        logger.warn(
          { groupFolder, scheduleValue },
          'schedule_task: invalid cron expression',
        );
        break;
      }
      // For interval, validate numeric > 0
      if (scheduleType === 'interval') {
        const ms = Number(scheduleValue);
        if (isNaN(ms) || ms <= 0) {
          logger.warn(
            { groupFolder, scheduleValue },
            'schedule_task: invalid interval',
          );
          break;
        }
      }

      await createTask(task);
      logger.info({ taskId: task.id, groupFolder }, 'Scheduled task via IPC');
      break;
    }

    case 'pause_task': {
      const taskId = taskIdFrom(payload);
      const task = await getTaskById(taskId);
      if (!task) {
        logger.warn({ taskId }, 'pause_task: task not found');
        break;
      }
      if (!isMain && task.group_folder !== groupFolder) {
        logger.warn({ taskId, groupFolder }, 'pause_task: unauthorized');
        break;
      }
      await updateTask(taskId, { status: 'paused' });
      logger.info({ taskId }, 'Paused task via IPC');
      break;
    }

    case 'resume_task': {
      const taskId = taskIdFrom(payload);
      const task = await getTaskById(taskId);
      if (!task) {
        logger.warn({ taskId }, 'resume_task: task not found');
        break;
      }
      if (!isMain && task.group_folder !== groupFolder) {
        logger.warn({ taskId, groupFolder }, 'resume_task: unauthorized');
        break;
      }
      const nextRun = computeNextRun(task);
      await updateTask(taskId, { status: 'active', next_run: nextRun });
      logger.info({ taskId }, 'Resumed task via IPC');
      break;
    }

    case 'cancel_task': {
      const taskId = taskIdFrom(payload);
      const task = await getTaskById(taskId);
      if (!task) {
        logger.warn({ taskId }, 'cancel_task: task not found');
        break;
      }
      if (!isMain && task.group_folder !== groupFolder) {
        logger.warn({ taskId, groupFolder }, 'cancel_task: unauthorized');
        break;
      }
      await deleteTask(taskId);
      logger.info({ taskId }, 'Cancelled task via IPC');
      break;
    }

    case 'update_task': {
      const taskId = taskIdFrom(payload);
      const task = await getTaskById(taskId);
      if (!task) {
        logger.warn({ taskId }, 'update_task: task not found');
        break;
      }
      if (!isMain && task.group_folder !== groupFolder) {
        logger.warn({ taskId, groupFolder }, 'update_task: unauthorized');
        break;
      }

      const updates: Partial<
        Pick<
          ScheduledTask,
          'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
        >
      > = {};
      if (payload.prompt) updates.prompt = payload.prompt as string;
      if (payload.schedule_type || payload.scheduleType)
        updates.schedule_type = (payload.schedule_type ??
          payload.scheduleType) as ScheduledTask['schedule_type'];
      if (payload.schedule_value || payload.scheduleValue)
        updates.schedule_value = (payload.schedule_value ??
          payload.scheduleValue) as string;
      if (payload.status)
        updates.status = payload.status as ScheduledTask['status'];

      await updateTask(taskId, updates);

      // Recompute next_run if schedule changed
      if (updates.schedule_type || updates.schedule_value) {
        const updated = await getTaskById(taskId);
        if (updated) {
          const nextRun = computeNextRun(updated);
          await updateTask(taskId, { next_run: nextRun });
        }
      }
      logger.info({ taskId }, 'Updated task via IPC');
      break;
    }

    case 'refresh_groups': {
      if (!isMain) {
        logger.warn({ groupFolder }, 'refresh_groups: unauthorized (not main)');
        break;
      }
      await deps.syncGroups();
      await deps.writeGroupsSnapshot(deps.getAvailableGroups());
      logger.info('Refreshed groups via IPC');
      break;
    }

    case 'register_group': {
      if (!isMain) {
        logger.warn({ groupFolder }, 'register_group: unauthorized (not main)');
        break;
      }
      const jid = payload.jid as string;
      const name = payload.name as string;
      const folder = payload.folder as string;
      if (!jid || !name || !folder) {
        logger.warn({ payload }, 'register_group: missing required fields');
        break;
      }
      if (!isValidGroupFolder(folder)) {
        logger.warn({ folder }, 'register_group: invalid/unsafe folder path');
        break;
      }
      await deps.registerGroup(jid, name, folder);
      logger.info({ jid, name, folder }, 'Registered group via IPC');
      break;
    }

    default:
      logger.warn({ commandType, groupFolder }, 'Unknown IPC command type');
  }
}

/** Extract a task ID from various payload shapes */
function taskIdFrom(payload: Record<string, unknown>): string {
  return (
    (payload.id as string) ??
    (payload.taskId as string) ??
    (payload.task_id as string) ??
    ''
  );
}

// ---------------------------------------------------------------------------
// Listener lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the IPC watcher using PostgreSQL LISTEN/NOTIFY.
 * Returns a cleanup function to tear down the listener.
 */
export async function startIpcWatcher(deps: IpcDeps): Promise<() => void> {
  await ensureIpcSchema();

  // Drain any commands queued before we started
  await processIpcCommands(deps);

  // Dedicated client for LISTEN (cannot use pooled connections)
  listenerClient = new pg.Client({ connectionString: DATABASE_URL });
  await listenerClient.connect();

  listenerClient.on('notification', async (msg) => {
    if (msg.channel === 'ipc') {
      try {
        await processIpcCommands(deps);
      } catch (err) {
        logger.error(
          { err },
          'Error processing IPC commands after notification',
        );
      }
    }
  });

  listenerClient.on('error', (err) => {
    logger.error({ err }, 'IPC listener client error — attempting reconnect');
    reconnectListener(deps);
  });

  await listenerClient.query('LISTEN ipc');
  logger.info('IPC watcher started (PostgreSQL LISTEN/NOTIFY)');

  // Fallback poll every 30 s in case a notification is missed
  const fallbackPoll = setInterval(async () => {
    try {
      await processIpcCommands(deps);
    } catch (err) {
      logger.error({ err }, 'Error in IPC fallback poll');
    }
  }, 30_000);

  return () => {
    clearInterval(fallbackPoll);
    if (listenerClient) {
      listenerClient.end().catch(() => {});
      listenerClient = null;
    }
  };
}

/** Reconnect the LISTEN client with exponential backoff */
async function reconnectListener(deps: IpcDeps): Promise<void> {
  if (listenerClient) {
    try {
      await listenerClient.end();
    } catch {
      /* ignore */
    }
    listenerClient = null;
  }

  let delay = 1000;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      listenerClient = new pg.Client({ connectionString: DATABASE_URL });
      await listenerClient.connect();

      listenerClient.on('notification', async (msg) => {
        if (msg.channel === 'ipc') {
          try {
            await processIpcCommands(deps);
          } catch (err) {
            logger.error(
              { err },
              'Error processing IPC commands after notification',
            );
          }
        }
      });

      listenerClient.on('error', (err) => {
        logger.error(
          { err },
          'IPC listener client error — attempting reconnect',
        );
        reconnectListener(deps);
      });

      await listenerClient.query('LISTEN ipc');
      logger.info('IPC listener reconnected');

      // Drain missed commands
      await processIpcCommands(deps);
      return;
    } catch (err) {
      logger.warn(
        { err, attempt, delay },
        'IPC listener reconnect failed, retrying…',
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  logger.error('IPC listener reconnect failed after 10 attempts');
}
