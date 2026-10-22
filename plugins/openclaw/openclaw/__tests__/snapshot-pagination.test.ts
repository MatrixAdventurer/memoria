import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoriaClient } from "../client.js";
import { MemoriaHttpTransport } from "../http-client.js";
import { buildApiConfig } from "./helpers.js";

const servers: Server[] = [];

async function serveSnapshots(total: number, mode = "normal") {
  const offsets: number[] = [];
  const countResolution: (string | null)[] = [];
  const snapshots = Array.from({ length: total }, (_, i) => ({
    name: `release_${i}`, snapshot_name: `mem_snap_release_${i}`,
    timestamp: "2026-10-21T00:00:00Z",
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/v1/memories") {
      response.end(JSON.stringify({ items: [], next_cursor: null }));
      return;
    }
    if (url.pathname === "/v1/branches") {
      response.end(JSON.stringify({ branches: [{ name: "main", active: true }] }));
      return;
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    offsets.push(offset);
    countResolution.push(url.searchParams.get("resolve_memory_counts"));
    if (mode === "fail-later" && offset > 0) {
      response.writeHead(503);
      response.end("unavailable");
      return;
    }
    const items = mode === "empty-more" ? [] : snapshots.slice(offset, offset + limit);
    response.end(JSON.stringify({
      snapshots: items, total, offset, limit,
      has_more: mode === "empty-more" || offset + items.length < total,
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    offsets, snapshots, countResolution,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }));
});

describe("snapshot discovery pagination (real HTTP)", () => {
  it("lists snapshots beyond the first 20 and counts them in stats", async () => {
    const fixture = await serveSnapshots(45);
    const client = new MemoriaClient(buildApiConfig({ apiUrl: fixture.apiUrl }));
    try {
      expect((await client.listSnapshots("u")).map((s) => s.name))
        .toEqual(fixture.snapshots.map((s) => s.name));
      expect(fixture.offsets).toEqual([0, 20, 40]);
      expect((await client.stats("u")).snapshotCount).toBe(45);
      // Both discovery and stats need metadata, not per-snapshot historical counts.
      expect(fixture.countResolution).toEqual(Array(6).fill("false"));
    } finally {
      client.close();
    }
  });

  it("rejects a truncated scan rather than returning a false complete count", async () => {
    const fixture = await serveSnapshots(21);
    const client = new MemoriaClient(buildApiConfig({ apiUrl: fixture.apiUrl, maxListPages: 1 }));
    try {
      await expect(client.listSnapshots("u")).rejects.toThrow(/maxListPages/);
      const stats = await client.stats("u");
      expect(stats.snapshotCount).toBeNull();
      expect(stats.limitations?.join(" ")).toMatch(/Snapshot statistics unavailable/);
      expect(fixture.offsets).toEqual([0, 0]);
    } finally {
      client.close();
    }
  });

  it("fails without looping when an empty page claims more snapshots", async () => {
    const fixture = await serveSnapshots(21, "empty-more");
    const client = new MemoriaClient(buildApiConfig({ apiUrl: fixture.apiUrl }));
    try {
      await expect(client.listSnapshots("u")).rejects.toThrow(/empty.*page/i);
      expect(fixture.offsets).toEqual([0]);
    } finally {
      client.close();
    }
  });

  it("propagates a later-page HTTP error instead of returning the first page", async () => {
    const fixture = await serveSnapshots(21, "fail-later");
    const client = new MemoriaClient(buildApiConfig({ apiUrl: fixture.apiUrl }));
    try {
      await expect(client.listSnapshots("u")).rejects.toThrow(/503/);
      expect(fixture.offsets).toEqual([0, 20]);
    } finally {
      client.close();
    }
  });

  it("retains explicit low-level page selection", async () => {
    const fixture = await serveSnapshots(45);
    const transport = new MemoriaHttpTransport(buildApiConfig({ apiUrl: fixture.apiUrl }), "u");
    const result = await transport.callTool("memory_snapshots", { limit: 2, offset: 20 });
    expect(JSON.stringify(result)).toContain("release_20");
    expect(JSON.stringify(result)).not.toContain("release_22");
    expect(fixture.offsets).toEqual([20]);
    expect(fixture.countResolution).toEqual([null]);
  });
});
