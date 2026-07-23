import type { AcpAgentConfig } from './bridgeConfig.js';
import type { AcpProcessStatus } from './acpProcessManager.js';

export const STOP_GRACE_MS: number;
export const BRIDGE_CLIENT_METHODS: ReadonlySet<string>;

export function sameAcpLaunch(previous: AcpAgentConfig, next: AcpAgentConfig): boolean;
export function createAcpProcessStatus(agent: AcpAgentConfig): AcpProcessStatus;
export function summarizeAcpProcessError(stderr: unknown): string;
export function formatAcpProcessError(agent: Pick<AcpAgentConfig, 'id'>, stderr: unknown): string;
