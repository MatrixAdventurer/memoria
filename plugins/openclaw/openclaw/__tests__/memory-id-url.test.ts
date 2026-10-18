import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoriaHttpTransport } from "../http-client.js";
import { buildApiConfig } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const selectors = [
  "memory-123", "../memories/victim", "victim?mode=other", "victim#fragment",
  "nested/id", "literal%2Fid", "space id", "记忆😀",
];

describe("literal memory ID request targets", () => {
  for (const tool of ["memory_get", "memory_correct"]) {
    it.each(selectors)(`${tool} keeps %s in one path segment`, async (id) => {
      const requests: Request[] = [];
      vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
        // Native fetch constructs this same WHATWG Request before network I/O.
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ memory_id: id, content: "replacement" }));
      });
      const transport = new MemoriaHttpTransport(buildApiConfig(), "test-user");
      await transport.callTool(tool, {
        memory_id: id, new_content: "replacement", reason: "user correction",
      });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      const url = new URL(request.url);
      const suffix = tool === "memory_correct" ? "/correct" : "";
      expect(url.pathname).toBe(`/v1/memories/${encodeURIComponent(id)}${suffix}`);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(request.method).toBe(tool === "memory_correct" ? "PUT" : "GET");
      expect(request.headers.get("Authorization")).toBe("Bearer sk-test-key-123");
      expect(request.headers.has("X-User-Id")).toBe(false);
      if (tool === "memory_correct") {
        expect(await request.json()).toEqual({
          new_content: "replacement", reason: "user correction",
        });
      }
    });

    it.each([".", ".."])(`${tool} rejects dot-only selector %s before fetch`, async (id) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const transport = new MemoriaHttpTransport(buildApiConfig(), "test-user");
      await expect(transport.callTool(tool, { memory_id: id, new_content: "replacement" }))
        .rejects.toThrow(/memory_id/);
      expect(fetch).not.toHaveBeenCalled();
    });
  }
});
