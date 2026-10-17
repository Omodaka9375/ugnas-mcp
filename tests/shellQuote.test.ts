import { describe, expect, it } from "vitest";

import { shq, shqArgs } from "../src/ssh/shellQuote.js";

describe("shq", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shq("nginx")).toBe("'nginx'");
  });

  it("quotes an empty string safely", () => {
    expect(shq("")).toBe("''");
  });

  it("neutralizes embedded single quotes", () => {
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  it("contains shell metacharacters instead of executing them", () => {
    expect(shq("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(shq("$(whoami)")).toBe("'$(whoami)'");
    expect(shq("`id`")).toBe("'`id`'");
  });

  it("joins argument lists", () => {
    expect(shqArgs(["a", "b c"])).toBe("'a' 'b c'");
  });
});
