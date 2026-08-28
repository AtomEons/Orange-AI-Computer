import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { assertPublicUrl, collectResearchEvidence } from "../research-capabilities.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("capability-backed research", () => {
  test("normalizes action-style research queries before provider search", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-query-"));
    dirs.push(outputDir);
    const observed = [];
    const adapter = async (query) => {
      observed.push(query);
      return [];
    };
    for (const [index, query] of ["research.system.gap.sweep", "research-system-gap-sweep", "research_system_gap_sweep"].entries()) {
      await collectResearchEvidence({ query, delegationId: `query-normalization-${index}`, budgetMs: 1_000 }, {
        outputDir,
        adapters: [adapter],
        fetchFn: async () => new Response("", { status: 404 }),
      });
    }
    expect(observed).toEqual(["research gap sweep", "research gap sweep", "research gap sweep"]);
  });

  test("refuses broad scouting when an order contains only workflow verbs and product names", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-generic-"));
    dirs.push(outputDir);
    let calls = 0;
    const adapter = async () => { calls++; return []; };
    const result = await collectResearchEvidence({ query: "analyze.launch OrangeFive orange5" }, {
      outputDir,
      adapters: [adapter],
    });
    expect(result.status).toBe("QUERY_TOO_GENERIC");
    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual([{ provider: "query", error: "research request has no domain-bearing terms" }]);
    expect(calls).toBe(0);
  });

  test("collects real-source shapes and writes a hashed evidence artifact", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const fetchFn = async (url) => {
      const href = String(url);
      if (href.includes("api.github.com")) return Response.json({ items: [{ id: 1, full_name: "lab/agent-evidence", html_url: "https://github.com/lab/agent-evidence", description: "Measured agent evidence workflow", updated_at: "2026-08-01T00:00:00Z", license: { spdx_id: "MIT" } }] });
      if (href.includes("huggingface.co/api/models")) return Response.json([{ id: "lab/agent-evidence-workflow", tags: ["agent", "evidence", "workflow"], downloads: 40, likes: 5, lastModified: "2026-08-02T00:00:00Z" }]);
      if (href.includes("export.arxiv.org")) return new Response(`<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2608.00001</id><updated>2026-08-03T00:00:00Z</updated><title>Evidence Agent</title><summary>Tests tools against receipts.</summary></entry></feed>`);
      if (href.includes("registry.npmjs.org")) return Response.json({ objects: [{ package: { name: "agent-evidence", version: "1.0.0", description: "Agent evidence workflow", date: "2026-08-04T00:00:00Z", license: "MIT", links: { npm: "https://www.npmjs.com/package/agent-evidence" } }, score: { final: 0.9 } }] });
      if (href.includes("hn.algolia.com")) return Response.json({ hits: [{ objectID: "42", title: "New evidence agent company", url: "https://evidence-agent.example/launch", points: 30, created_at: "2026-08-04T01:00:00Z" }] });
      if (href === "https://arxiv.org/abs/2608.00001") return new Response("primary paper bytes");
      if (href === "https://huggingface.co/lab/agent-evidence-workflow") return new Response("primary model card bytes");
      if (href === "https://www.npmjs.com/package/agent-evidence") return new Response("primary package bytes");
      throw new Error(`unexpected URL ${href}`);
    };
    const result = await collectResearchEvidence({ query: "agent evidence workflow", delegationId: "nav-test" }, { fetchFn, outputDir, now: () => new Date("2026-08-25T00:00:00Z") });
    expect(result.ok).toBe(true);
    expect(result.sourceCount).toBe(5);
    expect(result.evidenceRefs).toHaveLength(2);
    expect(result.evidenceRefs.every((ref) => ref.length <= 96)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    const artifact = JSON.parse(fs.readFileSync(result.artifactPath, "utf8"));
    expect(artifact.sources.map((source) => source.provider).sort()).toEqual(["arxiv", "github", "hackernews", "huggingface", "npm"]);
    expect(artifact.sources.every((source) => source.relevance.matched >= 2)).toBe(true);
    expect(artifact.sources.find((source) => source.provider === "hackernews").authorityTier).toBe("discovery_tip_unverified");
    expect(artifact.sources.find((source) => source.provider === "hackernews").lifecycle).toBe("SOURCE_VERIFICATION_REQUIRED");
    expect(artifact.sources.find((source) => source.provider === "arxiv").authorityTier).toBe("primary_research_source");
    expect(artifact.sources.filter((source) => ["huggingface", "npm"].includes(source.provider)).every((source) => source.authorityTier === "primary_registry_metadata")).toBe(true);
    expect(artifact.sources.find((source) => source.provider === "github").authorityTier).toBe("discovery_tip_unverified");
    expect(artifact.sources.every((source) => source.sourceQuality >= 0 && source.sourceQuality <= 1)).toBe(true);
    expect(artifact.sources.every((source) => source.observedAt === "2026-08-25T00:00:00.000Z")).toBe(true);
    const verified = artifact.sources.filter((source) => ["arxiv", "huggingface", "npm"].includes(source.provider));
    const discovery = artifact.sources.filter((source) => ["github", "hackernews"].includes(source.provider));
    expect(verified.every((source) => /^[a-f0-9]{64}$/.test(source.contentSha256))).toBe(true);
    expect(verified.every((source) => source.sourceVerified === true)).toBe(true);
    expect(discovery.every((source) => source.contentSha256 === null && source.sourceVerified === false)).toBe(true);
    expect(artifact.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sourceRecordSha256))).toBe(true);
    expect(verified.every((source) => source.contentHashScope === "immutable_source_response_bytes")).toBe(true);
    expect(verified.every((source) => source.immutableRef.endsWith(`#orange-evidence-sha256=${source.contentSha256}`))).toBe(true);
    expect(discovery.every((source) => source.contentHashScope === "unverified" && source.immutableRef === null)).toBe(true);
    expect(artifact.sha256).toBe(result.sha256);
  });

  test("writes an honest no-evidence artifact when all providers fail", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const result = await collectResearchEvidence({ query: "unavailable topic", delegationId: "nav-empty" }, {
      fetchFn: async () => new Response("down", { status: 503 }), outputDir,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("NO_EVIDENCE");
    expect(result.errors).toHaveLength(5);
    expect(fs.existsSync(result.artifactPath)).toBe(true);
  });

  test("topical fit outranks raw popularity and generic agent matches are rejected", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const fetchFn = async (url) => {
      const href = String(url);
      if (href.includes("api.github.com")) return Response.json({ items: [
        { id: 1, full_name: "popular/generic-agent", html_url: "https://github.com/popular/generic-agent", description: "A popular local agent system", stargazers_count: 900000, owner: { type: "Organization" } },
        { id: 2, full_name: "focused/memory-compression", html_url: "https://github.com/focused/memory-compression", description: "Agent memory compression runtime", stargazers_count: 100, owner: { type: "Organization" } },
      ] });
      if (href.includes("export.arxiv.org")) return new Response(`<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2608.00002</id><updated>2026-08-25T00:00:00Z</updated><title>Agent Memory Compression</title><summary>Agent memory compression with measured runtime recall.</summary></entry></feed>`);
      if (href.includes("huggingface.co/api/models")) return Response.json([]);
      if (href.includes("registry.npmjs.org")) return Response.json({ objects: [] });
      if (href.includes("hn.algolia.com")) return Response.json({ hits: [] });
      throw new Error(`unexpected URL ${href}`);
    };
    const result = await collectResearchEvidence({ query: "agent memory compression", delegationId: "fit-test", maxSources: 2 }, { fetchFn, outputDir });
    expect(result.sources.map((source) => source.title)).toEqual([
      "Agent Memory Compression",
      "focused/memory-compression",
    ]);
    expect(result.sources.some((source) => source.title === "popular/generic-agent")).toBe(false);
  });

  test("blocks local, metadata, credentialed, and non-http research targets", () => {
    for (const url of ["http://127.0.0.1/a", "http://192.168.1.2/a", "http://169.254.169.254/latest", "https://user:pass@example.com", "file:///secret"]) {
      expect(() => assertPublicUrl(url)).toThrow();
    }
    expect(assertPublicUrl("https://github.com/AtomEons").hostname).toBe("github.com");
  });

  test("returns at the hard budget when a provider ignores abort signals", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const stuck = () => new Promise(() => {});
    stuck.provider = "stuck-provider";
    const started = performance.now();
    const result = await collectResearchEvidence({ query: "bounded research provider", budgetMs: 1_000 }, {
      adapters: [stuck], outputDir,
    });
    expect(performance.now() - started).toBeLessThan(1_600);
    expect(result.status).toBe("NO_EVIDENCE");
    expect(result.errors).toEqual([{ provider: "research-budget", error: "research budget exhausted after 1000ms" }]);
  });

  test("keeps completed provider evidence when another provider exhausts the budget", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const fast = async () => [{
      provider: "github", sourceId: "bounded/research-provider", title: "bounded/research-provider",
      url: "https://github.com/bounded/research-provider", summary: "Bounded research provider evidence",
      updatedAt: "2026-08-25T00:00:00Z", ownerType: "Organization", stars: 40,
    }];
    fast.provider = "fast-provider";
    const stuck = () => new Promise(() => {});
    stuck.provider = "stuck-provider";
    const result = await collectResearchEvidence({ query: "bounded research provider", budgetMs: 1_000 }, {
      adapters: [fast, stuck], outputDir, now: () => new Date("2026-08-25T01:00:00Z"),
    });
    expect(result.status).toBe("EVIDENCE_COLLECTED");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe("bounded/research-provider");
    expect(result.errors.at(-1)).toEqual({ provider: "research-budget", error: "research budget exhausted after 1000ms" });
  });

  test("rejects a response body as soon as it exceeds the byte cap", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-research-"));
    dirs.push(outputDir);
    const result = await collectResearchEvidence({
      query: "inspect https://example.com/oversized",
      delegationId: "oversized-source",
    }, {
      adapters: [],
      outputDir,
      fetchFn: async () => new Response(new Uint8Array(1_000_001)),
    });
    expect(result.status).toBe("NO_EVIDENCE");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ provider: "direct", url: "https://example.com/oversized" });
    expect(result.errors[0].error).toContain("source exceeded 1000000 bytes");
  });
});
