import { describe, expect, it, vi } from "vitest";
import { WebDavSyncBackend } from "../src/sync/webdav.js";

describe("WebDavSyncBackend", () => {
  it("uses bounded HTTP operations and basic auth without exposing credentials in URLs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 201 }))
      .mockResolvedValueOnce(new Response("", { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const backend = new WebDavSyncBackend({
      baseUrl: "https://dav.example.com/memory",
      username: "alice",
      password: "secret",
      fetch: fetchMock
    });

    expect(await backend.readManifest()).toBeNull();
    await backend.writeFile("knowledge/semantic/a.md", "# a\n");
    await backend.writeManifest({ version: 1, generation: 1, updatedAt: "now", entries: {} });
    await backend.deleteFile("knowledge/semantic/a.md");

    const calls = fetchMock.mock.calls;
    expect(calls[0]?.[0].toString()).toBe("https://dav.example.com/memory/.agent-knowledge-manifest.json");
    expect(calls.every(([url]) => !url.toString().includes("secret"))).toBe(true);
    expect(new Headers(calls[1]?.[1]?.headers).get("authorization")).toMatch(/^Basic /);
    expect(calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT", "PUT", "DELETE"]);
  });
});
