import type { Ref } from 'vue';
import * as opencodeApi from '../utils/opencode';

type UsePtyOneshotOptions = {
  activeDirectory: Ref<string>;
  translate?: (key: string, params?: Record<string, unknown>) => string;
};

type PtyInfo = {
  id: string;
};

const PTY_ONESHOT_TIMEOUT_MS = 30000;
const PTY_CREATE_TIMEOUT_MS = 10000;
const PTY_ONESHOT_EXIT_PREFIX = '__OPENCODE_PTY_EXIT_CODE__:';

let boundOptions: UsePtyOneshotOptions | null = null;
let translateFunction: ((key: string, params?: Record<string, unknown>) => string) | null = null;

function parsePtyInfo(value: unknown): PtyInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;
  return { id };
}

function getOptions() {
  if (!boundOptions) {
    throw new Error('usePtyOneshot must be initialized with options before use');
  }
  return boundOptions;
}

function init(options: UsePtyOneshotOptions) {
  if (boundOptions) return;
  boundOptions = options;
}

function bindTranslate(
  nextTranslate?: (key: string, params?: Record<string, unknown>) => string,
) {
  if (!nextTranslate || translateFunction) return;
  translateFunction = nextTranslate;
}

function isCursorMetaBytes(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes[0] !== 0) return false;
  const payload = new TextDecoder().decode(bytes.subarray(1));
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const meta = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      Object.keys(meta).length === 1 &&
      typeof meta.cursor === 'number' &&
      Number.isSafeInteger(meta.cursor) &&
      meta.cursor >= 0
    );
  } catch {
    return false;
  }
}

function isCursorMetaString(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const meta = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      Object.keys(meta).length === 1 &&
      typeof meta.cursor === 'number' &&
      Number.isSafeInteger(meta.cursor) &&
      meta.cursor >= 0
    );
  } catch {
    return false;
  }
}

function extractOneShotExitCode(output: string): { output: string; exitCode: number | null } {
  const normalized = output.replace(/\r/g, '');
  const lines = normalized.split('\n');
  let index = lines.length - 1;

  while (index >= 0 && !lines[index]?.trim()) {
    index -= 1;
  }

  if (index < 0) return { output: normalized, exitCode: null };

  const line = lines[index]?.trim() ?? '';
  if (!line.startsWith(PTY_ONESHOT_EXIT_PREFIX)) {
    return { output: normalized, exitCode: null };
  }

  const rawExitCode = line.slice(PTY_ONESHOT_EXIT_PREFIX.length).trim();
  const exitCode = Number.parseInt(rawExitCode, 10);
  if (!Number.isFinite(exitCode)) {
    return { output: normalized, exitCode: null };
  }

  lines.splice(index, 1);
  return {
    output: lines.join('\n'),
    exitCode,
  };
}

function translate(messageKey: string, params?: Record<string, unknown>) {
  if (!translateFunction) {
    const lastPart = messageKey.split('.').pop() || messageKey;
    if (!params) return lastPart;
    return Object.entries(params).reduce((acc, [key, value]) => {
      return acc.replace(`{${key}}`, String(value));
    }, lastPart);
  }
  return translateFunction(messageKey, params);
}

export function usePtyOneshot(options?: UsePtyOneshotOptions) {
  if (options) {
    init(options);
    bindTranslate(options.translate);
  }
  getOptions();

  async function runOneShotPtyCommand(command: string, args: string[]): Promise<string> {
    const { activeDirectory } = getOptions();
    const directory = activeDirectory.value || undefined;
    const createPtyAbort = new AbortController();
    const createPtyTimeoutId = setTimeout(() => {
      createPtyAbort.abort();
    }, PTY_CREATE_TIMEOUT_MS);

    let data: unknown;
    try {
      data = await opencodeApi.createPty(
        {
          directory,
          command: 'env',
          args: [
            'bash',
            '--noprofile',
            '--norc',
            '-c',
            `stty -echo 2>/dev/null; read -r -t 1 _ || true; "$@"; code=$?; printf '\n${PTY_ONESHOT_EXIT_PREFIX}%s\n' "$code"; exit "$code"`,
            '_',
            command,
            ...args,
          ],
          cwd: directory,
          title: 'One-shot PTY',
        },
        { signal: createPtyAbort.signal },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(translate('errors.ptyCommandTimedOut'));
      }
      throw error;
    } finally {
      clearTimeout(createPtyTimeoutId);
    }

    const pty = parsePtyInfo(data);
    if (!pty) {
      throw new Error(translate('errors.ptyCreateFailed'));
    }

    return new Promise<string>((resolve, reject) => {
      const url = opencodeApi.createWsUrl(`/pty/${pty.id}/connect`, { directory });
      const socket = new WebSocket(url);
      const decoder = new TextDecoder();
      let captured = '';
      let settled = false;
      let opened = false;
      let sawExitMarker = false;
      let exitCode: number | null = null;

      const cleanup = () => {
        opencodeApi.deletePty(pty.id, directory).catch(() => {});
      };

      const settle = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        handler();
        cleanup();
      };

      const timeoutId = setTimeout(() => {
        console.error('[pty-oneshot] command timed out:', command, args);
        settle(() => reject(new Error(translate('errors.ptyCommandTimedOut'))));
        socket.close();
      }, PTY_ONESHOT_TIMEOUT_MS);

      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        opened = true;
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send('\n');
        } catch {
          settle(() => reject(new Error(translate('errors.ptySocketFailed'))));
          socket.close();
        }
      });
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          if (isCursorMetaBytes(bytes)) return;
          captured += decoder.decode(bytes, { stream: true });
          return;
        }
        if (typeof event.data !== 'string') return;
        if (isCursorMetaString(event.data)) return;
        captured += event.data;
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        settle(() => {
          captured += decoder.decode();
          const parsed = extractOneShotExitCode(captured);
          sawExitMarker = parsed.exitCode !== null;
          exitCode = parsed.exitCode;

          if (!opened) {
            reject(new Error(translate('errors.ptySocketFailed')));
            return;
          }

          if (!sawExitMarker && !event.wasClean) {
            reject(new Error(translate('errors.ptySocketFailed')));
            return;
          }

          if (exitCode !== null && exitCode !== 0) {
            console.error(
              `[pty-oneshot] command exited with non-zero code ${exitCode}:`,
              command,
              args,
            );
            const err = new Error(
              translate('errors.ptyCommandFailed', { exitCode: String(exitCode) }),
            );
            (err as Error & { output?: string }).output = parsed.output;
            reject(err);
            return;
          }

          resolve(parsed.output);
        });
      });
      socket.addEventListener('error', () => {
        console.error('[pty-oneshot] command socket error:', command, args);
        settle(() => reject(new Error(translate('errors.ptySocketFailed'))));
      });
    });
  }

  return {
    runOneShotPtyCommand,
  };
}
