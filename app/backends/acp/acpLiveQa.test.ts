// @vitest-environment node
// Manual-QA integration probe against a REAL vis_bridge + Oh My Pi instance.
// Not part of the default suite: run explicitly with
//   ACP_LIVE_QA=ws://127.0.0.1:2399 pnpm vitest run app/backends/acp/acpLiveQa.test.ts
import { describe, expect, it } from 'vitest';
import { AcpClient, type AcpClientEvent } from './acpClient';

const BRIDGE = process.env.ACP_LIVE_QA;
const SESSION_CWD = process.env.ACP_LIVE_QA_CWD ?? '/home/qiyuaner/apps/vis_app/vis.thirdend';

describe.skipIf(!BRIDGE)('ACP live QA against real Oh My Pi', () => {
  it('replays history with stable order, config-derived agent/model, and replay flags', async () => {
    const events: AcpClientEvent[] = [];
    const client = new AcpClient({
      url: `${BRIDGE}/acp/oh-my-pi`,
      agentId: 'oh-my-pi',
    });
    client.onEvent((event) => events.push(event));
    try {
      const init = await client.initialize();
      expect(init.agentInfo?.name).toBe('oh-my-pi');

      const sessions = await client.listSessions({ directory: SESSION_CWD });
      expect(sessions.length).toBeGreaterThan(0);
      const target = sessions.find((session) => session.directory === SESSION_CWD) ?? sessions[0]!;
      console.log('[QA] session/list first:', JSON.stringify({
        id: target.id,
        updated: target.time?.updated,
        updatedISO: target.time?.updated ? new Date(target.time.updated).toISOString() : null,
      }));

      events.length = 0;
      const entries = await client.listSessionMessages(target.id, target.directory);
      expect(entries.length).toBeGreaterThan(0);

      // 1. Ordering: created times strictly increasing in display order.
      const created = entries.map((entry) => entry.info.time.created);
      const roles = entries.map((entry) => entry.info.role);
      console.log('[QA] roles:', roles.join(','));
      console.log('[QA] created deltas:', created.slice(1).map((t, i) => t - created[i]!).join(','));
      for (let index = 1; index < created.length; index += 1) {
        expect(created[index]).toBeGreaterThan(created[index - 1]!);
      }

      // 2. Agent/model attribution from session config options (not hardcoded default).
      const userEntry = entries.find((entry) => entry.info.role === 'user');
      expect(userEntry).toBeDefined();
      if (userEntry?.info.role === 'user') {
        console.log('[QA] user agent/model:', userEntry.info.agent, JSON.stringify(userEntry.info.model));
        expect(userEntry.info.model.modelID).not.toBe('');
      }

      // 3. Session updatedAt adopted from session_info_update.
      // 3. Config options visible after load (evidence for attribution timing).
      console.log('[QA] configOptions after load:', JSON.stringify(client.getConfigOptions()).slice(0, 400));
      console.log('[QA] session time after load:', JSON.stringify(client.getSessionStatusMap()));

      // 4. All replay events flagged replay=true (popup suppression).
      const partEvents = events.filter((event) => event.type === 'message.part.updated');
      console.log('[QA] replay part events:', partEvents.length,
        'flagged:', partEvents.filter((event) => event.replay === true).length);
      expect(partEvents.length).toBeGreaterThan(0);
      for (const event of partEvents) expect(event.replay).toBe(true);
    } finally {
      client.disconnect();
    }
  }, 60_000);

  it('syncSessionConfig pushes model/mode to a real Oh My Pi session', async () => {
    const client = new AcpClient({
      url: `${BRIDGE}/acp/oh-my-pi`,
      agentId: 'oh-my-pi',
    });
    try {
      await client.initialize();
      const session = await client.createSession('/tmp');
      await client.syncSessionConfig(session.id, {
        model: 'lm-studio/qwen3.6-28b-reap-i1',
        mode: 'plan',
      });
      const options = client.getConfigOptions() as Array<{ id: string; currentValue: string }>;
      const model = options.find((option) => option.id === 'model');
      const mode = options.find((option) => option.id === 'mode');
      console.log('[QA] after sync model:', model?.currentValue, '| mode:', mode?.currentValue);
      expect(model?.currentValue).toBe('lm-studio/qwen3.6-28b-reap-i1');
      expect(mode?.currentValue).toBe('plan');
    } finally {
      client.disconnect();
    }
  }, 60_000);
});
