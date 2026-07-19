import { describe, expect, it, vi } from "vitest";
import { S3HttpObjectClient, S3SyncBackend, type S3ObjectClient } from "../src/sync/s3.js";

class FakeS3Client implements S3ObjectClient {
  objects = new Map<string, string>();

  async getObject(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  async putObject(key: string, content: string): Promise<void> {
    this.objects.set(key, content);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe("S3SyncBackend", () => {
  it("maps manifests and Markdown files under a configured prefix", async () => {
    const client = new FakeS3Client();
    const backend = new S3SyncBackend({ client, prefix: "team-memory/" });
    const manifest = { version: 1 as const, generation: 1, updatedAt: "now", entries: {} };

    await backend.writeFile("knowledge/semantic/a.md", "# a\n");
    await backend.writeManifest(manifest);

    expect(client.objects.get("team-memory/knowledge/semantic/a.md")).toBe("# a\n");
    expect(client.objects.get("team-memory/.agent-knowledge-manifest.json")).toContain('"generation": 1');
    await expect(backend.readFile("knowledge/semantic/a.md")).resolves.toBe("# a\n");
    await expect(backend.readManifest()).resolves.toEqual(manifest);
  });

  it("signs S3-compatible HTTP requests with SigV4 and keeps credentials out of URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
    const client = new S3HttpObjectClient({
      bucket: "knowledge",
      region: "us-east-1",
      endpoint: "https://s3.example.com",
      accessKeyId: "ACCESS",
      secretAccessKey: "SECRET",
      sessionToken: "SESSION",
      fetch: fetchMock
    });

    await client.putObject("knowledge/semantic/a.md", "# a\n");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe("https://s3.example.com/knowledge/knowledge/semantic/a.md");
    expect(url.toString()).not.toContain("SECRET");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ACCESS\/\d{8}\/us-east-1\/s3\/aws4_request/
    );
    expect(headers.get("x-amz-security-token")).toBe("SESSION");
  });
});
