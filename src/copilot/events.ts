import type { PermissionOptionKind, StopReason, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

/**
 * Domain-level view of what Copilot is doing.
 *
 * The rest of the Bridge consumes these rather than raw ACP notifications, so
 * that a protocol change is absorbed here instead of rippling into the Agent
 * Core, the approval flow, and every interaction provider.
 */

export interface ToolCallSummary {
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: ToolKind;
  readonly status: ToolCallStatus;
  /** The shell command, when this is an `execute` call. */
  readonly command: string | null;
  /** Files the tool touches, from ACP `locations`. */
  readonly paths: readonly string[];
  readonly rawInput: unknown;
}

export interface PlanEntrySummary {
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
  readonly priority: 'high' | 'medium' | 'low';
}

export type CopilotEvent =
  /** A chunk of the reply intended for the user. */
  | { readonly kind: 'message'; readonly text: string }
  /** Internal reasoning. Hidden unless `output.show_thoughts` is on (§29). */
  | { readonly kind: 'thought'; readonly text: string }
  /** Copilot echoing back the prompt it received. */
  | { readonly kind: 'echo'; readonly text: string }
  | { readonly kind: 'tool-started'; readonly call: ToolCallSummary }
  | {
      readonly kind: 'tool-updated';
      readonly toolCallId: string;
      readonly status: ToolCallStatus | null;
      readonly title: string | null;
      readonly output: string | null;
    }
  | { readonly kind: 'plan'; readonly entries: readonly PlanEntrySummary[] }
  | { readonly kind: 'usage'; readonly used: number; readonly size: number }
  | { readonly kind: 'mode-changed'; readonly mode: string }
  | { readonly kind: 'title'; readonly title: string }
  /**
   * A variant the Bridge deliberately does not surface (available command
   * lists, config option menus, unstable plan deltas). Kept as an explicit
   * event rather than a silent drop so that the exhaustive switch in the parser
   * keeps working when ACP grows a new update type.
   */
  | { readonly kind: 'ignored'; readonly sessionUpdate: string };

export interface CopilotPermissionOption {
  readonly optionId: string;
  readonly kind: PermissionOptionKind;
  readonly name: string;
}

/** A blocking permission request from Copilot — the approval interception point. */
export interface CopilotPermissionRequest {
  readonly toolCallId: string | null;
  readonly title: string;
  readonly toolKind: ToolKind | null;
  readonly command: string | null;
  readonly paths: readonly string[];
  readonly options: readonly CopilotPermissionOption[];
  readonly rawInput: unknown;
}

export type CopilotPermissionResponse =
  | { readonly type: 'selected'; readonly optionId: string }
  | { readonly type: 'cancelled' };

export interface CopilotExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when the Bridge asked the process to stop. */
  readonly expected: boolean;
  /** Tail of stderr, to make crash reports actionable (§39). */
  readonly stderrTail: string;
}

export interface PromptResult {
  readonly stopReason: StopReason;
}
