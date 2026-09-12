import { describe, expect, it } from 'vitest';
import type { AssistantMessageInfo, MessagePart } from '../../types/sse';
import { createCodexSubagentStreams } from './subagentStreams';

function setup() {
  let selected = 'parent';
  const events: { info: AssistantMessageInfo; part: MessagePart }[] = [];
  const stream = createCodexSubagentStreams({ getSelectedParent: () => selected, publish: (info, part) => events.push({ info, part }) });
  stream.registerHistory({ id: 'parent', turns: [{ id: 'parent-turn', items: [{ id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/reviewer' }] }] });
  const send = (method: string, params: Record<string, unknown>) => stream.handle({ method, params: { threadId: 'child', turnId: 'turn', ...params } });
  return { events, stream, send, select: (id: string) => { selected = id; } };
}

describe('Codex descendant streams', () => {
  it('catches up only the latest child turn on a live subscription, without replaying history on refresh', () => {
    const {stream,events} = setup();
    const thread = {id:'child',turns:[
      {id:'old',status:'completed',items:[{type:'agentMessage',id:'old-answer',text:'Old'}]},
      {id:'new',status:'completed',items:[{type:'agentMessage',id:'answer',text:'Finished before subscription'}]},
    ]};
    stream.registerHistory(thread);
    expect(events).toHaveLength(0);
    stream.registerHistory(thread,undefined,true);
    stream.registerHistory(thread,undefined,true);
    expect(events).toHaveLength(1);
    expect(events[0]?.part).toMatchObject({text:'Finished before subscription',time:{end:expect.any(Number)}});
  });
  it('updates live window metadata when the child model arrives after its first text', () => {
    const {stream,send,events} = setup();
    send('item/agentMessage/delta',{itemId:'answer',delta:'Checking'});
    stream.registerHistory({id:'child',model:'child-model',modelProvider:'codex',turns:[]});
    expect(events.at(-1)?.info.modelID).toBe('child-model');
    expect(events.at(-1)?.part).toMatchObject({text:'Checking'});
  });
  it('requests a live subscription when a historical child is used again', () => {
    const discoveries: boolean[] = [];
    const stream = createCodexSubagentStreams({getSelectedParent:()=> 'parent', publish:()=>{}, onDiscover:(_id,live)=>discoveries.push(live)});
    const item = {type:'subAgentActivity',agentThreadId:'child',agentPath:'/root/reviewer',kind:'interacted'};
    stream.registerHistory({id:'parent',turns:[{items:[item]}]});
    stream.handle({method:'item/completed',params:{threadId:'parent',item}});
    stream.handle({method:'item/completed',params:{threadId:'parent',item}});
    expect(discoveries).toEqual([false,true]);
  });
  it('publishes live reasoning, command output and text with child identity', () => {
    const { send, events } = setup();
    send('turn/started', { turn: { id: 'turn', model: 'child-model', modelProvider: 'local' } });
    send('item/reasoning/summaryTextDelta', { itemId: 'think', delta: 'Inspecting' });
    send('item/started', { item: { id: 'shell', type: 'commandExecution', command: 'pwd' } });
    send('item/commandExecution/outputDelta', { itemId: 'shell', delta: '/project' });
    send('item/agentMessage/delta', { itemId: 'answer', delta: 'Done' });
    expect(events.map(event => event.part.type)).toEqual(['reasoning', 'tool', 'tool', 'text']);
    expect(events.at(-1)?.info).toMatchObject({ sessionID: 'child', modelID: 'child-model', providerID: 'local', agent: 'reviewer' });
    expect(events[2]?.part).toMatchObject({ state: { status: 'running', metadata: { output: '/project' } } });
    expect(events.at(-1)?.part).toMatchObject({ text: 'Done' });
    expect(events.at(-1)?.part).not.toHaveProperty('time.end');
  });
  it('ignores unrelated sessions, historical replay and old selection', () => {
    const { send, events, stream, select } = setup();
    stream.registerHistory({ id: 'child', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'Old' }] }] });
    send('item/completed', { item: { id: 'old', type: 'agentMessage', text: 'Old' } });
    send('item/agentMessage/delta', { threadId: 'unrelated', itemId: 'other', delta: 'No' });
    select('different');
    send('item/agentMessage/delta', { itemId: 'new', delta: 'No' });
    expect(events).toEqual([]);
  });
  it('discovers grandchildren from live collaboration and thread source metadata', () => {
    const { send, events } = setup();
    send('item/started', { item: { id: 'spawn2', type: 'collabAgentToolCall', receiverThreadIds: ['grandchild'], senderThreadId: 'child' } });
    send('thread/started', { thread: { id: 'grandchild', agentNickname: 'Checker', model: 'real-model', source: { subAgent: { thread_spawn: { parent_thread_id: 'child' } } } } });
    send('item/agentMessage/delta', { threadId: 'grandchild', itemId: 'answer', delta: 'Found' });
    expect(events.at(-1)?.info).toMatchObject({ sessionID: 'grandchild', modelID: 'real-model', agent: 'Checker' });
  });
  it('discovers each child once and accepts source-only links with canonical model metadata', () => {
    const discovered: string[] = [];
    const events: { info: AssistantMessageInfo; part: MessagePart }[] = [];
    const stream = createCodexSubagentStreams({ getSelectedParent: () => 'parent', onDiscover: id => discovered.push(id), publish: (info, part) => events.push({ info, part }) });
    const thread = { id: 'source-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } };
    stream.handle({ method: 'thread/started', params: { thread } });
    stream.registerHistory(thread, { modelID: 'actual-model', providerID: 'actual-provider' });
    stream.handle({ method: 'item/agentMessage/delta', params: { threadId: 'source-child', turnId: 'turn', itemId: 'answer', delta: 'Hi' } });
    expect(discovered).toEqual(['source-child']);
    expect(events.at(-1)?.info).toMatchObject({ modelID: 'actual-model', providerID: 'actual-provider' });
  });
  it('keeps task path names, namespaces tool IDs and marks history discovery', () => {
    const discoveries: [string, boolean][] = [];
    const events: { info: AssistantMessageInfo; part: MessagePart }[] = [];
    const stream = createCodexSubagentStreams({ getSelectedParent: () => 'parent', onDiscover: (id, live) => discoveries.push([id, live]), publish: (info, part) => events.push({ info, part }) });
    stream.registerHistory({ id: 'parent', turns: [{ items: [{ type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/code_reviewer' }] }] });
    stream.registerHistory({ id: 'child', agentNickname: 'Nickname' });
    stream.handle({ method: 'item/started', params: { threadId: 'child', turnId: 'turn', item: { id: 'shell', type: 'commandExecution', command: 'pwd' } } });
    expect(discoveries).toEqual([['child', false]]);
    expect(events[0]?.info.agent).toBe('code_reviewer');
    expect(events[0]?.part).toMatchObject({ id: 'child:shell', callID: 'child:shell' });
  });
  it('closes running child tools when thread becomes idle', () => {
    const { send, events } = setup();
    send('item/started', { item: { id: 'shell', type: 'commandExecution', command: 'pwd' } });
    send('thread/status/changed', { turnId: undefined, status: { type: 'idle' } });
    expect(events.at(-1)?.part).toMatchObject({ state: { status: 'completed' } });
    expect(events.at(-1)?.info.time.completed).toEqual(expect.any(Number));
  });
  it('completes active parts and deduplicates completed items', () => {
    const { send, events } = setup();
    send('item/agentMessage/delta', { itemId: 'answer', delta: 'Done' });
    send('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    const completed = events.at(-1);
    send('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Done' } });
    expect(events).toHaveLength(2);
    expect(completed?.info.time.completed).toEqual(expect.any(Number));
    expect(completed?.part).toMatchObject({ time: { end: expect.any(Number) } });
    expect(completed?.info.modelID).toBe('');
  });
});
