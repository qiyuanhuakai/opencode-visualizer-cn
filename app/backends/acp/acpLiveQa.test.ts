// @vitest-environment node
// Manual-QA integration probe against a REAL vis_bridge + Oh My Pi instance.
import { describe, expect, it } from 'vitest';
import { AcpClient, type AcpClientEvent } from './acpClient';
import { parseAcpSelectOptions } from './configOptions';

const BRIDGE = process.env.ACP_LIVE_QA;
const REQUIRED_FIXTURE_VARIABLES = [
  'ACP_LIVE_QA_CWD',
  'ACP_LIVE_QA_SESSION_ID',
  'ACP_LIVE_QA_EXPECTED_MODEL',
  'ACP_LIVE_QA_EXPECTED_AGENT',
  'ACP_LIVE_QA_EXPECTED_UPDATED_AT',
  'ACP_LIVE_QA_TARGET_MODEL',
  'ACP_LIVE_QA_TARGET_MODE',
] as const;

type RequiredFixtureVariable = (typeof REQUIRED_FIXTURE_VARIABLES)[number];

type LiveQaFixture = {
  readonly bridge: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly expectedModel: string;
  readonly expectedAgent: string;
  readonly expectedUpdatedAt: number;
  readonly targetModel: string;
  readonly targetMode: string;
};

function requiredFixtureVariable(name: RequiredFixtureVariable) {
  const value = process.env[name];
  if (!value) throw new Error(`ACP_LIVE_QA requires ${name} before connecting.`);
  return value;
}

function readLiveQaFixture(bridge: string): LiveQaFixture {
  const missing = REQUIRED_FIXTURE_VARIABLES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `ACP_LIVE_QA requires dedicated fixture variables before connecting: ${missing.join(', ')}.`,
    );
  }
  const expectedUpdatedAt = Date.parse(requiredFixtureVariable('ACP_LIVE_QA_EXPECTED_UPDATED_AT'));
  if (!Number.isFinite(expectedUpdatedAt)) {
    throw new Error('ACP_LIVE_QA_EXPECTED_UPDATED_AT must be an ISO-8601 timestamp.');
  }
  return {
    bridge,
    cwd: requiredFixtureVariable('ACP_LIVE_QA_CWD'),
    sessionId: requiredFixtureVariable('ACP_LIVE_QA_SESSION_ID'),
    expectedModel: requiredFixtureVariable('ACP_LIVE_QA_EXPECTED_MODEL'),
    expectedAgent: requiredFixtureVariable('ACP_LIVE_QA_EXPECTED_AGENT'),
    expectedUpdatedAt,
    targetModel: requiredFixtureVariable('ACP_LIVE_QA_TARGET_MODEL'),
    targetMode: requiredFixtureVariable('ACP_LIVE_QA_TARGET_MODE'),
  };
}

function createLiveQaClient(fixture: LiveQaFixture) {
  return new AcpClient({
    url: `${fixture.bridge}/acp/oh-my-pi`,
    agentId: 'oh-my-pi',
  });
}

async function loadDedicatedFixture(client: AcpClient, fixture: LiveQaFixture) {
  const sessions = await client.listSessions({ directory: fixture.cwd });
  const target = sessions.find(
    (session) => session.id === fixture.sessionId && session.directory === fixture.cwd,
  );
  if (!target) {
    throw new Error(`Dedicated ACP fixture ${fixture.sessionId} was not listed at ${fixture.cwd}.`);
  }
  return target;
}

function configValue(options: unknown[], category: 'model' | 'mode') {
  const option = parseAcpSelectOptions(options).find(
    (candidate) => candidate.category === category || candidate.id === category,
  );
  if (!option) throw new Error(`Dedicated ACP fixture has no ${category} config option.`);
  return option.currentValue;
}

const FIXTURE = BRIDGE ? readLiveQaFixture(BRIDGE) : null;

describe.skipIf(!FIXTURE)('ACP live QA against real Oh My Pi', () => {
  it('replays history with stable order, config-derived agent/model, and replay flags', async () => {
    if (!FIXTURE) throw new Error('ACP live QA fixture was not configured.');
    const events: AcpClientEvent[] = [];
    const client = createLiveQaClient(FIXTURE);
    client.onEvent((event) => events.push(event));
    try {
      const init = await client.initialize();
      expect(init.agentInfo?.name).toBe('oh-my-pi');

      const target = await loadDedicatedFixture(client, FIXTURE);
      console.log(
        '[QA] dedicated fixture:',
        JSON.stringify({
          id: target.id,
          updated: target.time?.updated,
          updatedISO: target.time?.updated ? new Date(target.time.updated).toISOString() : null,
        }),
      );

      events.length = 0;
      const entries = await client.listSessionMessages(target.id, target.directory);
      expect(entries.length).toBeGreaterThan(0);

      // 1. Ordering: created times strictly increasing in display order.
      const created = entries.map((entry) => entry.info.time.created);
      const roles = entries.map((entry) => entry.info.role);
      console.log('[QA] roles:', roles.join(','));
      console.log(
        '[QA] created deltas:',
        created
          .slice(1)
          .map((time, index) => time - created[index])
          .join(','),
      );
      for (let index = 1; index < created.length; index += 1) {
        const current = created[index];
        const previous = created[index - 1];
        if (current === undefined || previous === undefined) {
          throw new Error('Replay ordering lost an indexed entry.');
        }
        expect(current).toBeGreaterThan(previous);
      }

      // 2. Agent/model attribution from session config options (not hardcoded default).
      const userEntry = entries.find((entry) => entry.info.role === 'user');
      expect(userEntry).toBeDefined();
      if (userEntry?.info.role === 'user') {
        console.log(
          '[QA] user agent/model:',
          userEntry.info.agent,
          JSON.stringify(userEntry.info.model),
        );
        expect(userEntry.info.agent).toBe(FIXTURE.expectedAgent);
        expect(userEntry.info.model.modelID).toBe(FIXTURE.expectedModel);
      }

      // 3. Session updatedAt adopted from session_info_update.
      console.log(
        '[QA] configOptions after load:',
        JSON.stringify(client.getConfigOptions()).slice(0, 400),
      );
      console.log('[QA] session time after load:', JSON.stringify(client.getSessionStatusMap()));
      const sessionUpdates = events
        .filter((event) => event.type === 'session.updated')
        .filter((event) => event.info.id === target.id);
      expect(
        sessionUpdates.some((event) => event.info.time?.updated === FIXTURE.expectedUpdatedAt),
      ).toBe(true);

      // 4. All replay events flagged replay=true (popup suppression).
      const partEvents = events.filter((event) => event.type === 'message.part.updated');
      console.log(
        '[QA] replay part events:',
        partEvents.length,
        'flagged:',
        partEvents.filter((event) => event.replay === true).length,
      );
      expect(partEvents.length).toBeGreaterThan(0);
      for (const event of partEvents) expect(event.replay).toBe(true);
    } finally {
      client.disconnect();
    }
  }, 60_000);

  it('syncSessionConfig pushes model/mode to a real Oh My Pi session', async () => {
    if (!FIXTURE) throw new Error('ACP live QA fixture was not configured.');
    const client = createLiveQaClient(FIXTURE);
    let original: { readonly model: string; readonly mode: string } | null = null;
    try {
      await client.initialize();
      const session = await loadDedicatedFixture(client, FIXTURE);
      await client.listSessionMessages(session.id, session.directory);
      original = {
        model: configValue(client.getConfigOptions(), 'model'),
        mode: configValue(client.getConfigOptions(), 'mode'),
      };
      await client.syncSessionConfig(session.id, {
        model: FIXTURE.targetModel,
        mode: FIXTURE.targetMode,
      });
      console.log(
        '[QA] after sync model/mode:',
        configValue(client.getConfigOptions(), 'model'),
        '|',
        configValue(client.getConfigOptions(), 'mode'),
      );
      expect(configValue(client.getConfigOptions(), 'model')).toBe(FIXTURE.targetModel);
      expect(configValue(client.getConfigOptions(), 'mode')).toBe(FIXTURE.targetMode);
    } finally {
      try {
        if (original) {
          await client.syncSessionConfig(FIXTURE.sessionId, original);
          expect(configValue(client.getConfigOptions(), 'model')).toBe(original.model);
          expect(configValue(client.getConfigOptions(), 'mode')).toBe(original.mode);
        }
      } finally {
        client.disconnect();
      }
    }
  }, 60_000);
});
