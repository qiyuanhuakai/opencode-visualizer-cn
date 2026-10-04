const builtinPresets = {
  standard: {
    en: ['Standard mode', 'Work with code, files and documents using search, editing and terminal tools.'],
    zh: ['标准模式', '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。'],
  },
  ptc: {
    en: ['PTC mode', 'Standard capabilities with batch tool calls, filtering, deduplication and aggregation.'],
    zh: ['PTC 模式', '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总。'],
  },
  minimal: {
    en: ['Minimal mode', 'Use terminal tools to complete tasks and compare baseline performance.'],
    zh: ['极简模式', 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。'],
  },
  cordis: {
    en: ['Creator mode', 'Create plugins, features and interfaces, or compose tools and prompts into your own mode.'],
    zh: ['创造模式', '用对话定制 DSH：编写插件、添加功能或界面，也能组合工具和提示词，创建自己的模式。'],
  },
} as const;

export function dshPresetPresentation(preset: { name: string; label: string; description: string }, locale: string) {
  const builtin = Object.hasOwn(builtinPresets, preset.name)
    ? Object.entries(builtinPresets).find(([id]) => id === preset.name)?.[1]
    : undefined;
  const copy = builtin?.[locale.startsWith('zh') ? 'zh' : 'en'];
  return {
    label: preset.label === preset.name ? copy?.[0] ?? preset.label : preset.label,
    description: preset.description || copy?.[1] || '',
  };
}
