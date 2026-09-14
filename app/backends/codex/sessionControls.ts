import { computed, ref, type Ref } from 'vue';
import type { CodexConfigReadResult, CodexConfigRequirementsReadResult, CodexModel, CodexPromptInput } from './codexAdapter';

export const CODEX_PERMISSION_MODES = [
  { id: 'read-only', name: '只读', description: '只允许读取；需要执行操作时请求审批', approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  { id: 'workspace-write', name: '工作区写入', description: '允许修改工作区；其他操作请求审批', approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  { id: 'full-access', name: '完全访问', description: '允许任意文件和网络访问，不请求审批', approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
] as const;

type ControlsOptions = {
  models: Ref<CodexModel[]>;
  modelId: () => string;
  config: Ref<CodexConfigReadResult | null>;
  requirements: Ref<CodexConfigRequirementsReadResult['requirements']>;
  writeTier: (tier: string) => Promise<void>;
  refreshRequirements: () => Promise<void>;
};
export function createCodexSessionControls(options: ControlsOptions) {
  const tierOverride = ref<string | null>(null);
  let generation = 0;
  const selectedPermissionMode = ref('');
  const permissionModes = computed(() => CODEX_PERMISSION_MODES.filter((mode) => {
    const requirements = options.requirements.value;
    return (!requirements?.allowedApprovalPolicies || requirements.allowedApprovalPolicies.includes(mode.approvalPolicy))
      && (!requirements?.allowedSandboxModes || requirements.allowedSandboxModes.includes(mode.sandbox));
  }));
  const selectedServiceTier = computed(() => {
    const configured = options.config.value?.config.service_tier;
    const modelId = options.modelId();
    const model = options.models.value.find((entry) => entry.id === modelId || entry.model === modelId);
    const tier = tierOverride.value ?? (typeof configured === 'string' && configured ? configured : model?.defaultServiceTier ?? 'default');
    return tier === 'default' || model?.serviceTiers?.some((entry) => entry.id === tier) ? tier : 'default';
  });
  async function setFastMode(enabled: boolean) {
    const currentGeneration = generation;
    const modelId = options.modelId();
    const model = options.models.value.find((entry) => entry.model === modelId || entry.id === modelId);
    const fastTier = model?.serviceTiers?.find((tier) => /^(fast|priority)$/i.test(tier.id) || /^fast$/i.test(tier.name));
    if (enabled && !fastTier) throw new Error('当前模型目录未声明可用的 Fast 服务档位。');
    const tier = enabled && fastTier ? fastTier.id : 'default';
    await options.writeTier(tier);
    if (currentGeneration === generation) tierOverride.value = tier;
  }
  async function setPermissionMode(id: string) {
    const currentGeneration = generation;
    await options.refreshRequirements();
    if (currentGeneration !== generation) throw new Error('会话已切换，请重新选择权限模式。');
    const mode = permissionModes.value.find((entry) => entry.id === id);
    if (!mode) throw new Error('此权限模式不可用或被服务器策略禁止。');
    selectedPermissionMode.value = mode.id;
  }
  function promptSettings(): Pick<CodexPromptInput, 'serviceTier' | 'approvalPolicy' | 'sandboxPolicy' | 'thread'> {
    const mode = permissionModes.value.find((entry) => entry.id === selectedPermissionMode.value);
    const configured = options.config.value?.config.service_tier;
    const hasTierOverride = tierOverride.value !== null || (typeof configured === 'string' && configured.length > 0);
    return {
      ...(hasTierOverride ? { serviceTier: selectedServiceTier.value } : {}),
      ...(mode ? { approvalPolicy: mode.approvalPolicy, sandboxPolicy: mode.sandboxPolicy, thread: { approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox } } : {}),
    };
  }
  function resetPermissions() { generation += 1; selectedPermissionMode.value = ''; }
  function reset() { resetPermissions(); tierOverride.value = null; }
  return { selectedServiceTier, selectedPermissionMode, permissionModes, setFastMode, setPermissionMode, promptSettings, reset, resetPermissions };
}
