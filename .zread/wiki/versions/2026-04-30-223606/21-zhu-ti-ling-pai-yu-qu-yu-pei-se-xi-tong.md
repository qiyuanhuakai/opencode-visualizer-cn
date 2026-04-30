本文档介绍 VIS 应用的主题架构，涵盖从底层语义令牌（Semantic Token）到区域配色（Region Theme）的完整映射链路，以及预设主题管理、外部主题导入导出和运行时 CSS 变量注入机制。该系统的核心设计目标是在保持组件级样式解耦的同时，支持全局一致的视觉主题切换与深度自定义。

Sources: [themeTokens.ts](app/utils/themeTokens.ts#L1-L2027), [regionTheme.ts](app/utils/regionTheme.ts#L1-L763), [useRegionTheme.ts](app/composables/useRegionTheme.ts#L1-L178)

---

## 架构总览：三层令牌体系

主题系统采用三层递进结构：**语义令牌层** → **区域/组件令牌层** → **CSS 变量注入层**。语义令牌是系统中最细粒度的颜色抽象，以设计意图命名（如 `surface-panel`、`text-primary`），而非具体的色值。区域令牌则将语义令牌绑定到特定的 UI 区域（如 `topPanel`、`sidePanel`），组件令牌进一步覆盖独立组件（如 `dropdown`、`chip`、`dock`）。最终，所有令牌通过 `useRegionTheme` 组合式函数转换为 CSS 自定义属性（`--theme-*`），注入到 `:root` 元素上，供全应用组件消费。

```mermaid
flowchart TD
    A[RegionThemeConfig<br/>区域主题配置] -->|regionThemeToSemanticOverrides| B[SemanticTokenOverrides<br/>语义令牌覆盖]
    B -->|createSemanticTokenSnapshot| C[SemanticTokenMap<br/>完整令牌快照]
    C -->|syncThemeVariables| D[CSS Custom Properties<br/>--theme-* 变量]
    D --> E[Vue Components<br/>var(--theme-*) 消费]
    F[External Theme JSON<br/>外部主题文件] -->|parseExternalThemeFile| A
    G[ThemeStorageV2<br/>持久化存储] -->|storageToRegionTheme| A
```

Sources: [themeTokens.ts](app/utils/themeTokens.ts#L1358-L1710), [useRegionTheme.ts](app/composables/useRegionTheme.ts#L93-L124)

---

## 核心类型与数据结构

### 区域定义（RegionName）

应用界面被划分为 9 个逻辑区域，每个区域拥有独立的颜色配置空间。区域通过 CSS 类选择器与 DOM 节点关联，同时映射为 CSS 变量前缀。

| 区域名称 | CSS 选择器 | 变量前缀 |
|---|---|---|
| `topPanel` | `.top-panel` | `top` |
| `sidePanel` | `.side-panel` | `side` |
| `inputPanel` | `.input-panel` | `input` |
| `outputPanel` | `.output-panel` | `output` |
| `topDropdown` | `.top-center, .tree-menu` | `top-dropdown` |
| `modalPanel` | `.modal, .provider-manager-modal, .status-monitor-popover` | `modal` |
| `loginScreen` | `.app-loading-view` | `login` |
| `pageBackground` | `html, body, #app` | `page` |
| `chatCard` | `.thread-block` | `chat` |

每个区域支持 8 个颜色字段：`bg`（背景）、`text`（文本）、`border`（边框）、`accent`（强调色）、`controlBg`（控件背景）、`activeBg`（激活背景）、`activeText`（激活文本）、`textMuted`（弱化文本）。

Sources: [regionTheme.ts](app/utils/regionTheme.ts#L1-L275)

### 语义令牌分类

语义令牌总数超过 200 个，分为四大类别，均以字符串字面量类型精确约束：

**基础语义令牌（BaseSemanticThemeToken）**：涵盖表面色（`surface-*`）、文本色（`text-*`）、边框色（`border-*`）、强调色（`accent-*`）、状态色（`status-*`）、阴影（`shadow-*`）等通用设计语义，约 110 个。

**区域令牌（RegionThemeToken）**：由 `RegionName × RegionColorField` 组合生成，例如 `top-bg`、`side-text`、`modal-accent`，共 72 个。

**组件令牌（ComponentThemeToken）**：覆盖 12 个独立组件，包括 `dropdown-*`、`chip-*`、`dock-*`、`form-control-*`、`tab-*`、`badge-*`、`card-*`、`toggle-*`、`list-row-*`、`empty-state-*`、`action-button-*`、`search-*`，约 80 个。

**悬浮窗令牌（FloatingThemeToken）**：针对 10 种悬浮窗类型（`default`、`shell`、`reasoning`、`subagent`、`tool`、`file`、`diff`、`media`、`dialog`、`history`、`debug`）分别定义 `accent`、`background-color`、`opacity`、`titlebar-opacity`、`background-image`，共 55 个。

Sources: [themeTokens.ts](app/utils/themeTokens.ts#L37-L427)

---

## 预设主题与注册表

系统内置 4 套预设主题，全部以 `RegionThemeConfig` 结构硬编码。预设主题不仅定义区域颜色，还包含组件覆盖和悬浮窗主题配置。

| 预设 ID | 标签 | 风格特征 |
|---|---|---|
| `default` | Default | 所有区域颜色为 `undefined`，回退到默认暗色令牌 |
| `ocean` | 深海 | 蓝青色调，深海氛围，支持悬浮窗渐变背景 |
| `forest` | 林境 | 绿色自然系，低饱和度森林配色 |
| `sakura` | 樱粉幻梦 | 粉紫暖色调，半透明毛玻璃质感 |

预设主题通过 `themeRegistry.ts` 中的注册表机制对外暴露。`ThemeRegistryEntry` 结构除了包含主题配置本身，还携带国际化标签键（`labelKey`/`badgeKey`/`descriptionKey`）、色板预览（`swatches`）和来源标记（`builtin` 或 `external`）。`listThemeRegistryEntries` 函数将内置预设与外部主题合并为统一的注册表视图。

Sources: [regionTheme.ts](app/utils/regionTheme.ts#L294-L713), [themeRegistry.ts](app/utils/themeRegistry.ts#L259-L512)

---

## 主题存储与持久化格式

主题运行时状态通过 `ThemeStorageV2` 接口持久化到 `localStorage`，键名为 `settings.themeTokens.v2`。该结构采用版本号（`version: 2`）设计，支持从旧版 `RegionThemeConfig` 直存格式迁移。

```typescript
type ThemeStorageV2 = {
  version: 2;
  preset: string | null;        // 关联的注册表预设 ID
  label?: string;               // 自定义主题显示名
  regions?: Record<RegionName, Partial<RegionColors>>;
  components?: ThemeComponentConfig;
  floating?: Partial<FloatingWindowThemeColors>;
  overrides: SemanticTokenOverrides; // 语义令牌覆盖字典
};
```

存储设计的核心思想是**以语义令牌为单一事实来源**。当用户选择 `ocean` 预设时，`regionThemeToStorage` 将该预设展开为完整的 `overrides` 字典（包含所有区域、组件、悬浮窗令牌的实际色值），同时保留 `preset: 'ocean'` 用于回查注册表元数据。这种扁平化存储策略使得运行时无需依赖注册表即可重建完整主题快照，也为后续细粒度令牌编辑奠定基础。

Sources: [themeTokens.ts](app/utils/themeTokens.ts#L432-L441), [useSettings.ts](app/composables/useSettings.ts#L125-L142)

---

## 运行时注入机制

### useRegionTheme 组合式函数

`useRegionTheme` 是主题系统的运行时核心。它通过 Vue 的响应式系统监听 `themeStorage` 的变化，并将主题状态同步到 DOM。该组合式函数采用**共享监听器模式**：无论多少个组件调用它，实际的 `watch` 监听器和持久化定时器只创建一份，通过 `sharedConsumerCount` 引用计数管理生命周期。

当 `themeStorage` 变化时，依次执行以下操作：

1. **预设属性标记**：若当前存储关联了非默认预设，在 `document.documentElement` 上设置 `data-region-theme` 属性（如 `data-region-theme="ocean"`），否则移除该属性。该属性用于 CSS 选择器级别的预设隔离。
2. **语义变量同步**：调用 `createSemanticTokenSnapshot` 合并默认令牌与存储中的 `overrides`，生成完整令牌快照，然后遍历 `SEMANTIC_THEME_TOKENS`，将每个令牌值写入 `--theme-${token}` CSS 变量。未覆盖的令牌会被显式清除，确保主题切换时无残留。
3. **语法主题标记**：固定设置 `--syntax-theme-name` 为 `github-dark`。

持久化采用 140ms 的防抖策略（`REGION_THEME_PERSIST_DEBOUNCE_MS`），避免频繁编辑时重复写入 `localStorage`。同时监听 `beforeunload` 和 `pagehide` 事件，在页面离开前强制刷写待持久化的值。

Sources: [useRegionTheme.ts](app/composables/useRegionTheme.ts#L90-L177)

### ThemeInjector 组件

`ThemeInjector.vue` 是一个无渲染组件，仅在 `App.vue` 根模板中挂载一次，负责在应用启动时触发 `useRegionTheme()` 的初始化逻辑。这种设计将主题副作用与业务组件完全解耦。

Sources: [ThemeInjector.vue](app/components/ThemeInjector.vue#L1-L8), [App.vue](app/App.vue#L3)

---

## 外部主题扩展

系统支持通过 JSON 文件导入自定义主题。外部主题定义需符合 `ExternalThemeDefinition` 接口，并与 JSON Schema（`/schema/theme.schema.json`）对齐。Schema 严格约束了 `id`（仅允许字母、数字、下划线、连字符）、`label`、`regions`（9 个必填区域）以及可选的 `components` 和 `floating` 字段。

导入流程由 `SettingsModal.vue` 中的主题设置页驱动：`parseExternalThemeFileText` 解析并校验上传文件 → `normalizeExternalThemeDefinition` 规范化字段 → 写入 `externalThemes` 响应式数组 → 通过 `useSettings` 中的 `watch` 自动持久化到 `settings.themeRegistry.v1`。外部主题与内置预设共享同一套注册表查询接口，用户可在设置面板中像切换内置主题一样切换外部主题。

导出功能支持两种模式：导出空白模板（`createThemeTemplate`）供用户二次创作，或导出当前激活主题的完整定义（`createExternalThemeDefinition`）。

Sources: [themeRegistry.ts](app/utils/themeRegistry.ts#L315-L495), [SettingsModal.vue](app/components/SettingsModal.vue#L685-L735)

---

## 样式消费模式

组件层通过 CSS `var()` 函数消费主题变量，形成**令牌 → CSS 变量 → 组件样式**的单向数据流。以 `app/styles/tailwind.css` 为例，UI 组件变量（如 `--ui-chip-border-neutral`）以 `--theme-*` 为首选值，并携带硬编码的暗色回退：

```css
--ui-chip-border-neutral: var(--theme-chip-border-neutral, var(--theme-border-muted, rgba(148, 163, 184, 0.65)));
```

这种双层回退策略确保即使主题系统未初始化或某个令牌未定义，组件仍能呈现可接受的默认外观。全应用有超过 1200 处 `var(--theme-*)` 引用，覆盖几乎所有视觉元素。

Sources: [tailwind.css](app/styles/tailwind.css#L24-L59)

---

## 测试覆盖

主题系统拥有完整的单元测试矩阵，覆盖以下关键路径：

- **令牌映射正确性**：验证 `regionThemeToSemanticOverrides` 能将 `OCEAN_PRESET` 正确转换为语义覆盖（如 `surface-panel` → `#1a1a2e`）。
- **存储迁移**：验证旧版 `RegionThemeConfig` 能被 `migrateLegacyRegionThemeStorage` 正确升级为 `ThemeStorageV2`。
- **快照完整性**：验证 `createSemanticTokenSnapshot` 在稀疏覆盖下仍能返回包含所有 200+ 令牌的完整字典。
- **DOM 同步**：验证 `useRegionTheme` 挂载后，`document.documentElement` 的 `data-region-theme` 属性与 CSS 变量是否正确写入。
- **浮动窗 Alpha 剥离**：验证 `stripColorAlpha` 能将 `rgba`/`hsla`/`#RRGGBBAA` 正确去透明化，同时保持独立的 `opacity` 令牌。

Sources: [themeTokens.test.ts](app/utils/themeTokens.test.ts#L1-L184), [useRegionTheme.test.ts](app/composables/useRegionTheme.test.ts#L1-L160), [regionTheme.test.ts](app/utils/regionTheme.test.ts#L1-L141)

---

## 相关阅读

- 如需了解字体管理与系统字体发现机制，请参阅 [字体管理与系统字体发现](22-zi-ti-guan-li-yu-xi-tong-zi-ti-fa-xian)。
- 如需了解设置面板的整体数据流与持久化策略，请参阅 [存储键命名与持久化策略](28-cun-chu-jian-ming-ming-yu-chi-jiu-hua-ce-lue)。
- 如需了解悬浮窗的生命周期与分类，请参阅 [悬浮窗生命周期与 Dock 管理](15-xuan-fu-chuang-sheng-ming-zhou-qi-yu-dock-guan-li)。