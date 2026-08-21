import type { ApprovalRequest } from '../approval/models.js';
import type { ToolCallSummary } from '../copilot/events.js';
import type { MemoryEntry, Session, SessionStatus } from './types.js';

/**
 * The Bridge's internal event vocabulary (spec §37).
 *
 * This is the seam that keeps the Agent Core free of Discord: the Core emits
 * these, and interaction providers subscribe. Nothing in the Core ever calls a
 * Discord API.
 */
export interface BridgeEventMap {
  UserMessageReceived: { sessionId: string; projectId: string; text: string; author: string };
  SessionCreated: { session: Session };
  SessionStatusChanged: { sessionId: string; from: SessionStatus; to: SessionStatus };

  CopilotStarted: { sessionId: string; copilotSessionId: string; pid: number | null };
  CopilotMessageReceived: { sessionId: string; text: string };
  CopilotThoughtReceived: { sessionId: string; text: string };
  CopilotActionRequested: { sessionId: string; call: ToolCallSummary };
  CopilotActionCompleted: {
    sessionId: string;
    toolCallId: string;
    status: 'completed' | 'failed';
    output: string | null;
  };
  CopilotCompleted: { sessionId: string; stopReason: string };
  CopilotFailed: { sessionId: string; reason: string };

  ApprovalRequested: { approval: ApprovalRequest };
  ApprovalApproved: { approval: ApprovalRequest; resolvedBy: string };
  ApprovalRejected: { approval: ApprovalRequest; resolvedBy: string };
  ApprovalExpired: { approval: ApprovalRequest };

  SessionCancelled: { sessionId: string; reason: string };
  SessionReset: { oldSessionId: string; newSessionId: string | null };

  MemoryRequested: { requestId: string; projectId: string; sessionId: string; content: string };
  MemoryApproved: { entry: MemoryEntry; approvedBy: string };
  MemoryRejected: { requestId: string; projectId: string; content: string; rejectedBy: string };
}

export type BridgeEventName = keyof BridgeEventMap;
export type BridgeEventHandler<Name extends BridgeEventName> = (
  payload: BridgeEventMap[Name],
) => void | Promise<void>;

/**
 * A small typed event bus.
 *
 * Handlers are isolated: one that throws is logged and skipped rather than
 * being allowed to abort the emit, because emits happen on the ACP read path
 * and a bad subscriber must not stall Copilot.
 */
export class EventBus {
  private readonly handlers = new Map<BridgeEventName, Set<(payload: never) => unknown>>();

  constructor(private readonly onHandlerError: (event: string, error: unknown) => void) {}

  on<Name extends BridgeEventName>(name: Name, handler: BridgeEventHandler<Name>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as (payload: never) => unknown);
    this.handlers.set(name, set);
    return () => {
      set.delete(handler as (payload: never) => unknown);
    };
  }

  emit<Name extends BridgeEventName>(name: Name, payload: BridgeEventMap[Name]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        const result = (handler as BridgeEventHandler<Name>)(payload);
        if (result instanceof Promise) {
          result.catch((error) => this.onHandlerError(name, error));
        }
      } catch (error) {
        this.onHandlerError(name, error);
      }
    }
  }

  listenerCount(name: BridgeEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}
