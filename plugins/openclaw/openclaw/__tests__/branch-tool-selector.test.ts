import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import plugin from "../index.js";

type Tool = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

function registerTools(apiUrl: string): Tool[] {
  let toolFactory: ((ctx: Record<string, unknown>) => Tool[]) | undefined;
  plugin.register({
    pluginConfig: {
      backend: "api",
      apiUrl,
      apiKey: "test-key",
    },
    logger: { info() {}, warn() {} },
    on() {},
    registerTool(factory: typeof toolFactory) { toolFactory = factory; },
    registerCli() {},
    registerService() {},
  } as any);
  return toolFactory!({});
}

describe("public branch selector tools", () => {
  it.each([
    ["memory_checkout", "POST", " release ", "/v1/branches/%20release%20/checkout"],
    ["memory_branch_delete", "DELETE", " release ", "/v1/branches/%20release%20"],
    ["memory_checkout", "POST", "\trelease\n", "/v1/branches/%09release%0A/checkout"],
    ["memory_branch_delete", "DELETE", "\trelease\n", "/v1/branches/%09release%0A"],
    ["memory_checkout", "POST", "ordinary", "/v1/branches/ordinary/checkout"],
    ["memory_branch_delete", "DELETE", "ordinary", "/v1/branches/ordinary"],
  ])("preserves the exact %s %s selector %j as %s", async (toolName, method, name, expectedPath) => {
    const requests: Array<{ method: string; url: string }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method!, url: req.url! });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const tool = registerTools(apiUrl).find((candidate) => candidate.name === toolName)!;
      await tool.execute("call-1", { name });
      expect(requests).toEqual([{ method, url: expectedPath }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it.each(["memory_checkout", "memory_branch_delete"])(
    "rejects an empty %s selector before making a request",
    async (toolName) => {
      const tool = registerTools("http://127.0.0.1:1")
        .find((candidate) => candidate.name === toolName)!;
      await expect(tool.execute("call-1", { name: " \t\n " })).rejects.toThrow(/name required/i);
    },
  );
});
