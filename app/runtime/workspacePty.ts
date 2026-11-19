import type { EnvironmentId, WorkspaceKey } from '../../shared/runtime/identity.js';
import { requireValue } from '../../shared/runtime/capabilities.js';
import type { RuntimeClient } from './client';

export type PtySocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener' | 'binaryType'>;

export function createWorkspacePty(client: RuntimeClient, target: EnvironmentId, workspaceKey: WorkspaceKey) {
  const scope = client.scope(target);
  const options = { selectionCurrent: scope.isCurrent };
  async function create(command?: string, args: string[] = [], cwd?: string) {
    return client.request(target, 'runtime.pty.create', { workspaceKey, ...(command ? { command } : {}), args, ...(cwd ? { cwd } : {}) }, options);
  }
  async function resize(ptyId: string, rows: number, cols: number) {
    await client.request(target, 'runtime.pty.resize', { ptyId, rows, cols }, options);
  }
  async function detach(ptyId: string) {
    await client.request(target, 'runtime.pty.detach', { ptyId }, options);
  }
  async function remove(ptyId: string) {
    await client.request(target, 'runtime.pty.remove', { ptyId }, options);
  }
  function connect(ptyId: string): PtySocket {
    const events = new EventTarget();
    let readyState: WebSocket['readyState'] = WebSocket.CONNECTING;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let removeDetach: (() => void) | undefined;
    let acknowledge = Promise.resolve();
    function end() {
      if (stopped) return;
      stopped = true;
      readyState = WebSocket.CLOSED;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      removeDetach?.();
      events.dispatchEvent(new Event('close'));
    }
    function fail(cause: unknown) {
      events.dispatchEvent(new ErrorEvent('error', { message: cause instanceof Error ? cause.message : String(cause) }));
      end();
    }
    async function poll() {
      if (stopped) return;
      try {
        await acknowledge;
        const result = await client.request(target, 'runtime.pty.read', { ptyId }, options);
        await acknowledge;
        if (stopped) return;
        if (result.exited && result.chunks.length === 0) {
          events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ exitCode: result.exitCode ?? -1 }) }));
          end();
          void detach(ptyId).catch(() => undefined);
          return;
        }
        timer = setTimeout(() => { void poll(); }, result.chunks.length ? 0 : 50);
      } catch (cause) { fail(cause); }
    }
    removeDetach = client.onDetach(detached => { if (detached === target) end(); });
    void client.request(target, 'runtime.channel.open', { service: 'pty', ptyId }, options).then(channel => {
      if (stopped) {
        void client.request(target, 'runtime.channel.cancel', { channelId: channel.channelId }, options).catch(() => undefined);
        return;
      }
      unsubscribe = client.subscribeChannel(channel.channelId, chunk => {
        if (stopped) return;
        events.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(chunk.data).buffer }));
        acknowledge = acknowledge.then(async () => {
          await client.request(target, 'runtime.channel.ack', { channelId: chunk.channelId, offset: chunk.offset, length: chunk.length }, options);
        });
        void acknowledge.catch(fail);
      });
      readyState = WebSocket.OPEN;
      events.dispatchEvent(new Event('open'));
      void poll();
    }).catch(fail);
    return {
      get readyState() { return readyState; },
      binaryType: 'arraybuffer',
      send(data) {
        requireValue(readyState === WebSocket.OPEN && typeof data === 'string', 'pty.input', 'invalid_request');
        void client.request(target, 'runtime.pty.write', { ptyId, data }, options).catch(fail);
      },
      close() { end(); void detach(ptyId).catch(() => undefined); },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
  }
  async function run(command: string, args: string[], cwd?: string): Promise<string> {
    const pty = await create(command, args, cwd);
    const socket = connect(pty.ptyId);
    return new Promise<string>((resolve, reject) => {
      const decoder = new TextDecoder();
      let output = '';
      let exitCode: number | undefined;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('runtime.pty.timeout')); }, 30000);
      socket.addEventListener('message', event => {
        if (event.data instanceof ArrayBuffer) {
          output += decoder.decode(event.data, { stream: true });
          if (output.length > 4 * 1024 * 1024) { socket.close(); reject(new Error('runtime.pty.output_budget')); }
        } else if (typeof event.data === 'string') {
          const value: unknown = JSON.parse(event.data);
          if (value && typeof value === 'object' && 'exitCode' in value && typeof value.exitCode === 'number') exitCode = value.exitCode;
        }
      });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('runtime.pty.failed')); });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        output += decoder.decode();
        if (exitCode === 0) resolve(output);
        else reject(new Error(`runtime.pty.exit:${exitCode ?? 'disconnected'} ${output}`));
      });
    }).finally(() => remove(pty.ptyId));
  }
  return { create, resize, detach, remove, connect, run };
}
export type WorkspacePty = ReturnType<typeof createWorkspacePty>;
