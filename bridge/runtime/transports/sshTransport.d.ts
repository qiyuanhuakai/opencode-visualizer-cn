import type { ProcessRelayOptions, ProcessRelay } from './processRelay.js';

export type SshTarget = {
  readonly alias: string;
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly identityFiles: readonly string[];
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly strictHostKeyChecking?: string;
  readonly userKnownHostsFile?: string;
  readonly forwardAgent?: string;
  readonly requestTTY?: string;
};
export type SshForward = {
  readonly localHost?: string;
  readonly localPort?: number;
  readonly remoteHost: string;
  readonly remotePort: number;
};
export type HostKey = { readonly keyType: string; readonly keyBlob: string };
export type HostKeyEntry = {
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  readonly keyBlob: string;
};
export type TargetHelloRequest = {
  readonly host: string;
  readonly port: number;
  readonly frame: { readonly kind: string; readonly version: number };
  readonly timeoutMs: number;
};
export type TargetHelloResult = { readonly ok: boolean; readonly error?: string };
export type SshProfile = {
  readonly profileId: string;
  readonly transport: { readonly kind: 'ssh'; readonly endpoint?: string };
  readonly target: { readonly kind: 'ssh'; readonly environmentId: string };
  readonly credentialRef?: string;
  readonly enabled?: boolean;
  readonly role?: string;
};
export type DialedSshTransport = {
  readonly environmentId: string;
  readonly connectionId: string;
  readonly state: string;
  readonly ready: boolean;
  readonly forward: { readonly host: string; readonly port: number };
  readonly close?: () => Promise<void>;
};
export type SshTransport = {
  open(profile: SshProfile): Promise<DialedSshTransport>;
  state(profileId: string): string;
  close(): Promise<void>;
};
export type SshResponder = (challenge: {
  readonly kind: string;
  readonly prompt: string;
  readonly challengeId: string;
}) =>
  | { readonly accept?: boolean; readonly persist?: boolean; readonly secret?: string }
  | string
  | undefined
  | Promise<{ readonly accept?: boolean; readonly persist?: boolean; readonly secret?: string } | string | undefined>;
export type SshTransportOptions = {
  readonly platform?: string;
  readonly spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown;
  readonly stopProcessTree?: (child: unknown, options?: unknown) => unknown;
  readonly relay?: ProcessRelay | unknown;
  readonly configText?: string;
  readonly configPath?: string;
  readonly knownHostsText?: string;
  readonly knownHostsPath?: string;
  readonly knownHostsFile?: string;
  readonly hostKeyProvider?: (target: SshTarget) => HostKey | Promise<HostKey>;
  readonly persistKnownHost?: (entry: HostKeyEntry) => unknown;
  readonly method?: string;
  readonly responder?: SshResponder;
  readonly passphraseRequired?: boolean;
  readonly readAllocatedPort?: (child: unknown) => number | Promise<number>;
  readonly targetHello?: (request: TargetHelloRequest) => TargetHelloResult | Promise<TargetHelloResult>;
  readonly remoteHost?: string;
  readonly remotePort?: number;
  readonly helloTimeoutMs?: number;
  readonly secretDirectory?: string;
  readonly askpassPath?: string;
  readonly display?: string;
  readonly baseEnv?: Record<string, string | undefined>;
  readonly cwd?: string;
};
export const TARGET_HELLO: { readonly kind: string; readonly version: number };
export const TARGET_HELLO_OK: { readonly kind: string; readonly version: number };
export function sshProgram(platform?: string): string;
export function parseSshConfig(text: string): readonly { patterns: readonly string[]; options: Map<string, string[]> }[];
export function resolveSshConfig(configText: string | readonly unknown[], host: string): {
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: readonly string[];
  proxyJump?: string;
  proxyCommand?: string;
  strictHostKeyChecking?: string;
  userKnownHostsFile?: string;
  forwardAgent?: string;
  requestTTY?: string;
};
export function resolveSshTarget(input: {
  endpoint?: string;
  host?: string;
  port?: number;
  hostName?: string;
  user?: string;
  identityFiles?: readonly string[];
  proxyJump?: string;
  proxyCommand?: string;
  strictHostKeyChecking?: string;
  userKnownHostsFile?: string;
  configText?: string;
}): SshTarget;
export function buildSshArgv(options: {
  target: Partial<SshTarget>;
  platform?: string;
  forward?: SshForward;
  configPath?: string;
  knownHostsFile?: string;
  identityFiles?: readonly string[];
  strictHostKeyChecking?: string;
  connectTimeoutSeconds?: number;
  serverAliveInterval?: number;
  program?: string;
}): readonly string[];
export function buildSshEnvironment(options?: {
  base?: Record<string, string | undefined>;
  channel?: { env?: Record<string, string> };
}): Record<string, string>;
export function assertNoShellConcatenation(tokens: readonly string[]): readonly string[];
export function assertSecretFreeArgv(argv: readonly string[], secrets?: readonly string[]): readonly string[];
export function parseAllocatedPort(text: string): number | undefined;
export function createSshTransport(options?: SshTransportOptions & Partial<ProcessRelayOptions>): SshTransport;
