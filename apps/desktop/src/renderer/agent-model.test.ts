import { describe, expect, it } from "vitest";

import type { OmpEvent } from "../shared/contracts.js";
import { initialAgentViewState, reduceAgentEvent } from "./agent-model.js";

function stateEvents(events: OmpEvent[]) {
  return events.reduce(reduceAgentEvent, initialAgentViewState());
}

describe("Agent Studio model", () => {
  it("appends streaming deltas to the matching assistant message", () => {
    const view = stateEvents([
      { type: "delta", messageId: "m1", text: "Hello " },
      { type: "delta", messageId: "m1", text: "omp" },
    ]);
    expect(view.messages).toEqual([
      {
        id: "m1",
        role: "assistant",
        text: "Hello omp",
        status: "streaming",
        toolCalls: [],
      },
    ]);
  });

  it("upserts message frames and completes streaming messages on agent end", () => {
    const view = stateEvents([
      {
        type: "message",
        message: {
          id: "m2",
          role: "user",
          text: "Reply with hello",
          status: "complete",
          toolCalls: [],
        },
      },
      {
        type: "message",
        message: {
          id: "m3",
          role: "assistant",
          text: "he",
          status: "streaming",
          toolCalls: [],
        },
      },
      { type: "delta", messageId: "m3", text: "llo" },
      { type: "agent", phase: "end" },
    ]);
    const assistant = view.messages.find((message) => message.id === "m3");
    expect(assistant?.text).toBe("hello");
    expect(assistant?.status).toBe("complete");
    expect(view.messages).toHaveLength(2);
  });

  it("attaches tool calls to the last assistant message", () => {
    const view = stateEvents([
      {
        type: "message",
        message: {
          id: "m1",
          role: "user",
          text: "Use the browser",
          status: "complete",
          toolCalls: [],
        },
      },
      {
        type: "message",
        message: {
          id: "m2",
          role: "assistant",
          text: "Running…",
          status: "streaming",
          toolCalls: [],
        },
      },
      {
        type: "tool",
        tool: { id: "t1", name: "read", state: "running" },
      },
      {
        type: "tool",
        tool: { id: "t1", name: "read", state: "success", summary: "4 lines" },
      },
    ]);
    const assistant = view.messages.find((message) => message.id === "m2");
    expect(assistant?.toolCalls).toEqual([
      { id: "t1", name: "read", state: "success", summary: "4 lines" },
    ]);
    const user = view.messages.find((message) => message.id === "m1");
    expect(user?.toolCalls).toEqual([]);
  });

  it("tracks runtime state, UI requests, host-tool calls and notices", () => {
    const view = stateEvents([
      {
        type: "state",
        state: {
          running: true,
          isStreaming: false,
          messageCount: 1,
          todoPhases: [],
        },
      },
      {
        type: "ui",
        request: { id: "ui-1", method: "confirm", title: "Continue?" },
      },
      {
        type: "host-tool",
        call: { id: "host-1", toolName: "lhic_browser_execute", arguments: {} },
      },
      { type: "error", message: "provider unreachable" },
    ]);
    expect(view.runtime?.running).toBe(true);
    expect(view.uiRequest).toMatchObject({ id: "ui-1", method: "confirm" });
    expect(view.hostToolCall?.toolName).toBe("lhic_browser_execute");
    expect(view.notice).toBe("provider unreachable");
  });

  it("tracks available slash commands", () => {
    const view = stateEvents([
      {
        type: "commands",
        commands: [
          { name: "compact", description: "Compress the conversation" },
          { name: "todos", aliases: ["todo"] },
        ],
      },
    ]);
    expect(view.commands).toEqual([
      { name: "compact", description: "Compress the conversation" },
      { name: "todos", aliases: ["todo"] },
    ]);
  });

  it("merges structured subagent progress without transcript scraping", () => {
    const view = stateEvents([
      {
        type: "subagents",
        subagents: [
          {
            id: "worker-1",
            label: "Reviewer",
            task: "Review the patch",
            status: "running",
            model: "gpt-5.6-sol",
          },
        ],
      },
      {
        type: "subagents",
        subagents: [
          {
            id: "worker-1",
            label: "Reviewer",
            task: "Review the patch",
            status: "completed",
            progress: "No blocking issues",
          },
        ],
      },
    ]);
    expect(view.subagents).toEqual([
      expect.objectContaining({
        id: "worker-1",
        status: "completed",
        model: "gpt-5.6-sol",
        progress: "No blocking issues",
      }),
    ]);
  });
});
