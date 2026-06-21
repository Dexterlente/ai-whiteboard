import { describe, it, expect } from "vitest";
import { balancedObject, findJsonObject } from "./json";

describe("balancedObject", () => {
  it("ignores braces inside string values", () => {
    expect(balancedObject('{"a":"x{y}z"}', 0)).toBe('{"a":"x{y}z"}');
  });
  it("handles nested objects", () => {
    expect(balancedObject('{"a":{"b":1}}', 0)).toBe('{"a":{"b":1}}');
  });
  it("respects escaped quotes", () => {
    expect(balancedObject('{"a":"he said \\"hi\\""}', 0)).toBe('{"a":"he said \\"hi\\""}');
  });
  it("returns null when unbalanced", () => {
    expect(balancedObject('{"a":1', 0)).toBeNull();
  });
});

describe("findJsonObject", () => {
  const hasReply = (o: any) => typeof o.reply === "string";

  it("finds a bare object", () => {
    expect(findJsonObject('{"reply":"hi"}', hasReply)).toEqual({ reply: "hi" });
  });
  it("unwraps a ```json fence", () => {
    expect(findJsonObject('```json\n{"reply":"hi"}\n```', hasReply)).toEqual({ reply: "hi" });
  });
  it("skips a preamble brace and a non-matching object", () => {
    const text = 'Here {x} you go: {"note":"n"} {"reply":"ok"}';
    expect(findJsonObject(text, hasReply)).toEqual({ reply: "ok" });
  });
  it("returns null when nothing qualifies", () => {
    expect(findJsonObject("no json here", hasReply)).toBeNull();
  });
});
