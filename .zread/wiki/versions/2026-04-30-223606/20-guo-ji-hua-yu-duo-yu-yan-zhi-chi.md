Vis 的国际化系统基于 **Vue I18n** 构建，采用集中式消息字典 + 组件按需引用的架构模式。整个系统围绕三个核心文件展开：`app/i18n/index.ts` 负责创建 i18n 实例与持久化逻辑，`app/i18n/types.ts` 定义了所有支持语言的统一类型契约，`app/i18n/useI18n.ts` 则提供了一层薄封装以统一组件内的引用方式。当前项目已完整支持 **英语（en）、简体中文（zh-CN）、繁体中文（zh-TW）、日语（ja）和世界语（eo）** 五种语言，每种语言对应一个独立的消息文件，位于 `app/locales/` 目录下。

Sources: [index.ts](app/i18n/index.ts#L1-L64), [types.ts](app/i18n/types.ts#L1-L3), [useI18n.ts](app/i18n/useI18n.ts#L1-L6)

## 核心架构：三层设计

Vis 的 i18n 实现可以概括为 **配置层、类型层、消费层** 的三层结构。配置层在 `app/i18n/index.ts` 中通过 `createI18n` 创建全局实例，并硬编码了五种语言的导入与回退策略（fallbackLocale 固定为 `en`）。类型层通过 `LocaleMessages` 接口为所有语言文件提供编译时类型检查，确保新增翻译键时不会遗漏任何语言版本。消费层则分为两条路径：Vue 单文件组件通过全局 `$t` 函数或 `useI18n()` 组合式函数在模板与脚本中引用；非组件模块（如工具函数、composables）则通过 `../i18n/useI18n` 引入封装后的 hook。

```mermaid
flowchart TD
    A[app/i18n/index.ts<br/>createI18n 实例] --> B[全局挂载至 Vue App]
    B --> C[组件模板: $t('key')]
    B --> D[组件脚本: useI18n()]
    D --> E[composables / utils<br/>通过 ../i18n/useI18n 引入]
    F[app/i18n/types.ts<br/>LocaleMessages 接口] --> G[app/locales/*.ts<br/>五种语言字典]
    F --> H[编译时类型检查]
```

Sources: [index.ts](app/i18n/index.ts#L1-L64), [main.ts](app/main.ts#L1-L28), [useI18n.ts](app/i18n/useI18n.ts#L1-L6)

## 语言持久化与运行时切换

语言设置通过 `storageKeys` 工具持久化到 `localStorage`（Electron 环境下会优先写入 Electron 持久化存储），键名为 `settings.locale.v1`。`getStoredLocale()` 在应用启动时读取该值并校验其是否属于 `VALID_LOCALES` 白名单，若无效则回退到默认英语。`SettingsModal.vue` 中的语言选择器通过 `v-model` 绑定 `locale` 响应式变量，并监听其变化调用 `setLocale()` 完成实时切换。此外，`index.ts` 还监听了同源的 `storage` 事件，当其他标签页修改语言时，当前实例会自动同步更新，保证多窗口场景下的一致性。

Sources: [index.ts](app/i18n/index.ts#L10-L64), [SettingsModal.vue](app/components/SettingsModal.vue#L541-L945)

## 消息字典的组织方式

所有翻译文本按功能域划分为顶层命名空间，每个命名空间对应应用中的一个模块或概念。`LocaleMessages` 接口完整定义了这些命名空间，确保五种语言文件在结构上保持严格一致。以下是主要命名空间及其职责的概览：

| 命名空间 | 职责范围 | 典型使用场景 |
|---|---|---|
| `app` | 全局应用级文本 | 登录页、连接状态、错误提示、窗口标题、Git 操作 |
| `topPanel` | 顶部面板 | 会话搜索、批量管理、项目设置入口 |
| `sidePanel` | 侧边栏 | 标签切换、待办列表、会话树 |
| `inputPanel` | 输入区域 | 占位符、模型选择、发送按钮提示 |
| `settings` | 设置模态框 | 语言选择、字体配置、主题管理、实验性功能 |
| `floatingWindow` | 悬浮窗通用操作 | 搜索、复制、最小化、关闭 |
| `toolWindow` / `toolTitles` | 工具窗口 | 权限请求、问题回复、各类工具标题 |
| `statusMonitor` | 状态监控面板 | 服务器健康、MCP/LSP 状态、Token 用量 |
| `providerManager` | 提供商管理 | 连接/断开、自定义提供商表单、模型列表 |
| `treeView` | 文件树与分支 | Git 分支操作、文件差异统计、目录展开 |
| `common` | 通用词汇 | 加载、错误、确认、取消等高频词 |
| `time` | 时间表达 | 相对时间（"in X minutes"） |
| `welcome` | 欢迎页 | 首次进入时的引导文案 |
| `render` | 渲染相关 | 代码复制按钮标签、复制成功提示 |
| `codexPanel` | Codex 集成面板 | 线程管理、审批、文件系统、模型与技能配置 |

Sources: [types.ts](app/i18n/types.ts#L1-L1311), [en.ts](app/locales/en.ts#L1-L1365)

## 参数插值与动态文本

Vis 大量使用了 Vue I18n 的**命名参数插值**能力来处理动态内容。典型模式是在消息字符串中预留 `{paramName}` 占位符，调用时传入对象参数。例如 `app.error.actionDisabled` 的值为 `"{action} is temporarily disabled."`，在组件中通过 `t('app.error.actionDisabled', { action: 'Fork' })` 即可生成上下文相关的错误提示。类似的用法遍布状态提示、Git 差异加载、批量操作失败报告、Token 用量统计等场景。这种设计将文案模板与业务数据解耦，使翻译人员无需接触代码逻辑即可维护文本。

Sources: [en.ts](app/locales/en.ts#L71-L75), [App.vue](app/App.vue#L1485-L1530)

## 组件内的两种消费模式

在 Vue 单文件组件中，Vis 同时使用了两种 i18n 消费风格。**模板内全局调用**适用于简单的静态文本展示，例如 `<div>{{ $t('sidePanel.session.title') }}</div>` 或 `:aria-label="$t('sidePanel.expandPanel')"`，这种方式无需在 `<script>` 中引入任何依赖。**脚本内组合式调用**则适用于需要动态计算或逻辑控制的场景，组件先在 `<script setup>` 中执行 `const { t } = useI18n()`，随后在计算属性、方法或事件处理中调用 `t()`。目前项目中有约 49 个文件显式引入了 `useI18n`，其中 45 个直接来自 `vue-i18n`，4 个（位于 `composables` 和 `utils` 中）通过项目内部的 `../i18n/useI18n` 封装引入，以保持与全局实例的严格对齐。

Sources: [SidePanel.vue](app/components/SidePanel.vue#L8-L38), [TopPanel.vue](app/components/TopPanel.vue#L6-L16), [useCodeRender.ts](app/utils/useCodeRender.ts#L6-L31)

## 渲染缓存与语言感知

一个值得注意的高级用法出现在 `useAssistantPreRenderer` 中。该组合式函数负责在 Web Worker 中预渲染助手消息为 HTML，为了提升性能，它维护了一个响应式缓存 `assistantHtmlCache`。缓存的失效键不仅包含消息内容和主题，还显式包含了当前 `locale.value`。这意味着当用户切换语言时，所有已渲染的助手消息会立即触发重新渲染，确保代码块内的复制按钮标签（如 "Copy code" / "复制代码"）等界面元素与当前语言保持一致。这种将语言状态纳入缓存键的设计，是国际化与性能优化交叉领域的典型实践。

Sources: [useAssistantPreRenderer.ts](app/composables/useAssistantPreRenderer.ts#L23-L118)

## 新增语言的步骤

若需为 Vis 添加一种新的语言支持，需要完成以下四步操作：

1. **扩展类型**：在 `app/i18n/types.ts` 的 `Locale` 联合类型中追加新的语言标识符（如 `'fr'`）。
2. **创建字典**：在 `app/locales/` 下新建语言文件（如 `fr.ts`），实现 `LocaleMessages` 接口。建议复制 `en.ts` 作为起点，逐条翻译。
3. **注册实例**：在 `app/i18n/index.ts` 中导入新字典，加入 `VALID_LOCALES` 数组，并在 `createI18n` 的 `messages` 中注册。
4. **更新设置界面**：在 `SettingsModal.vue` 的语言选择 `<select>` 中新增 `<option>`，并在所有语言文件的 `settings.language` 命名空间下补充新语言的显示名称。

Sources: [types.ts](app/i18n/types.ts#L1), [index.ts](app/i18n/index.ts#L8-L35), [SettingsModal.vue](app/components/SettingsModal.vue#L36-L44)

## 与周边模块的关联

国际化系统并非孤立存在，它与多个功能模块紧密协作。在**设置与个性化**维度，语言选择与主题、字体配置共同位于 `SettingsModal` 中，用户可在同一入口完成界面风格的整体调整，相关内容可参阅 [主题令牌与区域配色系统](21-zhu-ti-ling-pai-yu-qu-yu-pei-se-xi-tong) 与 [字体管理与系统字体发现](22-zi-ti-guan-li-yu-xi-tong-zi-ti-fa-xian)。在**状态与通信**维度，`useGlobalEvents` 将 `t` 函数注入 SSE 连接层，用于生成连接断开、重连等状态的本地化提示，其底层机制详见 [SSE 连接管理与事件协议](8-sse-lian-jie-guan-li-yu-shi-jian-xie-yi)。在**渲染与性能**维度，如前文所述，`useAssistantPreRenderer` 利用 `locale` 作为缓存键的一部分，实现了语言切换与预渲染缓存的联动，该渲染架构的完整说明位于 [Web Worker 渲染池与缓存策略](10-web-worker-xuan-ran-chi-yu-huan-cun-ce-lue)。