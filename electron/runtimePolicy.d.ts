export type NavigationDecision = 'allow' | 'open-external' | 'deny';

export declare function resolveAppRelativePath(pathname: string): string | null;

export declare function classifyMime(relativePath: string): string;

export declare function classifyNavigation(navigationUrl: string, expectedAppUrl: string): NavigationDecision;

export declare function classifyWindowOpen(url: string): 'open-external' | 'deny';

export declare function isPermissionAllowed(permission: string): boolean;

export interface TrustedSenderInput {
  senderId: number;
  mainWebContentsId: number | null;
  mainWebContentsDestroyed: boolean;
}

export declare function isTrustedSender(input: TrustedSenderInput): boolean;
