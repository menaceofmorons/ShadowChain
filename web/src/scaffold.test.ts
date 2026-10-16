import { ReactFlow } from "@xyflow/react";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("runs under jsdom", () => {
    expect(typeof document).toBe("object");
  });

  it("resolves @xyflow/react", () => {
    expect(ReactFlow).toBeDefined();
  });
});
