import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MemoriaClient } from "../client.js";
import { MemoriaHttpTransport } from "../http-client.js";
import { buildApiConfig } from "./helpers.js";

describe("branch identity over native HTTP", () => {
  it.each([
    { label: "array", payload: [{ name: "main", active: true }], expected: [{ name: "main", active: true }] },
    { label: "items", payload: { items: [{ name: "feature", active: true }] }, expected: [{ name: "feature", active: true }] },
    { label: "empty", payload: { branches: [] }, expected: [] },
    { label: "explicit false", payload: { branches: [{ name: "main", active: false }] }, expected: [{ name: "main", active: false }] },
    { label: "legacy text", payload: { result: "Branches:\n  main\n  feature ← active" }, expected: [{ name: "main", active: false }, { name: "feature", active: true }] },
  ])("handles $label without inventing branch state", async ({ payload, expected }) => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new MemoriaClient(buildApiConfig({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    try {
      expect(await client.branchList("fixture-user")).toEqual(expected);
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    { name: "release ← active", active: false },
    { name: "release\nmain ← active", active: false },
    { name: "  spaced branch  ", active: false },
    { name: "分支 😀\r\nnext", active: false },
    { name: "ordinary-branch", active: false },
    { name: "release ← active", active: true },
  ])("preserves the exact selector and active state for %j", async ({ name, active }) => {
    const branches = [{ name: "main", active: !active }, { name, active }];
    const requests: Array<{ method: string; url: string }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method!, url: req.url! });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? { branches } : { result: "Checked out" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = buildApiConfig({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const client = new MemoriaClient(config);
    try {
      const listed = await client.branchList("fixture-user");
      expect(listed).toEqual(branches);
      await client.branchCheckout({ userId: "fixture-user", name: listed[1].name });
      expect(requests).toEqual([
        { method: "GET", url: "/v1/branches" },
        { method: "POST", url: `/v1/branches/${encodeURIComponent(name)}/checkout` },
      ]);
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps the legacy text envelope while exposing authoritative structured state", async () => {
    const branches = [{ name: "main", active: false }, { name: "feature", active: true }];
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ branches, result: "legacy description" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = buildApiConfig({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    try {
      const transport = new MemoriaHttpTransport(config, "fixture-user");
      expect(await transport.callTool("memory_branches", {})).toMatchObject({
        content: [{ type: "text", text: "Branches:\n  main\n  feature ← active" }],
        structuredContent: { branches },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
