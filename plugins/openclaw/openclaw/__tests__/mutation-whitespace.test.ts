import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MemoriaClient } from "../client.js";
import { buildApiConfig } from "./helpers.js";

describe.each(["store", "correctById", "correctByQuery"] as const)(
  "%s preserves response content",
  (operation) => {
    it.each([
      { label: "Python indentation", content: "    return value\n" },
      { label: "tabs and Unicode", content: "\n\t记忆 😀\r\n  " },
      { label: "trailing whitespace", content: "end  \t" },
      { label: "leading newline", content: "\r\nfirst\nsecond" },
      { label: "plain control", content: "ordinary text" },
    ])("keeps $label in the result and cache", async ({ content }) => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      // A real loopback HTTP fixture, not a live Memoria database. The response
      // deliberately differs from the request to prove we preserve server data.
      const record = { memory_id: "result-id", content, memory_type: "semantic" };
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push({
          method: request.method!, url: request.url!, body: body ? JSON.parse(body) : null,
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(record));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const config = buildApiConfig({
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      const client = new MemoriaClient(config);
      const freshClient = new MemoriaClient(config);
      try {
        const requestContent = "request content";
        const result = operation === "store"
          ? await client.storeMemory({ userId: "u", content: requestContent, memoryType: "semantic" })
          : operation === "correctById"
            ? await client.correctById({ userId: "u", memoryId: "old-id", newContent: requestContent })
            : await client.correctByQuery({ userId: "u", query: "old", newContent: requestContent });
        expect(requests).toEqual([operation === "store"
          ? { method: "POST", url: "/v1/memories", body: { content: requestContent, memory_type: "semantic" } }
          : {
            method: operation === "correctById" ? "PUT" : "POST",
            url: operation === "correctById" ? "/v1/memories/old-id/correct" : "/v1/memories/correct",
            body: operation === "correctById"
              ? { new_content: requestContent }
              : { query: "old", new_content: requestContent },
          }]);
        const cached = await client.getMemory({ userId: "u", memoryId: "result-id" });
        expect(requests).toHaveLength(1); // The actual client cache was exercised.
        const fetched = await freshClient.getMemory({ userId: "u", memoryId: "result-id" });
        expect(requests[1]).toEqual({ method: "GET", url: "/v1/memories/result-id", body: null });
        expect(fetched?.content).toBe(content);
        expect(result).toMatchObject({ memory_id: "result-id", content });
        expect(cached?.content).toBe(fetched?.content);
      } finally {
        client.close();
        freshClient.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    });
  },
);
