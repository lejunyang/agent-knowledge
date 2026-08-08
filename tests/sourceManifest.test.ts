import { describe, expect, it } from "vitest";
import {
  buildSourceManifest,
  classifySourceUpdate,
  compareSourceVersionProbe,
  decideSourceRefresh,
  sourceSectionId,
  sourceVersionFingerprint
} from "../src/storage/sourceManifest.js";

const observedAt = "2026-08-09T00:00:00.000Z";

describe("source manifests", () => {
  it("creates stable heading-aware sections and records upstream versions", () => {
    const content = [
      "<title>账号指南</title>",
      "<h1>登录态</h1>",
      "<h2>账号组</h2>",
      "<p>商业化 UID 与抖音 UID 属于不同账号组。</p>",
      "<h2>OAuth</h2>",
      "<p>两者通过授权关系建立绑定。</p>"
    ].join("");
    const manifest = buildSourceManifest({
      sourceId: "src_account_guide",
      connector: "lark",
      externalKey: "wiki:account",
      title: "账号指南",
      content,
      observedAt,
      upstreamVersion: {
        revision: "2461",
        updated_at: "2026-08-08T12:00:00.000Z"
      }
    });

    expect(manifest.sections).toHaveLength(3);
    expect(manifest.sections[1]?.heading_path).toEqual([
      "登录态",
      "账号组"
    ]);
    expect(manifest.sections[1]?.section_id).toBe(
      sourceSectionId(
        "src_account_guide",
        ["登录态", "账号组"],
        "商业化 UID 与抖音 UID 属于不同账号组。"
      )
    );
    expect(manifest.version.upstream.revision).toBe("2461");
    expect(manifest.version.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.version.fingerprint).toBe(
      sourceVersionFingerprint({
        upstream: manifest.version.upstream,
        contentHash: manifest.version.content_hash
      })
    );
  });

  it("uses a whole-document fallback when the source has no headings", () => {
    const manifest = buildSourceManifest({
      sourceId: "src_plain",
      connector: "file",
      externalKey: "file:plain",
      title: "Plain",
      content: "<p>Only body text.</p>",
      observedAt
    });

    expect(manifest.sections).toHaveLength(1);
    expect(manifest.sections[0]?.heading_path).toEqual(["正文"]);
    expect(manifest.sections[0]?.preview).toBe("Only body text.");
  });

  it("skips content fetch when a shared upstream version signal is unchanged", () => {
    const previous = buildSourceManifest({
      sourceId: "src_lark",
      connector: "lark",
      externalKey: "wiki:lark",
      title: "Lark",
      content: "<p>v1</p>",
      observedAt,
      upstreamVersion: { revision: "17" }
    });

    expect(
      compareSourceVersionProbe(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: { revision: "17" }
      })
    ).toBe("unchanged");
    expect(
      compareSourceVersionProbe(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: { revision: "18" }
      })
    ).toBe("changed");
    expect(
      decideSourceRefresh(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: { revision: "17" }
      })
    ).toEqual({
      action: "skip",
      comparison: "unchanged",
      reason: "upstream_version_unchanged"
    });
    expect(
      decideSourceRefresh(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: {}
      })
    ).toEqual({
      action: "fetch",
      comparison: "unknown",
      reason: "upstream_version_unavailable"
    });
  });

  it("compares Git commit SHA case-insensitively and falls back when no signal overlaps", () => {
    const previous = buildSourceManifest({
      sourceId: "src_git",
      connector: "github",
      externalKey: "github.com/example/repo",
      title: "Repository",
      content: "README",
      observedAt,
      upstreamVersion: { commit_sha: "ABCDEF1234567" }
    });

    expect(
      compareSourceVersionProbe(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: { commit_sha: "abcdef1234567" }
      })
    ).toBe("unchanged");
    expect(
      compareSourceVersionProbe(previous.version, {
        observed_at: "2026-08-10T00:00:00.000Z",
        upstream: { etag: "\"new\"" }
      })
    ).toBe("unknown");
  });

  it("distinguishes metadata-only updates from content changes", () => {
    const previous = buildSourceManifest({
      sourceId: "src_lark",
      connector: "lark",
      externalKey: "wiki:lark",
      title: "Lark",
      content: "<p>same body</p>",
      observedAt,
      upstreamVersion: { revision: "17" }
    });
    const metadataOnly = buildSourceManifest({
      sourceId: "src_lark",
      connector: "lark",
      externalKey: "wiki:lark",
      title: "Lark",
      content: "<p>same body</p>",
      observedAt: "2026-08-10T00:00:00.000Z",
      upstreamVersion: { revision: "18" }
    });
    const changed = buildSourceManifest({
      sourceId: "src_lark",
      connector: "lark",
      externalKey: "wiki:lark",
      title: "Lark",
      content: "<p>changed body</p>",
      observedAt: "2026-08-10T00:00:00.000Z",
      upstreamVersion: { revision: "18" }
    });

    expect(classifySourceUpdate(null, previous)).toBe("new");
    expect(classifySourceUpdate(previous, previous)).toBe("unchanged");
    expect(classifySourceUpdate(previous, metadataOnly)).toBe("metadata_only");
    expect(classifySourceUpdate(previous, changed)).toBe("content_changed");
  });
});
