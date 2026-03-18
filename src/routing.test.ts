import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(async () => {
  await _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---
// NOTE: In K8s mode, getAvailableGroups() returns from the in-memory registeredGroups map,
// NOT from the DB. Tests are adapted to use _setRegisteredGroups() for setup.

describe('getAvailableGroups', () => {
  it('returns registered groups', () => {
    _setRegisteredGroups({
      'group1@g.us': {
        name: 'Group 1',
        folder: 'group1',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'group2@g.us': {
        name: 'Group 2',
        folder: 'group2',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
  });

  it('marks main group correctly', () => {
    _setRegisteredGroups({
      'main@g.us': {
        name: 'Main',
        folder: 'whatsapp_main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
      'other@g.us': {
        name: 'Other',
        folder: 'other',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const main = groups.find((g) => g.jid === 'main@g.us');
    const other = groups.find((g) => g.jid === 'other@g.us');

    expect(main?.isMain).toBe(true);
    expect(other?.isMain).toBeFalsy();
  });

  it('returns empty array when no groups registered', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
