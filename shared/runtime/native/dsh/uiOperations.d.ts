export const DSH_UI_OPERATIONS: Readonly<Record<string, { readonly scope: 'instance' | 'session'; readonly mutation: boolean; readonly identity?: 'agentId' | 'request.sessionId' }>>;
