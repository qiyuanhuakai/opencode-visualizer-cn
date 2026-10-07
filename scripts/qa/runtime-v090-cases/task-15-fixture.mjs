import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--server')) {
  const write = (value) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const record = (value) => {
    if (process.env.ACP_TRACE) appendFileSync(process.env.ACP_TRACE, `${JSON.stringify(value)}\n`);
  };
  const prompts = new Map();
  const roots = new Map();
  const reverse = new Map();
  const call = (method, params, next) => {
    const requestId = nextId();
    reverse.set(requestId, next);
    write({ id: requestId, method, params });
  };
  const nextId = () => next++;
  let next = 100;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    record(message);
    const { method, params = {}, id } = message;
    const reply = (result) => write({ id, result });
    if (!method) {
      const callback = reverse.get(id);
      if (callback) {
        reverse.delete(id);
        callback(message);
        return;
      }
      const prompt = prompts.get(id);
      if (prompt) {
        prompts.delete(id);
        write({ id: prompt, result: { stopReason: 'end_turn' } });
      }
      return;
    }
    if (method === 'initialize')
      return reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(process.env.ACP_CONCURRENT ? { _meta: { 'vis/sessionConcurrency': true } } : {}),
          sessionCapabilities: process.env.ACP_NO_LIST ? {} : { list: {}, resume: {}, fork: {} },
        },
        authMethods: [
          { id: 'qa-auth', name: 'Private QA terminal', type: 'terminal', args: ['--qa-auth'] },
        ],
      });
    if (method === 'session/fork') {
      roots.set('forked-session', params.cwd);
      return reply({ sessionId: 'forked-session' });
    }
    if (method === 'session/set_config_option')
      return reply({
        configOptions: [
          {
            id: params.configId,
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: params.value,
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B' },
            ],
          },
        ],
      });
    if (method === 'session/new') {
      write({
        method: 'session/update',
        params: {
          sessionId: params._testId ?? 'same-id',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'qa', description: 'Controlled command' }],
          },
        },
      });
      roots.set(params._testId ?? 'same-id', params.cwd);
      return reply({
        sessionId: params._testId ?? 'same-id',
        modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'a',
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B' },
            ],
          },
        ],
      });
    }
    if (method === 'session/list')
      return reply({
        sessions: [
          { sessionId: params.cursor ? 'second' : 'same-id', cwd: params.cwd, title: 'native' },
        ],
        ...(process.env.ACP_REPEAT_CURSOR || !params.cursor ? { nextCursor: 'next' } : {}),
      });
    if (method === 'session/prompt') {
      const mode = params.prompt?.[0]?.text;
      if (mode === 'invalid-json') return process.stdout.write('not-json\n');
      if (mode === 'oversized-frame') return process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
      if (mode === 'malformed-native')
        return write({
          method: 'session/update',
          params: { sessionId: params.sessionId, update: null },
        });
      if (mode === 'extension') {
        write({
          method: '_unknown/extension',
          params: { token: 'PRIVATE_NATIVE_CREDENTIAL', sessionId: params.sessionId },
        });
        return reply({ stopReason: 'end_turn' });
      }
      if (mode === 'reverse') {
        const cwd = roots.get(params.sessionId);
        const sessionId = params.sessionId;
        return call('fs/read_text_file', { sessionId, path: `${cwd}/original.txt` }, (file) => {
          if (file.error) return reply({ stopReason: 'error', reverseError: file.error });
          call(
            'terminal/create',
            {
              sessionId,
              command: process.execPath,
              args: ['-e', 'process.stdout.write(process.cwd())'],
              cwd,
              env: [{ name: 'HOME', value: process.env.HOME }],
            },
            (terminal) => {
              if (terminal.error)
                return reply({ stopReason: 'error', reverseError: terminal.error });
              const terminalId = terminal.result.terminalId;
              call('terminal/wait_for_exit', { sessionId, terminalId }, () =>
                call('terminal/output', { sessionId, terminalId }, (output) =>
                  call('terminal/release', { sessionId, terminalId }, () =>
                    reply({
                      stopReason: 'end_turn',
                      reverseFile: file.result.content,
                      reverseCwd: output.result.output,
                    }),
                  ),
                ),
              );
            },
          );
        });
      }
      if (mode === 'escape')
        return call(
          'fs/read_text_file',
          { sessionId: params.sessionId, path: '/etc/passwd' },
          (file) =>
            reply({ stopReason: 'end_turn', escaped: !!file.result, rejected: !!file.error }),
        );
      if (mode === 'flood') {
        for (let index = 0; index < 160; index++)
          write({
            method: 'session/update',
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: String(index) },
              },
            },
          });
        return reply({ stopReason: 'end_turn' });
      }
      if (params.prompt?.[0]?.text === 'permission') {
        const request = process.env.ACP_REUSE_REQUEST_ID ? 7 : next++;
        prompts.set(request, id);
        return write({
          id: request,
          method: 'session/request_permission',
          params: {
            sessionId: params.sessionId,
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
            toolCall: { toolCallId: 'tool-1', title: 'controlled' },
          },
        });
      }
      return reply({ stopReason: 'end_turn' });
    }
    if (method === 'session/cancel') {
      for (const [request, prompt] of prompts) {
        prompts.delete(request);
        write({ id: prompt, result: { stopReason: 'cancelled' } });
      }
      return;
    }
    if (method === '_test/reverse') {
      write({
        id: next++,
        method: 'fs/read_text_file',
        params: { sessionId: 'same-id', path: '/untrusted' },
      });
      return reply({});
    }
    if (method === 'session/load' || method === 'session/resume') {
      roots.set(params.sessionId, params.cwd);
      return reply({ modes: { currentModeId: 'code', availableModes: [] } });
    }
    reply({});
  });
}

export async function openAcpEnvironment({
  temporaryRoot,
  agents = [],
  epoch = '33333333-3333-4333-8333-333333333333',
  extraStore = {},
}) {
  const { mkdtemp, mkdir, rm, writeFile, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { createRuntimeStore } = await import('../../../bridge/runtime/storage/runtimeStore.js');
  const { spawn } = await import('node:child_process');
  const { createAcpProcessManager } = await import('../../../bridge/acpProcessManager.js');
  const { createWorkspaceService } = await import('../../../bridge/runtime/workspaceService.js');
  const { createAcpDriver } = await import('../../../bridge/runtime/drivers/acpDriver.js');
  const temporary = await mkdtemp(path.join(temporaryRoot ?? tmpdir(), 'acp-task15-'));
  const target = '11111111-1111-4111-8111-111111111111';
  const store = createRuntimeStore({
    stateDirectory: path.join(temporary, 'state'),
    environmentId: target,
    ownerId: '22222222-2222-4222-8222-222222222222',
    epoch,
    ...extraStore,
  });
  const drivers = [];
  const wire = [];
  const manager = createAcpProcessManager({
    spawnProcess(command, args, options) {
      const child = spawn(command, args, options);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        wire.push({
          direction: 'runtime-to-installed-process',
          pid: child.pid,
          text: String(chunk),
        });
        return write(chunk, ...rest);
      };
      child.stdout.on('data', (chunk) =>
        wire.push({
          direction: 'installed-process-to-runtime',
          pid: child.pid,
          text: String(chunk),
        }),
      );
      child.stderr.on('data', (chunk) =>
        wire.push({
          direction: 'process-stderr',
          pid: child.pid,
          text: String(chunk).slice(0, 8192),
        }),
      );
      return child;
    },
  });
  const root = path.join(temporary, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'original.txt'), 'ACP-owned file\n');
  const workspace = await createWorkspaceService({
    target,
    epoch,
    roots: [{ root, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }],
  });
  const connection = workspace.connect({
    target,
    epoch,
    generation: 1,
    subscriberId: 'runtime-owned',
    assertCurrent() {},
  });
  const configs = agents.length ? agents : [{ id: 'first' }, { id: 'second' }];
  const configured = [];
  const pids = [store.pid];
  const driverOptions = [];
  const decorate = (driver, harnessInstanceId, trace) => {
    driver.context = (params = {}, session) => ({
      environmentId: target,
      harnessInstanceId,
      ...(session ? { session } : {}),
      params: { epoch, processGeneration: driver.binding.processGeneration, ...params },
    });
    driver.trace = async () =>
      (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return driver;
  };
  const close = async () => {
    const results = await Promise.allSettled(drivers.map((driver) => driver.close()));
    await manager.stopAll();
    await workspace.close();
    await store.close();
    await rm(temporary, { recursive: true, force: true });
    const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Driver cleanup failed');
    return {
      temporary,
      removed: true,
      pids,
      allPidsExited: pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === 'ESRCH') return true;
          throw error;
        }
      }),
    };
  };
  try {
    for (const [index, agent] of configs.entries()) {
      const home = path.join(temporary, agent.id);
      await mkdir(home);
      const trace = path.join(temporary, `${agent.id}.trace`);
      const config = {
        id: agent.id,
        name: agent.id,
        enabled: true,
        command: agent.command ?? process.execPath,
        args: agent.args ?? [fileURLToPath(import.meta.url), '--server'],
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_DATA_HOME: path.join(home, 'data'),
          XDG_CACHE_HOME: path.join(home, 'cache'),
          XDG_STATE_HOME: path.join(home, 'state'),
          ACP_TRACE: trace,
          ...agent.env,
        },
      };
      if (agent.configure)
        Object.assign(config, await agent.configure({ home, root, env: config.env }));
      configured.push(config);
      await manager.reconcile(configured);
      const harnessInstanceId =
        agent.harnessInstanceId ?? `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`;
      const options = {
        store,
        manager,
        agentId: agent.id,
        target,
        harnessInstanceId,
        epoch,
        workspace: connection,
        workspaceKey: workspace.workspaces[0].key,
        cwd: root,
        homeDir: home,
        ...(agent.createAuthTerminal
          ? {
              createAuthTerminal: (input) =>
                agent.createAuthTerminal(input, { home, root, env: config.env }),
            }
          : {}),
      };
      driverOptions.push({ options, harnessInstanceId, trace });
      const driver = await createAcpDriver(options);
      drivers.push(driver);
      pids.push(driver.pid);
      decorate(driver, harnessInstanceId, trace);
    }
    return {
      drivers,
      store,
      manager,
      workspace,
      connection,
      root,
      temporary,
      pids,
      configured,
      wire,
      close,
      async restart(index) {
        await manager.reconcile(configured);
        const { options, harnessInstanceId, trace } = driverOptions[index];
        const driver = await createAcpDriver(options);
        drivers.push(driver);
        pids.push(driver.pid);
        return decorate(driver, harnessInstanceId, trace);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function authTerminalProbe() {
  const observed = [];
  return {
    observed,
    async create(input, scope) {
      const { createPtyManager, loadNodePty } = await import('../../../bridge/ptyManager.js');
      const native = await loadNodePty();
      let child,
        exited = false,
        output = '';
      const entry = {
        binding: input.binding,
        methodId: input.method.id,
        home: scope.home,
        root: scope.root,
        pid: null,
        terminalId: null,
        closed: false,
        output: null,
      };
      const manager = createPtyManager({
        ptyModule: {
          spawn(command, args, options) {
            child = native.spawn(command, args, {
              ...options,
              env: { ...process.env, ...scope.env },
            });
            child.onData((data) => {
              output += data;
              try {
                entry.output = JSON.parse(output.trim());
              } catch {}
            });
            child.onExit(() => {
              exited = true;
            });
            entry.pid = child.pid;
            return child;
          },
        },
      });
      const { id } = await manager.create({
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd(),pid:process.pid}));setInterval(()=>{},1000)',
        ],
        cwd: scope.root,
      });
      entry.terminalId = id;
      observed.push(entry);
      return {
        terminalId: id,
        async close() {
          manager.remove(id);
          const deadline = Date.now() + 5000;
          while (!exited && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          if (!exited) throw new Error('Owned auth PTY did not exit');
          entry.closed = true;
        },
      };
    },
  };
}
