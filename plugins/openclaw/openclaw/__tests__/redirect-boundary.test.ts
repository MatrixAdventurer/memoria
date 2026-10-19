import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoriaHttpTransport } from "../http-client.js";
import { buildApiConfig } from "./helpers.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }));
});

describe("configured API redirect boundary (real HTTP)", () => {
  it.each([301, 302, 303, 307, 308])(
    "does not forward memory content through a cross-origin %i redirect",
    async (status) => {
      const forwarded: string[] = [];
      const destination = await listen(createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        forwarded.push(body);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ memory_id: "unexpected", content: "forwarded" }));
      }));
      const origin = await listen(createServer((_request, response) => {
        response.writeHead(status, { Location: `${destination}/unexpected` });
        response.end();
      }));
      const transport = new MemoriaHttpTransport(buildApiConfig({ apiUrl: origin }), "u");
      const rejected = await transport.callTool("memory_store", {
        content: "private regression fixture",
      }).then(() => false, () => true);

      expect(forwarded, "the redirect target must receive no request").toEqual([]);
      expect(rejected, "a redirect must not be reported as a successful write").toBe(true);
    },
  );

  it("also rejects same-origin redirects instead of rewriting a mutation", async () => {
    const paths: string[] = [];
    const origin = await listen(createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      if (request.url === "/v1/memories") {
        response.writeHead(302, { Location: "/other" });
      } else {
        response.setHeader("Content-Type", "application/json");
      }
      response.end("{}");
    }));
    const transport = new MemoriaHttpTransport(buildApiConfig({ apiUrl: origin }), "u");
    await expect(transport.callTool("memory_store", { content: "fixture" })).rejects.toThrow();
    expect(paths).toEqual(["POST /v1/memories"]);
  });

  it("preserves a direct successful request and its credentials", async () => {
    const requests: Array<{ authorization?: string; body: string }> = [];
    const origin = await listen(createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ authorization: request.headers.authorization, body });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ memory_id: "direct", content: "fixture" }));
    }));
    const transport = new MemoriaHttpTransport(buildApiConfig({ apiUrl: origin }), "u");
    await expect(transport.callTool("memory_store", { content: "fixture" })).resolves.toEqual({
      content: [{ type: "text", text: "Stored memory direct: fixture" }],
    });
    expect(requests).toEqual([{
      authorization: "Bearer sk-test-key-123",
      body: JSON.stringify({ content: "fixture" }),
    }]);
  });
});
