import type {
  OmpCommandInfo,
  OmpEvent,
  OmpHostToolCall,
  OmpMessageView,
  OmpRuntimeState,
  OmpUiRequest,
  OmpSubagentView,
} from "../shared/contracts.js";

export interface AgentViewState {
  runtime?: OmpRuntimeState;
  messages: OmpMessageView[];
  uiRequest?: OmpUiRequest;
  hostToolCall?: OmpHostToolCall;
  commands?: OmpCommandInfo[];
  subagents: OmpSubagentView[];
  notice?: string;
}

export function initialAgentViewState(): AgentViewState {
  return { messages: [], subagents: [] };
}

/**
 * Deterministic reducer for the Agent Studio. Streaming deltas append to the
 * matching assistant message; message frames upsert; tool frames upsert their
 * card; UI and host-tool frames replace the active modal request.
 */
export function reduceAgentEvent(
  state: AgentViewState,
  event: OmpEvent,
): AgentViewState {
  switch (event.type) {
    case "delta": {
      const existing = state.messages.find(
        (message) => message.id === event.messageId,
      );
      if (existing) {
        return {
          ...state,
          messages: state.messages.map((message) =>
            message.id === event.messageId
              ? { ...message, text: message.text + event.text }
              : message,
          ),
        };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: event.messageId,
            role: "assistant",
            text: event.text,
            status: "streaming",
            toolCalls: [],
          },
        ],
      };
    }
    case "message":
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
      };
    case "tool": {
      const targetIndex = state.messages
        .map((message) => message.role)
        .lastIndexOf("assistant");
      if (targetIndex === -1) {
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: `tool-${event.tool.id}`,
              role: "assistant",
              text: "",
              status: "complete",
              toolCalls: [{ ...event.tool }],
            },
          ],
        };
      }
      return {
        ...state,
        messages: state.messages.map((message, index) => {
          if (index !== targetIndex) return message;
          const exists = message.toolCalls.some(
            (tool) => tool.id === event.tool.id,
          );
          return exists
            ? {
                ...message,
                toolCalls: message.toolCalls.map((tool) =>
                  tool.id === event.tool.id ? { ...event.tool } : tool,
                ),
              }
            : {
                ...message,
                toolCalls: [...message.toolCalls, { ...event.tool }],
              };
        }),
      };
    }
    case "agent":
      if (event.phase === "end") {
        return {
          ...state,
          messages: state.messages.map((message) =>
            message.status === "streaming"
              ? { ...message, status: "complete" }
              : message,
          ),
        };
      }
      return state;
    case "state":
    case "status":
      return {
        ...state,
        runtime: event.type === "state" ? event.state : event.status,
      };
    case "ui":
      return { ...state, uiRequest: event.request };
    case "host-tool":
      return { ...state, hostToolCall: event.call };
    case "commands":
      return { ...state, commands: event.commands };
    case "subagents":
      return {
        ...state,
        subagents: mergeSubagents(state.subagents, event.subagents),
      };
    case "error":
      return { ...state, notice: event.message };
    default:
      return state;
  }
}

function upsertMessage(
  messages: OmpMessageView[],
  message: OmpMessageView,
): OmpMessageView[] {
  const existing = messages.find((candidate) => candidate.id === message.id);
  if (!existing) {
    return [...messages, message];
  }
  return messages.map((candidate) =>
    candidate.id === message.id
      ? { ...candidate, ...message, toolCalls: message.toolCalls }
      : candidate,
  );
}

function mergeSubagents(
  current: OmpSubagentView[],
  incoming: OmpSubagentView[],
): OmpSubagentView[] {
  const merged = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) {
    merged.set(subagent.id, { ...merged.get(subagent.id), ...subagent });
  }
  return [...merged.values()];
}
