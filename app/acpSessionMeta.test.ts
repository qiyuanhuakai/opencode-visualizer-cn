import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadAcpSessionTurnMeta,
  parseKimiWireLog,
  parseOmpSessionLog,
} from '../bridge/acpSessionMeta.js';

// Real shapes captured from kimi-code 0.29.0 wire.jsonl and OMP 17.x session JSONL.
const KIMI_WIRE = `
{"type":"metadata","protocol_version":"1.4","created_at":1784688730548}
{"type":"config.update","profileName":"agent"}
{"type":"plan_mode.enter","id":"hercules-moon-knight-hawkgirl","time":1784688778474}
{"type":"permission.set_mode","mode":"manual","time":1784688778476}
{"type":"turn.prompt","input":[{"type":"text","text":"kimi测试消息"}],"origin":{"kind":"user"},"time":1784688779965}
{"type":"context.append_loop_event","event":{"type":"step.end","uuid":"x","turnId":"0","step":1},"time":1784688785000}
{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1100},"usageScope":"turn","time":1784688785500}
{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1142},"usageScope":"turn","time":1784688786000}
{"type":"turn.prompt","input":[{"type":"text","text":"kimi后端测试消息"}],"origin":{"kind":"user"},"time":1784697258226}
{"type":"usage.record","model":"kimi-code/kimi-for-coding-highspeed","usage":{"inputOther":7207},"usageScope":"turn","time":1784697261089}
{"type":"plan_mode.cancel","time":1784704438189}
{"type":"permission.set_mode","mode":"yolo","time":1784704438191}
{"type":"turn.prompt","input":[{"type":"text","text":"最后一轮"}],"origin":{"kind":"user"},"time":1784704440000}
{"type":"usage.record","model":"kimi-code/kimi-for-coding-highspeed","usage":{"inputOther":621},"usageScope":"turn","time":1784704445000}
`;

const OMP_LOG = `
{"type":"session","version":3,"id":"019f6e38","timestamp":"2026-07-17T03:57:15.862Z","cwd":"/home/qiyuaner/apps/vis_app/vis.thirdend"}
{"type":"model_change","id":"395d8c70","parentId":null,"timestamp":"2026-07-17T03:57:16.675Z","model":"step-plan/step-3.5-flash"}
{"type":"message","id":"b57580a9","parentId":"d0acd967","timestamp":"2026-07-17T03:57:24.199Z","message":{"role":"user","content":[{"type":"text","text":"你好"}],"attribution":"user","timestamp":1784260644169}}
{"type":"message","id":"2e3b9a34","parentId":"b57580a9","timestamp":"2026-07-17T03:57:30.437Z","message":{"role":"assistant","content":[{"type":"text","text":"你好！"}],"provider":"step-plan","model":"step-3.5-flash","timestamp":1784260644206,"duration":6231}}
{"type":"custom","customType":"session_exit","data":{"reason":"sigterm"},"id":"ef3afd78","parentId":"2e3b9a34","timestamp":"2026-07-17T08:22:56.018Z"}
{"type":"message","id":"30ec43ab","parentId":"2d1bfce3","timestamp":"2026-07-20T05:08:44.642Z","message":{"role":"user","content":[{"type":"text","text":"这个项目是干什么的？"}],"attribution":"user","timestamp":1784524124625}}
{"type":"message","id":"43a0da15","parentId":"30ec43ab","timestamp":"2026-07-20T05:08:55.306Z","message":{"role":"assistant","content":[{"type":"text","text":"## Vis"}],"provider":"lm-studio","model":"qwen3.6-28b-reap-i1","timestamp":1784524129000,"duration":6289}}
{"type":"message","id":"toolRes1","parentId":"43a0da15","timestamp":"2026-07-20T05:08:47.997Z","message":{"role":"toolResult","toolCallId":"t1","content":[],"timestamp":1784524128000}}
`;

describe('parseKimiWireLog', () => {
  it('extracts per-turn user time, assistant completion, model, and mode agent', () => {
    const turns = parseKimiWireLog(KIMI_WIRE);
    expect(turns).toEqual([
      {
        userText: 'kimi测试消息',
        userTime: 1784688779965,
        assistantTime: 1784688785500,
        assistantCompletedTime: 1784688786000,
        model: 'kimi-code/k3',
        agent: 'plan',
      },
      {
        userText: 'kimi后端测试消息',
        userTime: 1784697258226,
        assistantTime: 1784697261089,
        assistantCompletedTime: 1784697261089,
        model: 'kimi-code/kimi-for-coding-highspeed',
        agent: 'plan',
      },
      {
        userText: '最后一轮',
        userTime: 1784704440000,
        assistantTime: 1784704445000,
        assistantCompletedTime: 1784704445000,
        model: 'kimi-code/kimi-for-coding-highspeed',
        agent: 'yolo',
      },
    ]);
  });

  it('tolerates turns without a usage record (incomplete)', () => {
    const turns = parseKimiWireLog(`
{"type":"turn.prompt","input":[{"type":"text","text":"半截"}],"time":100}
`);
    expect(turns).toEqual([
      {
        userText: '半截',
        userTime: 100,
        assistantTime: undefined,
        assistantCompletedTime: undefined,
        model: undefined,
        agent: 'default',
      },
    ]);
  });
});

describe('parseOmpSessionLog', () => {
  it('extracts per-turn times and assistant provider/model', () => {
    const turns = parseOmpSessionLog(OMP_LOG);
    expect(turns).toEqual([
      {
        userText: '你好',
        userTime: 1784260644169,
        assistantTime: 1784260644206,
        assistantCompletedTime: 1784260650437,
        model: 'step-plan/step-3.5-flash',
        agent: undefined,
      },
      {
        userText: '这个项目是干什么的？',
        userTime: 1784524124625,
        assistantTime: 1784524129000,
        assistantCompletedTime: 1784524135289,
        model: 'lm-studio/qwen3.6-28b-reap-i1',
        agent: undefined,
      },
    ]);
  });

  it('loads Pi session metadata from its native session directory', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'vis-pi-meta-'));
    const sessionId = '019f-pi-session';
    const sessionDir = path.join(homeDir, '.pi', 'agent', 'sessions', '--repo--');
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, `2026-08-07_${sessionId}.jsonl`), OMP_LOG);
      await writeFile(path.join(sessionDir, `2026-08-08_${sessionId}-other.jsonl`), KIMI_WIRE);

      const turns = await loadAcpSessionTurnMeta('pi', sessionId, { homeDir });

      expect(turns?.[0]?.assistantCompletedTime).toBe(1784260650437);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
