本文档系统梳理 Vis 项目的测试体系架构、代码质量保障机制以及开发者应当遵循的编码规范。项目采用 **Vitest** 作为测试运行器，**happy-dom** 提供浏览器环境模拟，**oxlint** 与 **oxfmt** 分别负责静态检查与自动格式化，TypeScript 编译器则承担类型级约束。整个质量保障链条覆盖单元测试、集成契约验证、组件行为断言与源码级静态分析四个层面。

---

## 测试架构与工具链

### 核心工具选型

项目测试栈遵循"轻量、快速、无浏览器依赖"的原则。Vitest 与 Vite 共享配置上下文，测试文件通过 `**/*.test.ts` 模式自动发现，运行环境为 `happy-dom`——一种比 jsdom 更轻量的 DOM 实现，足以支撑 Composable 挂载、localStorage 模拟与 CSS 变量断言等场景，同时避免了真实浏览器或 Playwright 带来的启动开销。

| 工具 | 版本 | 职责 |
|---|---|---|
| Vitest | ^4.1.2 | 测试运行器、Mock、Spy、Fake Timer |
| happy-dom | ^17.0.0 | DOM API 与浏览器全局对象模拟 |
| oxlint | ^1.47.0 | 快速静态分析与未使用变量检查 |
| oxfmt | ^0.32.0 | 代码自动格式化（2 空格缩进、单引号） |
| vue-tsc | ^3.2.4 | Vue SFC 与 TypeScript 类型检查 |
| TypeScript | ^6.0.3 | 编译期严格类型约束 |

Sources: [package.json](package.json#L30-L34), [vite.config.ts](vite.config.ts#L63-L67)

### 测试环境配置

`vite.config.ts` 中的 `test` 字段直接嵌入 Vitest 配置，与构建配置共享 `resolve.alias`，确保测试代码中的模块解析路径与生产一致。`globals: false` 要求每个测试文件显式导入 `describe`、`it`、`expect` 等 API，避免隐式全局污染，同时让类型推断更加精确。

```ts
test: {
  environment: 'happy-dom',
  globals: false,
  include: ['**/*.test.ts'],
}
```

Sources: [vite.config.ts](vite.config.ts#L63-L67)

---

## 测试文件组织与命名

### 共置测试策略

项目采用 **"测试文件与源码同目录共置"** 的命名约定，即每个被测模块 `xxx.ts` 对应 `xxx.test.ts`，放置于同一目录下。这种布局消除了独立的 `tests/` 或 `__tests__/` 目录层级，使开发者能够在浏览文件树时一眼看到模块的测试覆盖情况。当前仓库共包含 **43 个测试文件**，总计约 **5459 行** 测试代码，分布于 `utils`、`composables`、`components`、`backends` 与根目录五个层级。

```
app/
├── utils/
│   ├── theme.ts
│   ├── theme.test.ts
│   ├── sseConnection.ts
│   └── sseConnection.test.ts
├── composables/
│   ├── useSettings.ts
│   └── useSettings.test.ts
├── backends/codex/
│   ├── codexAdapter.ts
│   └── codexAdapter.test.ts
└── ...
```

Sources: 通过 `find . -name "*.test.ts"` 统计得出

### 测试文件分布概览

| 层级 | 测试文件数 | 典型被测对象 |
|---|---|---|
| `app/utils/` | 24 | 纯函数、数据转换、路径处理、主题解析 |
| `app/composables/` | 7 | Vue Composable 状态逻辑、API 封装 |
| `app/backends/codex/` | 4 | Codex 适配器、JSON-RPC 客户端、数据规范化 |
| `app/components/` | 3 | 组件事件契约、DOM 类名约束、工具函数 |
| 根目录 | 2 | Node.js HTTP 桥接服务器、Vis Bridge |

---

## 测试模式与典型实践

### 纯函数单元测试

对于无副作用的纯函数，测试采用 **"输入-输出表驱动"** 模式，通过多组 `it` 用例覆盖边界条件。`theme.test.ts` 对 `resolveTheme` 的测试即属此类：验证十六进制直接解析、暗黑/亮色模式切换、缺失定义时的回退行为，以及代理颜色循环算法。所有断言均使用 `toEqual` 或 `toBe` 进行精确值比对，不依赖任何 Mock。

```ts
it('resolves dark and light mode values', () => {
  const theme = {
    defs: { darkBg: '#000000', lightBg: '#ffffff' },
    theme: { background: { dark: 'darkBg', light: 'lightBg' } },
  };
  expect(resolveTheme(theme, 'dark')).toEqual({ background: '#000000' });
  expect(resolveTheme(theme, 'light')).toEqual({ background: '#ffffff' });
});
```

Sources: [app/utils/theme.test.ts](app/utils/theme.test.ts#L12-L19)

### 异步与并发控制测试

`mapWithConcurrency.test.ts` 展示了如何测试带并发限制的异步映射函数。测试通过 `createDeferred` 构造手动控制的 Promise，在任务执行中途冻结以验证并发上限，随后逐步 resolve 以确认结果顺序与错误隔离。`vi.waitFor` 用于轮询断言，确保在宏任务队列推进后状态符合预期。

```ts
const deferred = [createDeferred<number>(), createDeferred<number>(), createDeferred<number>()];
const task = mapWithConcurrency([0, 1, 2], 2, async (item) => {
  active.push(item);
  const value = await deferred[item].promise;
  return value;
});
await Promise.resolve();
expect(active).toEqual([0, 1]);
expect(maxRunning).toBe(2);
```

Sources: [app/utils/mapWithConcurrency.test.ts](app/utils/mapWithConcurrency.test.ts#L17-L35)

### 浏览器全局对象模拟

当测试涉及 `window`、`localStorage`、`document` 或 `fetch` 时，使用 `vi.stubGlobal` 在 `beforeEach` 中注入可控替身，并在 `afterEach` 中调用 `vi.unstubAllGlobals()` 清理。`useSettings.test.ts` 与 `useCredentials.test.ts` 均遵循此模式：手动实现 `Storage` 接口的内存版，拦截 `storage` 事件监听器，从而在不触碰真实浏览器状态的前提下验证持久化逻辑与跨窗口同步行为。

```ts
beforeEach(() => {
  vi.resetModules();
  const memStore = new Map<string, string>();
  storage = { getItem: (key) => memStore.get(key) ?? null, ... } as Storage;
  vi.stubGlobal('window', { localStorage: storage, addEventListener });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
```

Sources: [app/composables/useSettings.test.ts](app/composables/useSettings.test.ts#L8-L36), [app/composables/useCredentials.test.ts](app/composables/useCredentials.test.ts#L8-L52)

### 模块级隔离与动态导入

Composable 测试常需验证模块加载时的副作用（如读取 localStorage 初始化状态）。`useSettings.test.ts`、`useCredentials.test.ts` 与 `useRegionTheme.test.ts` 使用 `vi.resetModules()` 配合 `await import('./useSettings')` 实现模块级隔离，确保每个用例都在干净的模块状态下运行。`importFresh` 辅助函数封装了这一模式，避免重复样板代码。

```ts
async function importFresh() {
  const mod = await import('./useSettings');
  return mod.useSettings();
}
```

Sources: [app/composables/useSettings.test.ts](app/composables/useSettings.test.ts#L37-L40)

### Vue Composable 挂载测试

`useRegionTheme.test.ts` 是唯一需要真实 Vue 运行时环境的测试文件。它通过 `createApp` + `defineComponent` 在 `document.body` 中创建临时挂载点，调用 `app.mount()` 触发 Composable 的 `setup` 生命周期，随后使用 `nextTick()` 等待响应式更新完成。测试结束后显式 `unmount()` 并移除 DOM 节点，防止测试间泄漏。该模式验证了主题令牌向 CSS 自定义属性的同步、`localStorage` 持久化以及 `pagehide` 事件刷新行为。

```ts
const app = createApp(defineComponent({
  setup() {
    api = useRegionTheme();
    return () => null;
  },
}));
app.mount(root);
await nextTick();
```

Sources: [app/composables/useRegionTheme.test.ts](app/composables/useRegionTheme.test.ts#L37-L55)

### WebSocket 与网络层 Mock

Codex 后端测试涉及 WebSocket 通信，项目未引入外部 Mock 库，而是手写 `MockWebSocket` 类。该类实现 `addEventListener`、`send`、`close` 接口，并通过静态数组 `MockWebSocket.instances` 追踪所有实例，使测试能够按序触发 `open`、`message`、`error`、`close` 事件。`flushPromises` 与 `waitForSent` 两个辅助函数用于消化微任务队列并轮询发送消息数量，确保异步 JSON-RPC 交互的时序可预测。

```ts
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly sent: string[] = [];
  addEventListener<T extends keyof ListenerMap>(type: T, listener: ListenerMap[T][number]) { ... }
  emitMessage(data: unknown) { ... }
  respond(id: number, result: unknown) { this.emitMessage(JSON.stringify({ id, result })); }
}
```

Sources: [app/backends/codex/codexAdapter.test.ts](app/backends/codex/codexAdapter.test.ts#L11-L59), [app/backends/codex/jsonRpcClient.test.ts](app/backends/codex/jsonRpcClient.test.ts#L11-L59)

### 组件契约与源码断言测试

对于 Vue SFC，`ProviderManagerModal.events.test.ts` 与 `modalBackdropTheme.test.ts` 采用 **"源码级断言"** 策略：通过 `readFileSync` 读取 `.vue` 文件内容，使用 `expect(...).toContain(...)` 与 `expect(...).not.toContain(...)` 验证事件名、CSS 类名、DOM 结构与条件逻辑的存在性。这种测试不渲染组件，而是将源码视为契约文档，确保重构不会意外删除关键类名或事件发射点。

```ts
it('uses matching model visibility and provider config events in App.vue', () => {
  const appSource = readSource(resolve(__dirname, '../App.vue'));
  const modalSource = readSource(resolve(__dirname, 'ProviderManagerModal.vue'));
  expect(modalSource).toContain("(event: 'update:model-visibility', value: ModelVisibilityEntry[]): void;");
  expect(appSource).toContain('@update:model-visibility="handleModelVisibilityUpdate"');
});
```

Sources: [app/components/ProviderManagerModal.events.test.ts](app/components/ProviderManagerModal.events.test.ts#L10-L24), [app/components/modalBackdropTheme.test.ts](app/components/modalBackdropTheme.test.ts#L8-L22)

### Node.js 服务端集成测试

`vis_bridge.test.ts` 与 `server.test.ts` 属于 Node.js 环境测试，直接操作原生 `http`、`net` 模块。`vis_bridge.test.ts` 启动真实的 TCP 服务器，发送 HTTP 请求与 WebSocket Upgrade 握手，验证路由匹配、认证拦截、CORS 原点限制与 PTY 端点行为。`server.test.ts` 则使用 `vi.mock` 对 `@hono/node-server` 与 `hono/proxy` 进行模块级 Mock，验证静态文件服务与代理模式的配置切换。

```ts
const server = createVisBridgeServer({ path: '/codex', target: 'ws://127.0.0.1:4500' });
const port = await listen(server);
await expect(readHttpBody(port, '/healthz')).resolves.toEqual({
  status: 200, body: { ok: true, service: 'vis_bridge' },
});
```

Sources: [app/vis_bridge.test.ts](app/vis_bridge.test.ts#L130-L140), [app/server.test.ts](app/server.test.ts#L20-L35)

---

## 代码规范与静态检查

### TypeScript 严格模式

`tsconfig.json` 启用了全套严格选项，包括 `strict: true`、`isolatedModules: true`、`verbatimModuleSyntax: true`、`noUnusedLocals: true` 与 `noUnusedParameters: true`。这些配置在编译期强制要求：所有导入必须显式区分 `type` 与值导入、不存在未使用的变量或参数、模块间无跨文件类型推断依赖。测试代码同样受此约束，因此常见 `as Response`、`as StorageEvent` 等类型断言以满足 Mock 对象的接口兼容性。

```json
{
  "compilerOptions": {
    "strict": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node", "vite/client", "vitest"]
  }
}
```

Sources: [tsconfig.json](tsconfig.json#L6-L15)

### Lint 与 Format 配置

**oxlint** 的配置极为精简，仅启用 `no-unused-vars` 为 `error` 级别，其余规则保持默认。这一选择与 TypeScript 的 `noUnusedLocals` 形成互补：oxlint 在毫秒级完成扫描，作为前置闸门；TypeScript 则在类型层面提供更深层的验证。`dist` 目录被排除在检查范围之外。

```json
{
  "rules": { "no-unused-vars": "error" },
  "ignorePatterns": ["dist"]
}
```

Sources: [.oxlintrc.json](.oxlintrc.json#L6-L7)

**oxfmt** 配置同样简洁，统一使用 2 空格缩进与单引号，忽略 `dist` 目录。项目未引入 Prettier，而是完全依赖 oxfmt 实现亚秒级格式化。

```json
{
  "tabWidth": 2,
  "singleQuote": true,
  "ignorePatterns": ["dist"]
}
```

Sources: [.oxfmtrc.json](.oxfmtrc.json#L3-L5)

### 脚本命令

`package.json` 中的三个质量命令构成开发者日常 workflow：

| 命令 | 行为 |
|---|---|
| `pnpm test` | `vitest run` — 一次性运行全部测试 |
| `pnpm lint` | `oxlint && vue-tsc --noEmit` — 先快速静态检查，再严格类型检查 |
| `pnpm format` | `oxfmt` — 自动格式化所有受支持的文件 |

Sources: [package.json](package.json#L30-L34)

---

## Mock 策略与测试隔离

### Mock 使用频度统计

通过对 43 个测试文件的扫描，可以归纳出项目的 Mock 使用模式：

| 技术 | 出现次数 | 典型场景 |
|---|---|---|
| `vi.fn()` | 约 70 处 | 回调函数、事件处理器、方法替身 |
| `vi.stubGlobal` | 12 处 | `window`、`fetch`、`document` 全局替换 |
| `vi.mock` | 17 处 | 模块级 Mock（如 `@hono/node-server`、`../utils/opencode`） |
| `vi.hoisted` | 1 处 | 在模块顶部声明可变的 Mock 引用 |
| `vi.useFakeTimers` | 4 处 | 重连延迟、定时持久化、心跳超时 |
| `vi.resetModules` | 5 处 | Composable 模块重新加载以验证初始化副作用 |

### 隔离原则

每个使用 `vi.stubGlobal` 或 `vi.mock` 的测试文件均在 `afterEach` 中调用 `vi.unstubAllGlobals()` 或 `vi.resetModules()`，确保全局状态与模块缓存不会泄漏到后续用例。对于需要 fake timer 的测试（如 `sseConnection.test.ts`、`jsonRpcClient.test.ts`），在 `afterEach` 中恢复真实计时器，防止影响其他异步测试的时序。

---

## 测试命名与结构规范

### 命名约定

测试采用 **"描述行为而非实现"** 的命名风格。`it` 描述句以动词第三人称单数开头，直接陈述被测单元在特定条件下的预期行为。例如：

- `it('resolves hex values directly')` — 纯函数测试
- `it('calls onPacket for each data line in an SSE block')` — 异步事件测试
- `it('pinSession resolves after the PATCH request without waiting for SSE reconciliation')` — 回归测试

### 嵌套结构

`describe` 用于按功能域或方法名分组，`it` 保持扁平，避免过度嵌套。大多数测试文件仅含 1 个顶层 `describe`，少数文件（如 `formatters.test.ts`、`path.test.ts`）按被测函数拆分为多个 `describe` 块，以提升可读性。全项目共约 **57 个 `describe` 块** 与 **255 个 `it` 用例**。

---

## 持续集成与质量门禁

当前项目的 GitHub Actions 工作流（`.github/workflows/build-electron.yml`）专注于 Electron 应用的多平台构建与发布，**尚未将测试或 Lint 纳入 CI 流水线**。这意味着测试与静态检查目前依赖开发者本地执行。对于贡献者而言，在提交 PR 前运行 `pnpm lint && pnpm test` 是确保代码质量的必要步骤。

Sources: [.github/workflows/build-electron.yml](.github/workflows/build-electron.yml)

---

## 延伸阅读

- 如需了解后端适配器的详细设计，请参阅 [模块化后端适配器设计](7-mo-kuai-hua-hou-duan-gua-pei-qi-she-ji)
- 如需深入 SSE 连接与事件协议，请参阅 [SSE 连接管理与事件协议](8-sse-lian-jie-guan-li-yu-shi-jian-xie-yi)
- 如需了解 Vue Composable 的状态管理实践，请参阅 [全局状态与事件系统](6-quan-ju-zhuang-tai-yu-shi-jian-xi-tong)