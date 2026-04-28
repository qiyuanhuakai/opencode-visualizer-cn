供应商与模型管理模块提供统一的界面来配置 AI 服务提供商及其可用模型，支持连接、断开、启用/禁用供应商，以及细粒度控制每个模型的可见性。该模块采用双后端适配器架构，支持 OpenCode 本地服务和 Codex 远程服务两种模式，并通过全局配置实现状态的持久化存储。

## 核心架构

### 后端适配器注册表

系统通过注册表模式管理不同的后端适配器，当前支持 `opencode` 和 `codex` 两种后端类型。适配器注册表负责初始化、切换和获取后端服务实例，为上层提供统一的操作接口 [app/backends/registry.ts](app/backends/registry.ts#L1-L34)。

```typescript
const adapters: Record<BackendKind, BackendAdapter | undefined> = {
  opencode: createOpenCodeAdapter(),
  codex: createCodexAdapter({ url: 'ws://localhost:23004/codex' }),
};
```

### 统一适配器接口

所有后端适配器必须实现 `BackendAdapter` 接口，定义了会话管理、工作树操作等核心能力。不同后端根据其 `BackendCapabilities` 声明支持的功能子集 [app/backends/types.ts](app/backends/types.ts#L1-L59)。

| 接口方法 | 描述 | 参数 |
|---------|------|------|
| `createSession` | 创建新会话 | `directory?: string` |
| `forkSession` | 分支会话 | `sessionId`, `messageId`, `directory?` |
| `updateSession` | 更新会话元数据 | `sessionId`, `payload`, `directory?` |
| `deleteSession` | 删除会话 | `sessionId`, `directory?` |
| `listSessions` | 列出会话 | `options?: ListSessionsOptions` |
| `updateProject` | 更新项目配置 | `projectId`, `payload` |
| `createWorktree` | 创建工作树 | `directory` |
| `deleteWorktree` | 删除工作树 | `directory`, `targetDirectory` |

## 供应商管理

### 供应商状态分类

供应商根据连接状态和配置来源分为以下几类：

- **已连接供应商**：通过认证且当前可用的服务提供商，显示在"已连接"区域
- **已配置但未连接**：存在于全局配置中但未通过认证的供应商，显示在"所有提供商"区域
- **环境变量提供者**：通过环境变量注入的供应商（如 `OPENAI_API_KEY`），不可断开连接
- **自定义供应商**：用户通过表单动态添加的第三方服务

### 供应商连接流程

连接供应商涉及身份验证方法的解析与执行。系统首先通过 `listProviderAuthMethods` API 获取供应商支持的认证方式，然后根据认证类型执行相应流程 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L1021-L1073)：

1. **API 密钥认证**：直接提示用户输入密钥，调用 `setProviderAuth` 保存凭证
2. **OAuth 认证**：启动 OAuth 流程，用户在浏览器中完成授权后返回验证代码
3. **多因素认证**：依次提示用户输入多个认证因子

认证凭证存储在 `auth.credentials.v1` 键下，通过 Electron 的持久化存储或 localStorage 保存 [app/utils/storageKeys.ts](app/utils/storageKeys.ts#L1-L135)。

### 供应商启用/禁用

启用或禁用供应商通过更新全局配置中的 `disabled_providers` 列表实现。启用逻辑采用白名单优先策略：当 `enabled_providers` 非空时，供应商必须同时存在于白名单且不在黑名单中才算启用 [app/utils/providerConfig.ts](app/utils/providerConfig.ts#L14-L31)。

```typescript
export function buildProviderDisabledPatch(
  providerConfig: ProviderConfigState | null | undefined,
  providerId: string,
  nextEnabled: boolean,
) {
  const normalizedProviderId = providerId.trim();
  const currentDisabled = new Set(normalizeProviderIds(providerConfig?.disabled_providers));
  if (normalizedProviderId) {
    if (nextEnabled) {
      currentDisabled.delete(normalizedProviderId);
    } else {
      currentDisabled.add(normalizedProviderId);
    }
  }
  return { disabled_providers: Array.from(currentDisabled) };
}
```

## 模型管理

### 模型可见性控制

每个供应商提供的模型列表通过 `ProviderInfo.models` 字段暴露，模型标识符采用 `{providerID}/{modelID}` 的复合键格式。模型可见性独立于供应商启用状态，允许用户隐藏特定模型而保留供应商整体可用 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L662-L708)。

隐藏模型列表存储在 `model.visibility` 键中，格式为 `ModelVisibilityEntry[]` 数组。`toggleModel` 函数通过修改该数组实现模型的显示/隐藏切换，修改后通过 `update:model-visibility` 事件向上传递 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L1069-L1087)：

```typescript
function toggleModel(modelKey: string, nextEnabled: boolean) {
  const nextByKey = new Map<string, ModelVisibilityEntry>();
  props.hiddenModels.forEach((key) => {
    const [providerID, modelID] = key.split('/');
    if (!providerID || !modelID) return;
    nextByKey.set(key, { providerID, modelID, visibility: 'hide' });
  });
  if (nextEnabled) {
    nextByKey.delete(modelKey);
  } else {
    const [providerID, modelID] = modelKey.split('/');
    if (providerID && modelID) {
      nextByKey.set(modelKey, { providerID, modelID, visibility: 'hide' });
    }
  }
  emit('update:model-visibility', Array.from(nextByKey.values()).sort(...));
}
```

### 模型能力标记

每个模型可携带能力标记，指示其支持的功能特性 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L433-L442)：

| 能力标记 | 描述 | UI 显示 |
|---------|------|---------|
| `reasoning` | 支持推理模式 | `{{ $t('providerManager.models.capabilities.reasoning') }}` |
| `toolcall` | 支持工具调用 | `{{ $t('providerManager.models.capabilities.toolcall') }}` |
| `attachment` | 支持文件附件 | `{{ $t('providerManager.models.capabilities.attachment') }}` |

### 模型搜索与分组

模型列表支持实时搜索过滤，按供应商分组显示。`filteredGroups` 计算属性首先过滤匹配搜索词的模型，然后按供应商分组并排序 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L680-L707)。

## 自定义供应商配置

### 自定义供应商表单

自定义供应商功能允许用户添加不内置的 AI 服务提供商。表单包含以下必填字段 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L72-L135)：

| 字段 | 验证规则 | 描述 |
|------|---------|------|
| `providerID` | 必需、小写字母数字、下划线/连字符、以字母数字开头 | 内部标识符 |
| `name` | 必需 | 显示名称 |
| `baseURL` | 必需、以 `http://` 或 `https://` 开头 | API 基础地址 |
| `apiKey` | 可选、支持 `{env:VAR_NAME}` 语法 | 认证密钥或环境变量引用 |

### 模型与请求头配置

自定义供应商可声明多个模型，每个模型需指定 ID 和显示名称。此外支持配置自定义 HTTP 请求头，用于传递认证令牌或其他元数据 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L114-L150)。

### 配置验证与提交

提交前进行严格的表单验证，包括重复检查、格式校验等。验证通过后，配置通过 `updateGlobalConfig` API 发送到后端保存 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L830-L949]。

## 数据持久化

### 配置存储结构

供应商和模型配置统一存储在 OpenCode 后端的全局配置中，主要字段包括：

```typescript
type ProviderConfigState = {
  enabled_providers?: string[];      // 白名单（空表示全部启用）
  disabled_providers?: string[];     // 黑名单
  provider?: Record<string, unknown>; // 各供应商详细配置
};
```

### 本地存储键

前端状态通过 localStorage 或 Electron 持久化存储进行本地缓存，关键存储键包括 [app/utils/storageKeys.ts](app/utils/storageKeys.ts#L1-L135)：

| 存储键 | 用途 | 版本 |
|--------|------|------|
| `auth.credentials.v1` | API 凭证 | v1 |
| `auth.serverUrl.v1` | OpenCode 服务器地址 | v1 |
| `model.visibility` | 模型可见性列表 | 未版本化 |
| `settings.regionTheme.v2` | 区域主题配置 | v2 |

### 存储后端迁移

Electron 应用支持从 localStorage 迁移到 Electron 的持久化存储。迁移逻辑在应用启动时自动执行，确保数据不丢失 [app/utils/storageKeys.ts](app/utils/storageKeys.ts#L11-L44)。

## 后端交互

### OpenCode 适配器

OpenCode 适配器通过 HTTP REST API 与本地 OpenCode 服务通信，实现了完整的 `BackendAdapter` 接口。所有请求携带 `x-opencode-directory` 请求头以关联工作目录 [app/backends/openCodeAdapter.ts](app/backends/openCodeAdapter.ts#L1-L31)。

关键 API 端点包括：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/provider` | GET | 列出所有可用供应商 |
| `/provider/auth` | GET | 获取认证方法列表 |
| `/auth/{providerId}` | PUT | 设置认证凭证 |
| `/auth/{providerId}` | DELETE | 删除认证凭证 |
| `/global/config` | PATCH | 更新全局配置（供应商/模型可见性） |
| `/session` | GET/POST | 会话列表/创建 |

### Codex 适配器

Codex 适配器通过 JSON-RPC over WebSocket 与远程 Codex 服务通信，支持更丰富的会话操作和文件系统访问 [app/backends/codex/codexAdapter.ts](app/backends/codex/codexAdapter.ts#L1-L100)。JSON-RPC 客户端实现请求-响应匹配、超时处理和错误转换 [app/backends/codex/jsonRpcClient.ts](app/backends/codex/jsonRpcClient.ts#L1-L100)。

## 用户界面组件

### ProviderManagerModal 结构

供应商管理模态框采用双标签页设计：左侧为供应商管理，右侧为模型管理 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L20-L48)。

模态框接收以下 props：

| Prop | 类型 | 描述 |
|------|------|------|
| `open` | `boolean` | 控制模态框显示 |
| `providers` | `ProviderInfo[]` | 可用供应商列表 |
| `connectedProviderIds` | `string[]` | 已连接供应商 ID 集合 |
| `selectedModel` | `string` | 当前选中的模型标识 |
| `hiddenModels` | `string[]` | 隐藏的模型列表 |
| `providerConfig` | `ProviderConfigState \| null` | 全局配置状态 |

### 状态反馈机制

所有异步操作提供实时反馈，包括加载状态（`busyProviderId`）、消息提示（`feedbackMessage`）和消息类型（`feedbackTone`）。错误处理统一捕获并显示友好的错误信息 [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue#L589-L606)。

### 响应式设计

模态框采用响应式布局，最大宽度 980px，最大高度 88vh，确保在小屏幕上也能正常操作。所有交互元素支持键盘导航和屏幕阅读器访问。

## 集成点

### App.vue 集成

主应用通过 `ProviderManagerModal` 组件集成供应商管理功能，负责 [app/App.vue](app/App.vue#L316-L324)：

1. 从 OpenCode 后端获取 `providers` 和 `providerConfig` 数据
2. 维护 `hiddenModels` 响应式状态并持久化到本地存储
3. 处理 `update:model-visibility` 事件更新模型可见性配置
4. 处理 `config-updated` 事件同步全局配置变更

### 全局配置同步

供应商配置变更通过 `config-updated` 事件广播，触发下游组件重新读取配置并更新 UI。模型可见性变更通过 `update:model-visibility` 事件同步到父组件，进而影响会话创建时的模型选择逻辑。

## 下一步探索

- [用户界面组件](10-yong-hu-jie-mian-zu-jian) — 了解 ProviderManagerModal 的完整样式系统和交互细节
- [后端服务与 API](8-hou-duan-fu-wu-yu-api) — 深入 OpenCode 服务端 API 设计
- [国际化 (i18n) 系统](11-guo-ji-hua-i18n-xi-tong) — 查看供应商管理的多语言文本映射
- [Electron 桌面端集成](7-electron-zhuo-mian-duan-ji-cheng) — 理解持久化存储的跨平台实现