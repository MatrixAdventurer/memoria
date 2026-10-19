import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoriaClient } from "../client.js";
import { MemoriaHttpTransport } from "../http-client.js";
import { buildApiConfig } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP batch purge selectors", () => {
  it.each([
    { memoryId: "m1,m2", ids: ["m1", "m2"] },
    { memoryId: " m1 , m2 ", ids: ["m1", "m2"] },
    { memoryId: ",m1,,m2,", ids: ["m1", "m2"] },
    { memoryId: "m1", ids: ["m1"] },
  ])("purgeMemory sends $memoryId as individual IDs", async ({ memoryId, ids }) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = await request.clone().json();
      // Model exact-ID matching at the HTTP boundary, not a live database.
      const matched = ["m1", "m2"].filter((id) => body.memory_ids.includes(id));
      return new Response(JSON.stringify({ purged: matched.length }));
    });
    const client = new MemoriaClient(buildApiConfig());
    try {
      const result = await client.purgeMemory({
        userId: "test-user", memoryId, reason: "remove selected memories",
      });
      expect(result.purged).toBe(ids.length);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://memoria.example.com/v1/memories/purge");
      expect(requests[0].method).toBe("POST");
      expect(requests[0].headers.get("Authorization")).toBe("Bearer sk-test-key-123");
      expect(await requests[0].json()).toEqual({
        memory_ids: ids, reason: "remove selected memories",
      });
    } finally {
      client.close();
    }
  });

  it("keeps topic deletion separate from ID parsing", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      bodies.push(await new Request(input, init).json());
      return new Response(JSON.stringify({ purged: 2 }));
    });
    const client = new MemoriaClient(buildApiConfig());
    try {
      const result = await client.purgeMemory({ userId: "u", topic: "old, notes" });
      expect(result.purged).toBe(2);
      expect(bodies).toEqual([{ topic: "old, notes" }]);
    } finally {
      client.close();
    }
  });

  it.each(["", "  ", ", ,", 123, true, ["m1"], { id: "m1" }].map((memoryId) => ({ memoryId })))(
    "rejects invalid ID selector $memoryId before it can become a topic purge",
    async ({ memoryId }) => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ purged: 1 })));
      vi.stubGlobal("fetch", fetch);
      const transport = new MemoriaHttpTransport(buildApiConfig(), "u");
      for (const topic of [undefined, "old"]) {
        await expect(transport.callTool("memory_purge", {
          memory_id: memoryId, topic,
        })).rejects.toThrow(/memory_id/);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the server rejection for mutually exclusive valid selectors", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      bodies.push(await new Request(input, init).json());
      return new Response("invalid purge selectors", { status: 422 });
    });
    const client = new MemoriaClient(buildApiConfig());
    try {
      await expect(client.purgeMemory({
        userId: "u", memoryId: "m1,m2", topic: "old",
      })).rejects.toThrow("returned 422");
      expect(bodies).toEqual([{
        memory_ids: ["m1", "m2"], topic: "old",
      }]);
    } finally {
      client.close();
    }
  });
});
