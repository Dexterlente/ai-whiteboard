import { describe, it, expect } from "vitest";
import {
  applyEvent,
  toolLabel,
  toolInputPreview,
  sessionKeyForFolder,
  type AgentState,
  type AssistantTurn,
} from "./agent";

function seed(): AgentState {
  return {
    transcript: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", tools: [], streaming: true },
    ],
    sessionId: null,
  };
}
const fold = (state: AgentState, lines: string[]): AgentState =>
  lines.reduce((s, l) => applyEvent(s, l), state);
function lastAsst(s: AgentState): AssistantTurn {
  const t = s.transcript[s.transcript.length - 1];
  if (t.role !== "assistant") throw new Error("last turn is not assistant");
  return t;
}

describe("applyEvent", () => {
  it("captures session_id from system/init", () => {
    const s = applyEvent(seed(), '{"type":"system","subtype":"init","session_id":"sid123","cwd":"/x"}');
    expect(s.sessionId).toBe("sid123");
  });

  it("accumulates streamed text deltas as a live preview", () => {
    const s = fold(seed(), [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}',
    ]);
    expect(lastAsst(s).streamingText).toBe("Hello");
  });

  it("commits finalized assistant text + tool_use and clears the preview", () => {
    const s = fold(seed(), [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}}',
    ]);
    const a = lastAsst(s);
    expect(a.text).toBe("Hello");
    expect(a.streamingText).toBe("");
    expect(a.tools).toEqual([{ id: "t1", name: "Read", inputPreview: "a.ts" }]);
  });

  it("attaches a tool_result to its tool_use by id", () => {
    const s = fold(seed(), [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file.txt","is_error":false}]}}',
    ]);
    expect(lastAsst(s).tools[0].result).toBe("file.txt");
    expect(lastAsst(s).tools[0].isError).toBe(false);
  });

  it("joins text across multiple assistant messages", () => {
    const s = fold(seed(), [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}',
    ]);
    expect(lastAsst(s).text).toBe("one\n\ntwo");
  });

  it("settles streaming on the result event and keeps session_id", () => {
    const s = fold(seed(), [
      '{"type":"system","subtype":"init","session_id":"sid9"}',
      '{"type":"result","subtype":"success","session_id":"sid9","result":"done"}',
    ]);
    expect(lastAsst(s).streaming).toBe(false);
    expect(s.sessionId).toBe("sid9");
  });

  it("ignores malformed lines without throwing", () => {
    const before = seed();
    expect(applyEvent(before, "not json {")).toBe(before);
  });
});

describe("toolInputPreview / toolLabel", () => {
  it("previews common tools", () => {
    expect(toolInputPreview("Bash", { command: "npm test" })).toBe("npm test");
    expect(toolInputPreview("Read", { file_path: "src/x.ts" })).toBe("src/x.ts");
    expect(toolInputPreview("Grep", { pattern: "foo" })).toBe("foo");
    expect(toolInputPreview("Anything", null)).toBe("");
  });

  it("labels with an icon", () => {
    expect(toolLabel("Bash", "npm test")).toBe("💻 Bash: npm test");
    expect(toolLabel("Read", "x")).toBe("🔧 Read: x");
    expect(toolLabel("Custom", "")).toBe("🔧 Custom");
  });
});

describe("sessionKeyForFolder", () => {
  it("is stable, prefixed, and charset-safe", () => {
    const a = sessionKeyForFolder("/home/dexter/proj");
    expect(a).toMatch(/^panel-[0-9a-f]{8}$/);
    expect(sessionKeyForFolder("/home/dexter/proj")).toBe(a);
    expect(sessionKeyForFolder("/other")).not.toBe(a);
  });
});
