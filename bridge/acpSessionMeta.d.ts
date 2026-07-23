export type AcpSessionTurnMeta = {
  userText: string;
  userTime?: number;
  assistantTime?: number;
  model?: string;
  agent?: string;
};

export function parseKimiWireLog(content: string): AcpSessionTurnMeta[];
export function parseOmpSessionLog(content: string): AcpSessionTurnMeta[];
export function loadAcpSessionTurnMeta(
  agentId: string,
  sessionId: string,
  options?: { homeDir?: string },
): Promise<AcpSessionTurnMeta[] | null>;
