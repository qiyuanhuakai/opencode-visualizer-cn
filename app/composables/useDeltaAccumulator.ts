import type {
  MessageInfo,
  MessagePart,
  MessagePartDeltaPacket,
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
} from '../types/sse';

type GlobalEvents = {
  on(event: string, listener: (payload: any) => void): () => void;
};

export type AccumulatedMessage = {
  info: MessageInfo;
  parts: Map<string, MessagePart>;
};

const messages = new Map<string, AccumulatedMessage>();

function isComplete(info: MessageInfo): boolean {
  if (info.role !== 'assistant') return true;
  if (info.error) return true;
  if (info.time.completed !== undefined) return true;
  if (info.finish) return true;
  return false;
}

export function useDeltaAccumulator() {
  function listen(ge: GlobalEvents): () => void {
    const offs: Array<() => void> = [];

    offs.push(
      ge.on('message.updated', (packet: MessageUpdatedPacket) => {
        const info = packet.info;
        if (isComplete(info)) {
          messages.delete(info.id);
          return;
        }
        const entry = messages.get(info.id);
        if (entry) {
          entry.info = info;
        } else {
          messages.set(info.id, { info, parts: new Map() });
        }
      }),
    );

    offs.push(
      ge.on('message.part.updated', (packet: MessagePartUpdatedPacket) => {
        const part = packet.part;
        const entry = messages.get(part.messageID);
        if (!entry) return;
        entry.parts.set(part.id, { ...part });
      }),
    );

    offs.push(
      ge.on('message.part.delta', (packet: MessagePartDeltaPacket) => {
        const entry = messages.get(packet.messageID);
        if (!entry) return;
        const part = entry.parts.get(packet.partID);
        if (!part) return;
        const field = packet.field as keyof typeof part;
        if (field in part && typeof part[field] === 'string') {
          (part[field] as string) += packet.delta;
        } else {
          (part as Record<string, unknown>)[field] = packet.delta;
        }
      }),
    );

    offs.push(ge.on('connection.reconnected', () => clear()));

    return () => {
      for (const off of offs) off();
    };
  }

  function getMessage(messageID: string): AccumulatedMessage | undefined {
    return messages.get(messageID);
  }

  function clear(): void {
    messages.clear();
  }

  return { listen, getMessage, clear };
}
