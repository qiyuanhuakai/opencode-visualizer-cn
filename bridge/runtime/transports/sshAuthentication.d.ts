export type AuthChallengeKind =
  | 'host-key'
  | 'host-key-changed'
  | 'password'
  | 'passphrase'
  | 'otp'
  | 'keyboard-interactive';
export type AuthChallenge = {
  readonly challengeId: string;
  readonly kind: AuthChallengeKind | string;
  readonly prompt: string;
  readonly echo: false;
  readonly redacted: true;
  readonly createdAt: number;
  readonly fingerprint?: string;
  readonly options?: readonly string[];
};
export type AuthAnswer =
  | { readonly accept?: boolean; readonly persist?: boolean; readonly secret?: string }
  | string
  | undefined;
export type AuthResponder = (challenge: AuthChallenge) => AuthAnswer | Promise<AuthAnswer>;
export type SecretBox = {
  readonly label: string;
  readonly size: number;
  consume(): string;
  toString(): string;
  toJSON(): string;
};
export type HostKeyEntry = {
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  readonly keyBlob: string;
};
export type AuthResult = {
  readonly hostKeyStatus: 'trusted' | 'unknown' | 'changed' | 'revoked';
  readonly hostKeyFingerprint: string;
  readonly knownHostEntry?: HostKeyEntry;
  readonly methods: readonly string[];
  readonly secrets: readonly SecretBox[];
};
export type AuthenticationSession = {
  authenticate(): Promise<AuthResult>;
  cancel(reason?: unknown): void;
  readonly pending: AuthChallenge | undefined;
};
export type AuthSessionOptions = {
  readonly host: string;
  readonly port?: number;
  readonly user?: string;
  readonly hostKey: { readonly keyType?: string; readonly keyBlob?: string };
  readonly knownHosts: readonly import('./knownHosts.js').KnownHostEntry[];
  readonly method?: string;
  readonly responder?: AuthResponder;
  readonly now?: () => number;
  readonly passphraseRequired?: boolean;
};
export type SecretChannelOptions = {
  readonly directory?: string;
  readonly askpassPath?: string;
  readonly display?: string;
};
export type SecretChannel = {
  readonly env: Readonly<Record<string, string>>;
  readonly filePath: string | undefined;
  cleanup(): Promise<void>;
};
export const AUTH_CHALLENGE_KINDS: readonly AuthChallengeKind[];
export const REDACTED: string;
export function redactSecrets(value: unknown, secrets?: readonly unknown[]): string;
export function createSecretBox(secret: string, label?: string): SecretBox;
export function createSecretChannel(
  secrets: readonly string[],
  options?: SecretChannelOptions,
): Promise<{ readonly env: Readonly<Record<string, string>>; readonly filePath: string; cleanup(): Promise<void> }>;
export function createSecretChannel(
  secrets: readonly (string | SecretBox | undefined)[] | undefined,
  options?: SecretChannelOptions,
): Promise<SecretChannel>;
export function createAuthenticationSession(options: AuthSessionOptions): AuthenticationSession;
