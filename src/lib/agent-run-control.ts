export type AgentRunStatus = 'done' | 'todo' | 'blocked';

export interface AgentRunControl {
  status: AgentRunStatus;
  unassign: boolean;
}

const DEFAULT_CONTROL: AgentRunControl = { status: 'done', unassign: false };
const DIRECTIVE = /(?:^|\n)\s*CLAWTASK_FINAL:\s*(\{[^\n]*\})\s*$/m;

/**
 * Agent task runs are authenticated by the Gateway connection, not an HTTP
 * credential handled by the model. The final, non-secret directive lets that
 * verified run request its terminal state. Invalid/missing directives default
 * to done so an ordinary completed task preserves the historic lifecycle.
 */
export function parseAgentRunControl(output: string): AgentRunControl {
  const match = output.match(DIRECTIVE);
  if (!match) return DEFAULT_CONTROL;

  try {
    const raw = JSON.parse(match[1]) as { status?: unknown; unassign?: unknown };
    if (raw.status !== 'done' && raw.status !== 'todo' && raw.status !== 'blocked') {
      return DEFAULT_CONTROL;
    }
    return { status: raw.status, unassign: raw.unassign === true };
  } catch {
    return DEFAULT_CONTROL;
  }
}

/** Remove the machine directive from the visible agent comment. */
export function stripAgentRunControl(output: string): string {
  return output.replace(DIRECTIVE, '').trim();
}
