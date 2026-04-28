本页面介绍项目中测试框架的完整配置与使用规范。项目采用 **Vitest** 作为单元测试框架，配合 **Vite** 构建系统实现高速的测试运行体验。Vitest 提供开箱即用的类型支持、热更新和与 Vite 生态的无缝集成。

## 技术栈概览

测试架构基于以下核心技术栈构建：

| 组件 | 版本 | 作用 |
|------|------|------|
| Vitest | ^4.1.2 | 单元测试与集成测试框架 |
| happy-dom | ^17.0.0 | 浏览器 DOM 模拟环境 |
| @vitejs/plugin-vue | ^6.0.4 | Vue 单文件组件测试支持 |
| vue-tsc | ^3.2.4 | TypeScript 类型检查 |

Vitest 是 Vite 官方推荐的测试框架，直接复用 Vite 的配置和插件系统，这意味着相同的解析别名、环境变量和预处理逻辑在测试环境中自动生效 [package.json](L34-L78)。

## 配置架构

测试配置通过 Vite 配置文件中的 `test` 字段进行统一管理。项目根目录的 `vite.config.ts` 定义了测试环境、覆盖率收集和别名映射：

```typescript
// vite.config.ts 中的测试配置片段
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

**环境选择说明**：项目选用 `happy-dom` 而非 `jsdom` 作为 DOM 模拟环境，主要考虑是性能优化和 Electron 应用的兼容性。happy-dom 提供了更轻量的实现，适合桌面应用场景 [vite.config.ts](L1-L<end>)。

## 测试目录结构

测试文件遵循 **文件邻近原则**（colocation），与源代码保持相同目录结构，通过 `.test.ts` 或 `.spec.ts` 后缀标识。项目中的测试文件分布如下：

```
app/
├── composables/
│   ├── useCodexApi.test.ts          # API 组合式函数测试
│   ├── useCredentials.test.ts       # 凭证管理测试
│   ├── useMessages.test.ts          # 消息状态测试
│   ├── useOpenCodeApi.test.ts       # OpenCode API 测试
│   ├── useSettings.test.ts          # 设置管理测试
│   └── ...（其他测试文件）
├── utils/
│   ├── archiveParser.test.ts        # 归档解析测试
│   ├── eventEmitter.test.ts         # 事件发射器测试
│   ├── notificationManager.test.ts  # 通知管理器测试
│   └── ...（其他测试文件）
├── components/
│   ├── ProviderManagerModal.events.test.ts  # 组件事件测试
│   └── modalBackdropTheme.test.ts           # 主题测试
└── server.test.ts                    # 服务器集成测试
```

这种结构保持了 **关注点分离** 原则：测试文件与实现文件物理相邻，便于维护和代码审查时的上下文理解。

## 编写测试用例

### 基础测试模式

项目测试采用 **Arrange-Act-Assert (3A)** 模式组织，确保测试逻辑清晰：

```typescript
// useCredentials.test.ts 示例
describe('useCredentials', () => {
  it('should return default credentials when not configured', () => {
    // Arrange: 准备测试环境
    const storage = createMockStorage();
    
    // Act: 执行被测逻辑
    const result = useCredentials(storage);
    
    // Assert: 验证结果
    expect(result.apiKey).toBe('');
    expect(result.baseUrl).toBe('https://api.example.com');
  });
});
```

### 异步测试处理

对于涉及异步操作的组合式函数（如 API 调用、事件监听），项目使用 `vi` (Vitest mock 函数) 和 `flushPromises` 辅助函数确保测试稳定性 [app/composables/useCodexApi.test.ts](L1-L<end>)：

```typescript
it('should fetch sessions correctly', async () => {
  // 模拟 API 响应
  vi.mocked(fetchSessions).mockResolvedValue(mockSessions);
  
  const { result } = renderHook(() => useSessions());
  
  // 等待异步操作完成
  await flushPromises();
  
  expect(result.value.sessions).toEqual(mockSessions);
});
```

## 运行测试

### 命令行脚本

通过 `package.json` 中定义的脚本管理测试生命周期：

```bash
# 运行所有测试（单次运行模式）
pnpm test

# 运行测试并生成覆盖率报告
pnpm test -- --coverage

# 监听模式（开发时使用）
pnpm test -- --watch

# 仅运行与模式匹配的测试
pnpm test -- -t "useCredentials"

# 调试模式
pnpm test -- --debug
```

**运行模式说明**：默认 `vitest run` 采用非监听模式，适合 CI/CD 流水线；开发阶段可通过 `--watch` 启用热更新，Vitest 会智能感知文件变更并仅运行受影响测试 [package.json](L34)。

## 覆盖率配置

项目配置了 **V8** 覆盖率收集器，生成多格式报告：

| 报告格式 | 生成路径 | 用途 |
|---------|---------|------|
| text | stdout | 控制台快速查看 |
| json | coverage/coverage-final.json | 工具链集成 |
| html | coverage/ | 可视化浏览器查看 |

覆盖率阈值未在配置中强制设定，允许逐步优化。可通过 `--coverage.threshold` 参数临时设置：

```bash
# 设置行覆盖率阈值为 80%
pnpm test -- --coverage.threshold=80
```

## Mock 策略

项目测试采用 **依赖注入式 Mock** 模式，而非全局替换。关键策略包括：

1. **Storage Mock**：使用内存对象模拟 localStorage/sessionStorage
2. **API Mock**：通过 `vi.mocked()` 包装 fetch 函数，控制网络响应
3. **时间 Mock**：使用 `vi.useFakeTimers()` 处理定时器逻辑
4. **组件 Mock**：对 Electron 相关模块提供空实现，避免环境依赖 [app/utils/notificationManager.test.ts](L1-L<end>)

```typescript
// 示例：Mock 外部模块
vi.mock('electron', () => ({
  ipcRenderer: {
    send: vi.fn(),
    on: vi.fn(),
  },
}));
```

## 类型安全保证

Vitest 天然继承 Vite 的 TypeScript 配置，共享 `tsconfig.json` 中的路径别名和编译选项。项目配置了 `vue-tsc` 进行类型检查，确保测试代码与源代码保持相同的类型严格度：

```bash
# 运行类型检查（不编译）
pnpm lint
```

测试文件中的类型定义遵循与源代码相同的规范，例如使用 `typeof` 获取实现类型以避免重复声明。

## 集成测试策略

对于涉及多个模块交互的场景，项目采用 **集成测试** 方法，验证组合式函数之间的协同工作：

```typescript
// useSettings.test.ts 中的集成测试示例
it('should persist settings across reloads', async () => {
  // 集成 useSettings 与 useStorage
  const { result: settings } = renderHook(() => useSettings());
  const { result: storage } = renderHook(() => useStorage());
  
  settings.value.update({ theme: 'dark' });
  await flushPromises();
  
  // 验证存储层正确保存
  expect(storage.value.get('settings')).toContain('dark');
});
```

## 性能优化建议

针对 Electron 应用的测试场景，建议关注以下优化点：

1. **并行执行**：Vitest 默认启用线程池，可通过 `--pool=forks` 调整进程数
2. **缓存策略**：依赖文件变更检测，避免重复转换
3. **测试隔离**：使用 `beforeEach` 清理状态，防止测试间污染

## 调试失败的测试

当测试失败时，Vitest 提供丰富的调试信息：

```bash
# 仅运行失败测试
pnpm test -- --reporter=verbose

# 显示堆栈跟踪
pnpm test -- --stack-trace

# 交互式调试（断点）
pnpm test -- --inspect-brk
```

配合 VS Code 的 Debugger for Chrome 扩展，可在 `launch.json` 中配置 Vitest 调试配置，实现单步调试。

## 最佳实践清单

- ✅ 测试文件与实现文件保持 1:1 邻近关系
- ✅ 每个测试用例职责单一，不超过 50 行代码
- ✅ 使用 `describe` 分组相关测试，保持层次不超过 3 层
- ✅ Mock 外部依赖而非真实调用
- ✅ 异步测试必须包含 `await` 和超时处理
- ✅ 测试用例名称采用 `should <预期行为> when <条件>` 格式
- ✅ 定期运行覆盖率检查，识别未测试代码路径

## 故障排除

| 问题 | 可能原因 | 解决方案 |
|------|---------|----------|
| "Cannot find module" 错误 | 路径别名未在测试环境生效 | 检查 `vite.config.ts` 中 `test.alias` 配置 |
| DOM 相关 API 报错 | 环境配置错误 | 确认 `environment: 'happy-dom'` 已设置 |
| 测试执行缓慢 | 并行度不足 | 增加 `poolOptions.threads.size` 配置 |
| 类型检查失败 | tsconfig 路径不匹配 | 验证 `compilerOptions.paths` 与 Vite alias 一致 |

## 相关资源

测试框架配置与项目其他模块的关联如下：
- 构建配置影响测试环境变量注入 → [构建配置](28-gou-jian-pei-zhi)
- CI/CD 流水线集成测试任务 → [GitHub Actions 自动化](30-github-actions-zi-dong-hua)
- TypeScript 类型定义在测试中的使用 → [类型定义](23-lei-xing-ding-yi)