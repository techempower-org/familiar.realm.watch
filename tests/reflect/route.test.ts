import { test, expect, describe } from "bun:test";
import { handleReflect } from "../../src/routes/reflect.ts";
import type { ReflectWriter } from "../../src/reflect/writer.ts";
import type { ReflectDecision } from "../../src/reflect/types.ts";

const fakeWriter = (decisions: ReflectDecision[]): ReflectWriter => ({
  review: async () => decisions,
} as unknown as ReflectWriter);

describe("POST /api/familiar/reflect", () => {
  test("400 on missing session_id", async () => {
    const req = new Request("http://x/api/familiar/reflect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistant_turn: "irrelevant" }),
    });
    const res = await handleReflect(req, { writer: fakeWriter([]) });
    expect(res.status).toBe(400);
  });

  test("400 on missing assistant_turn", async () => {
    const req = new Request("http://x/api/familiar/reflect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    const res = await handleReflect(req, { writer: fakeWriter([]) });
    expect(res.status).toBe(400);
  });

  test("200 with decisions array on a valid call", async () => {
    const decisions: ReflectDecision[] = [
      { candidate: { fact: "x is y", source_span: [0, 6] }, status: "written" },
      { candidate: { fact: "I don't know", source_span: [10, 22] }, status: "gated", reason: "refusal_pattern" },
    ];
    const req = new Request("http://x/api/familiar/reflect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", assistant_turn: "x is y because z; I don't know" }),
    });
    const res = await handleReflect(req, { writer: fakeWriter(decisions) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toHaveLength(2);
    expect(body.summary.written).toBe(1);
    expect(body.summary.gated).toBe(1);
    expect(body.summary.duplicate).toBe(0);
  });

  test("400 on invalid JSON body", async () => {
    const req = new Request("http://x/api/familiar/reflect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ broken json",
    });
    const res = await handleReflect(req, { writer: fakeWriter([]) });
    expect(res.status).toBe(400);
  });
});
