import pg from 'pg';

import { ASSISTANT_NAME, DATABASE_URL } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let pool: pg.Pool;

/** Get the shared connection pool (for use by IPC listener, etc.) */
export function getPool(): pg.Pool {
  return pool;
}

async function createSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me BOOLEAN DEFAULT FALSE,
      is_bot_message BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger BOOLEAN DEFAULT TRUE,
      is_main BOOLEAN DEFAULT FALSE
    );
  `);
}

export async function initDatabase(): Promise<void> {
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 10,
  });

  // Verify connectivity
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }

  await createSchema();
  logger.info('PostgreSQL database initialized');
}

/** @internal - for tests only. Uses a separate pool pointing at the same or a test DB. */
export async function _initTestDatabase(connString?: string): Promise<void> {
  pool = new pg.Pool({
    connectionString: connString || DATABASE_URL,
    max: 2,
  });
  await createSchema();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup;

  if (name) {
    await pool.query(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(jid) DO UPDATE SET
        name = EXCLUDED.name,
        last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
        channel = COALESCE(EXCLUDED.channel, chats.channel),
        is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
    `,
      [chatJid, name, timestamp, ch, group],
    );
  } else {
    await pool.query(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
        channel = COALESCE(EXCLUDED.channel, chats.channel),
        is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
    `,
      [chatJid, chatJid, timestamp, ch, group],
    );
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export async function updateChatName(
  chatJid: string,
  name: string,
): Promise<void> {
  await pool.query(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES ($1, $2, $3)
    ON CONFLICT(jid) DO UPDATE SET name = EXCLUDED.name
  `,
    [chatJid, name, new Date().toISOString()],
  );
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: boolean;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export async function getAllChats(): Promise<ChatInfo[]> {
  const { rows } = await pool.query(
    `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
  );
  return rows as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export async function getLastGroupSync(): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
  );
  return rows[0]?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export async function setLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', $1)
     ON CONFLICT(jid) DO UPDATE SET last_message_time = EXCLUDED.last_message_time`,
    [now],
  );
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export async function storeMessage(msg: NewMessage): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id, chat_jid) DO UPDATE SET
       sender = EXCLUDED.sender,
       sender_name = EXCLUDED.sender_name,
       content = EXCLUDED.content,
       timestamp = EXCLUDED.timestamp,
       is_from_me = EXCLUDED.is_from_me,
       is_bot_message = EXCLUDED.is_bot_message`,
    [
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ?? false,
      msg.is_bot_message ?? false,
    ],
  );
}

/**
 * Store a message directly.
 */
export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id, chat_jid) DO UPDATE SET
       sender = EXCLUDED.sender,
       sender_name = EXCLUDED.sender_name,
       content = EXCLUDED.content,
       timestamp = EXCLUDED.timestamp,
       is_from_me = EXCLUDED.is_from_me,
       is_bot_message = EXCLUDED.is_bot_message`,
    [
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me,
      msg.is_bot_message ?? false,
    ],
  );
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  // Build parameterized IN clause: $1=lastTimestamp, $2..$N+1=jids, $N+2=botPrefix pattern, $N+3=limit
  const jidParams = jids.map((_, i) => `$${i + 2}`).join(',');
  const botPrefixParam = `$${jids.length + 2}`;
  const limitParam = `$${jids.length + 3}`;

  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > $1 AND chat_jid IN (${jidParams})
        AND is_bot_message = FALSE AND content NOT LIKE ${botPrefixParam}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limitParam}
    ) sub ORDER BY timestamp
  `;

  const params = [lastTimestamp, ...jids, `${botPrefix}:%`, limit];
  const { rows } = await pool.query(sql, params);

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows as NewMessage[], newTimestamp };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = $1 AND timestamp > $2
        AND is_bot_message = FALSE AND content NOT LIKE $3
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT $4
    ) sub ORDER BY timestamp
  `;
  const { rows } = await pool.query(sql, [
    chatJid,
    sinceTimestamp,
    `${botPrefix}:%`,
    limit,
  ]);
  return rows as NewMessage[];
}

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await pool.query(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `,
    [
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.next_run,
      task.status,
      task.created_at,
    ],
  );
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE id = $1',
    [id],
  );
  return rows[0] as ScheduledTask | undefined;
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE group_folder = $1 ORDER BY created_at DESC',
    [groupFolder],
  );
  return rows as ScheduledTask[];
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  return rows as ScheduledTask[];
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.prompt !== undefined) {
    fields.push(`prompt = $${paramIndex++}`);
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push(`schedule_type = $${paramIndex++}`);
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push(`schedule_value = $${paramIndex++}`);
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push(`next_run = $${paramIndex++}`);
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<void> {
  // Delete child records first (FK constraint)
  await pool.query('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
  await pool.query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= $1
    ORDER BY next_run
  `,
    [now],
  );
  return rows as ScheduledTask[];
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `
    UPDATE scheduled_tasks
    SET next_run = $1, last_run = $2, last_result = $3, status = CASE WHEN $1 IS NULL THEN 'completed' ELSE status END
    WHERE id = $4
  `,
    [nextRun, now, lastResult, id],
  );
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await pool.query(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES ($1, $2, $3, $4, $5, $6)
  `,
    [
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    ],
  );
}

// --- Router state accessors ---

export async function getRouterState(key: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    'SELECT value FROM router_state WHERE key = $1',
    [key],
  );
  return rows[0]?.value;
}

export async function setRouterState(
  key: string,
  value: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO router_state (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

// --- Session accessors ---

export async function getSession(
  groupFolder: string,
): Promise<string | undefined> {
  const { rows } = await pool.query(
    'SELECT session_id FROM sessions WHERE group_folder = $1',
    [groupFolder],
  );
  return rows[0]?.session_id;
}

export async function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (group_folder, session_id) VALUES ($1, $2)
     ON CONFLICT(group_folder) DO UPDATE SET session_id = EXCLUDED.session_id`,
    [groupFolder, sessionId],
  );
}

export async function getAllSessions(): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    'SELECT group_folder, session_id FROM sessions',
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM registered_groups WHERE jid = $1',
    [jid],
  );
  const row = rows[0] as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: boolean | null;
        is_main: boolean | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger,
    isMain: row.is_main === true ? true : undefined,
  };
}

export async function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  await pool.query(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(jid) DO UPDATE SET
       name = EXCLUDED.name,
       folder = EXCLUDED.folder,
       trigger_pattern = EXCLUDED.trigger_pattern,
       added_at = EXCLUDED.added_at,
       container_config = EXCLUDED.container_config,
       requires_trigger = EXCLUDED.requires_trigger,
       is_main = EXCLUDED.is_main`,
    [
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? true : group.requiresTrigger,
      group.isMain ?? false,
    ],
  );
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const { rows } = await pool.query('SELECT * FROM registered_groups');
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger,
      isMain: row.is_main === true ? true : undefined,
    };
  }
  return result;
}
