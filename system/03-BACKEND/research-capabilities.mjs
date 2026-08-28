import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "10-RECEIPTS", "orange5-build", "research-evidence");
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SOURCES = 6;
const DEFAULT_BUDGET_MS = 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVELOPE_FIELDS = ["payload", "input", "request", "body", "order", "data", "envelope"];
const QUERY_FIELDS = ["query", "intent", "task", "prompt", "summary", "reasoning", "content", "text", "description"];

export function extractResearchQuery(value) {
  return cleanEnvelopeText(extractEnvelopeValue(value, new Set(), 0)).slice(0, 2_000);
}

function extractEnvelopeValue(value, seen, depth) {
  if (value == null || depth > 8) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const userTurns = [...trimmed.matchAll(/<\|im_start\|>user\s*([\s\S]*?)(?:<\|im_end\|>|$)/gi)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    if (userTurns.length) return userTurns.map((turn) => extractEnvelopeValue(turn, seen, depth + 1)).filter(Boolean).join(" ");
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return extractEnvelopeValue(JSON.parse(trimmed), seen, depth + 1) || trimmed; } catch { /* keep source text */ }
    }
    return trimmed;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractEnvelopeValue(item, seen, depth + 1)).filter(Boolean).join(" ");
  }
  const queryParts = QUERY_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => extractEnvelopeValue(value[field], seen, depth + 1))
    .filter(Boolean);
  if (queryParts.length) return queryParts.join(" ");
  const envelopeParts = ENVELOPE_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => extractEnvelopeValue(value[field], seen, depth + 1))
    .filter(Boolean);
  return envelopeParts.join(" ");
}

function cleanEnvelopeText(value) {
  return String(value || "")
    .replace(/<\|im_(?:start|end)\|>/gi, " ")
    .replace(/\b(?:system|assistant)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function persistResearchArtifact(payload, outputDir) {
  const canonicalPayload = JSON.stringify(payload);
  const sha256 = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
  const artifactPath = path.join(outputDir, `${safeId(payload.delegationId)}.json`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify({ ...payload, sha256 }, null, 2)}\n`, "utf8");
  return {
    ok: Array.isArray(payload.sources) && payload.sources.length > 0,
    status: payload.status,
    query: payload.query,
    searchQuery: payload.searchQuery,
    sourceCount: payload.sources?.length || 0,
    sources: payload.sources || [],
    errors: payload.errors || [],
    budgetMs: payload.budgetMs ?? 0,
    elapsedMs: payload.elapsedMs ?? 0,
    sha256,
    artifactPath,
    evidenceRefs: [],
  };
}

export async function collectResearchEvidence(input = {}, deps = {}) {
  const startedAtMs = Date.now();
  const query = normalizeQuery(extractResearchQuery(input));
  const delegationId = safeId(input.delegationId || `research-${crypto.randomUUID()}`);
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const outputDir = path.resolve(deps.outputDir || DEFAULT_OUTPUT_DIR);
  const generatedAt = (deps.now || (() => new Date()))().toISOString();
  const searchQuery = compactSearchQuery(query);
  const sources = [];
  const errors = [];
  const budgetMs = boundedNumber(input.budgetMs, 1_000, 60_000, DEFAULT_BUDGET_MS);
  const maxSources = boundedNumber(input.maxSources, 1, 20, MAX_SOURCES);
  const controller = new AbortController();
  const deadlineFetch = (url, options = {}) => fetchFn(url, {
    ...options,
    signal: mergeSignals(options.signal, controller.signal),
  });
  const adapters = deps.adapters || [searchGitHub, searchHuggingFace, searchArxiv, searchNpm, searchHackerNews];
  if (!searchQuery && extractUrls(query).length === 0) {
    const artifact = {
      schema: "orange.research-evidence.v1",
      delegationId,
      query,
      searchQuery: "",
      generatedAt,
      elapsedMs: Date.now() - startedAtMs,
      status: "QUERY_TOO_GENERIC",
      sources: [],
      errors: [{ provider: "query", error: "research request has no domain-bearing terms" }],
    };
    return persistResearchArtifact(artifact, outputDir);
  }
  const tasks = adapters
    .map((adapter) => ({
      provider: adapter.provider || adapter.name || "research-provider",
      promise: Promise.resolve().then(() => adapter(searchQuery, deadlineFetch)),
    }));
  for (const url of extractUrls(query).slice(0, 2)) {
    tasks.push({ provider: "direct", url, promise: Promise.resolve().then(() => fetchDirectSource(url, deadlineFetch)).then((source) => [source]) });
  }
  const outcome = await settleWithinBudget(tasks.map((task) => task.promise), budgetMs, controller);
  outcome.settled.forEach((result, index) => {
    if (!result) return;
    const task = tasks[index];
    if (result.status === "fulfilled") sources.push(...result.value);
    else errors.push({ provider: task.provider, ...(task.url ? { url: task.url } : {}), error: result.reason?.message || String(result.reason) });
  });
  if (outcome.timedOut) errors.push({ provider: "research-budget", error: `research budget exhausted after ${budgetMs}ms` });

  const selected = dedupeSources(sources)
    .map((source) => {
      const authorityTier = authorityFor(source);
      const sourceRecordSha256 = sourceContentSha256(source);
      return {
        ...source,
        observedAt: generatedAt,
        sourceRecordSha256,
        authorityTier,
        sourceQuality: qualityFor(source, authorityTier),
        relevance: relevanceScore(source, searchQuery),
      };
    })
    .filter((source) => source.provider === "direct" || source.relevance.admitted)
    .sort((a, b) => Number(b.provider === "direct") - Number(a.provider === "direct")
      || researchRank(b) - researchRank(a)
      || b.relevance.score - a.relevance.score
      || b.sourceQuality - a.sourceQuality)
    .slice(0, maxSources);
  const remainingBudgetMs = Math.max(0, budgetMs - (Date.now() - startedAtMs));
  const verificationTasks = selected.map((source) => source.authorityTier === "discovery_tip_unverified"
    ? Promise.resolve(unverifiedSource("discovery source requires creator verification"))
    : verifyPrimarySource(source, deadlineFetch));
  const verification = remainingBudgetMs > 0
    ? await settleWithinBudget(verificationTasks, remainingBudgetMs, controller)
    : { timedOut: verificationTasks.length > 0, settled: [] };
  if (verification.timedOut && !errors.some((item) => item.provider === "research-budget")) {
    errors.push({ provider: "research-budget", error: `research budget exhausted after ${budgetMs}ms` });
  }
  const unique = selected.map((source, index) => {
    const result = verification.settled[index];
    const sourceVerification = result?.status === "fulfilled"
      ? result.value
      : unverifiedSource(result?.reason?.message || "source verification did not complete");
    if (result?.status === "rejected") {
      errors.push({ provider: `${source.provider}-source-verification`, url: source.url, error: result.reason?.message || String(result.reason) });
    }
    const verified = sourceVerification.bytesVerified === true && sourceVerification.timestampVerified === true;
    const contentSha256 = verified ? sourceVerification.bytesSha256 : null;
    return {
      ...source,
      updatedAt: sourceVerification.timestamp || source.updatedAt || null,
      contentSha256,
      contentHashScope: verified ? "immutable_source_response_bytes" : "unverified",
      immutableRef: verified ? `${sourceVerification.immutableUrl}#orange-evidence-sha256=${contentSha256}` : null,
      sourceVerified: verified,
      sourceBytesVerified: sourceVerification.bytesVerified === true,
      sourceTimestampVerified: sourceVerification.timestampVerified === true,
      sourceByteLength: sourceVerification.byteLength ?? null,
      sourceTimestampEvidence: sourceVerification.timestampEvidence || null,
      sourceVerificationStatus: verified ? "VERIFIED_PRIMARY_BYTES_AND_TIMESTAMP" : "SOURCE_VERIFICATION_REQUIRED",
      sourceVerificationError: verified ? null : sourceVerification.error,
      lifecycle: verified ? "BENCHMARK_REQUIRED" : "SOURCE_VERIFICATION_REQUIRED",
      promotionEligible: false,
    };
  });
  const payload = {
    schema: "orange.research-evidence.v1",
    delegationId,
    query,
    searchQuery,
    generatedAt,
    budgetMs,
    elapsedMs: Date.now() - startedAtMs,
    status: unique.length ? "EVIDENCE_COLLECTED" : "NO_EVIDENCE",
    sources: unique,
    errors,
  };
  const canonical = JSON.stringify(payload);
  const sha256 = crypto.createHash("sha256").update(canonical).digest("hex");
  const artifactPath = path.join(outputDir, `${delegationId}.json`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify({ ...payload, sha256 }, null, 2)}\n`, "utf8");

  return {
    ok: unique.length > 0,
    status: payload.status,
    query,
    searchQuery,
    sourceCount: unique.length,
    sources: unique,
    errors,
    budgetMs,
    elapsedMs: payload.elapsedMs,
    sha256,
    artifactPath,
    evidenceRefs: unique.slice(0, 2).map((source) => evidenceRef(source, sha256)),
  };
}

async function searchGitHub(query, fetchFn) {
  const terms = providerTerms(query, 6);
  const slices = [terms.slice(0, 2), terms.slice(2, 4)].filter((part) => part.length);
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const searches = slices.flatMap((part) => [
    { query: part.join(" "), sort: "stars" },
    { query: `${part.join(" ")} stars:>=5 pushed:>=${cutoff}`, sort: "updated" },
  ]);
  const bodies = await Promise.all(searches.map((spec) => fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(spec.query)}&sort=${spec.sort}&order=desc&per_page=5`, fetchFn, { accept: "application/vnd.github+json", "user-agent": "OrangeFive-Research/1.0" })));
  return bodies.flatMap((body) => Array.isArray(body.items) ? body.items : []).map((item) => ({
    provider: "github",
    sourceId: String(item.id || item.full_name || item.html_url),
    title: cleanText(item.full_name || item.name || "GitHub repository", 160),
    url: item.html_url,
    summary: cleanText(item.description || "No repository description supplied.", 500),
    updatedAt: item.updated_at || null,
    license: item.license?.spdx_id || null,
    stars: Number.isFinite(item.stargazers_count) ? item.stargazers_count : 0,
    forks: Number.isFinite(item.forks_count) ? item.forks_count : 0,
    ownerType: item.owner?.type || null,
    archived: item.archived === true,
  })).filter(validSource);
}
searchGitHub.provider = "github";

async function searchHuggingFace(query, fetchFn) {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(providerTerms(query, 4).join(" "))}&sort=trendingScore&direction=-1&limit=5&full=false`;
  const body = await fetchJson(url, fetchFn, { accept: "application/json", "user-agent": "OrangeFive-Research/1.0" });
  return (Array.isArray(body) ? body : []).map((item) => ({
    provider: "huggingface",
    sourceId: String(item.id || item.modelId),
    title: cleanText(item.id || item.modelId || "Hugging Face model", 160),
    url: `https://huggingface.co/${item.id || item.modelId}`,
    summary: cleanText((item.tags || []).slice(0, 12).join(", ") || "Model registry result.", 500),
    updatedAt: item.lastModified || null,
    downloads: Number.isFinite(item.downloads) ? item.downloads : null,
    likes: Number.isFinite(item.likes) ? item.likes : null,
  })).filter(validSource);
}
searchHuggingFace.provider = "huggingface";

async function searchArxiv(query, fetchFn) {
  const expression = providerTerms(query, 4).map((term) => `all:\"${term}\"`).join(" AND ");
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(expression)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url, fetchFn, { accept: "application/atom+xml", "user-agent": "OrangeFive-Research/1.0" });
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const sourceUrl = decodeXml(capture(entry, /<id>([\s\S]*?)<\/id>/));
    return {
      provider: "arxiv",
      sourceId: sourceUrl.split("/").pop() || sourceUrl,
      title: cleanText(decodeXml(capture(entry, /<title>([\s\S]*?)<\/title>/)), 160),
      url: sourceUrl,
      summary: cleanText(decodeXml(capture(entry, /<summary>([\s\S]*?)<\/summary>/)), 500),
      updatedAt: decodeXml(capture(entry, /<updated>([\s\S]*?)<\/updated>/)) || null,
      license: null,
    };
  }).filter(validSource);
}
searchArxiv.provider = "arxiv";

async function searchNpm(query, fetchFn) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(providerTerms(query, 4).join(" "))}&size=5`;
  const body = await fetchJson(url, fetchFn, { accept: "application/json", "user-agent": "OrangeFive-Research/1.0" });
  return (Array.isArray(body.objects) ? body.objects : []).map((row) => {
    const item = row.package || {};
    return {
      provider: "npm",
      sourceId: String(item.name || item.links?.npm || item.links?.repository),
      title: cleanText(item.name || "npm package", 160),
      url: item.links?.repository || item.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(item.name || "")}`,
      summary: cleanText(`${item.description || "No package description supplied."}${item.version ? ` Current version ${item.version}.` : ""}`, 500),
      updatedAt: item.date || null,
      version: item.version || null,
      license: item.license || null,
      score: row.score?.final ?? null,
    };
  }).filter(validSource);
}
searchNpm.provider = "npm";

async function searchHackerNews(query, fetchFn) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(providerTerms(query, 4).join(" "))}&tags=story&hitsPerPage=5`;
  const body = await fetchJson(url, fetchFn, { accept: "application/json", "user-agent": "OrangeFive-Research/1.0" });
  return (Array.isArray(body.hits) ? body.hits : []).map((item) => ({
    provider: "hackernews",
    sourceId: String(item.objectID || item.story_id || item.url),
    title: cleanText(item.title || item.story_title || "Technology discovery tip", 160),
    url: item.url || item.story_url,
    summary: cleanText(`Unverified discovery tip. Discussion points: ${Number(item.points) || 0}. Verify against the creator's official source before use.`, 500),
    updatedAt: item.created_at || null,
    points: Number.isFinite(item.points) ? item.points : null,
    license: null,
  })).filter(validSource);
}
searchHackerNews.provider = "hackernews";

async function fetchDirectSource(rawUrl, fetchFn) {
  const url = assertPublicUrl(rawUrl);
  const document = await fetchDocument(url.href, fetchFn, { accept: "text/html,application/json,text/plain", "user-agent": "OrangeFive-Research/1.0" });
  const text = document.text;
  const title = capture(text, /<title[^>]*>([\s\S]*?)<\/title>/i) || capture(text, /^#\s+(.+)$/m) || url.hostname;
  const timestamp = document.headers.get("last-modified") || findTimestamp(text);
  return {
    provider: "direct",
    sourceId: crypto.createHash("sha256").update(url.href).digest("hex").slice(0, 16),
    title: cleanText(stripMarkup(title), 160),
    url: url.href,
    summary: cleanText(stripMarkup(text), 500),
    contentSha256: document.sha256,
    contentHashScope: "immutable_source_response_bytes",
    sourceBytesVerified: true,
    sourceTimestampVerified: Number.isFinite(Date.parse(timestamp)),
    sourceByteLength: document.bytes.length,
    sourceTimestampEvidence: document.headers.get("last-modified") ? "http-last-modified" : "source-body",
    updatedAt: Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null,
    license: null,
  };
}

async function verifyPrimarySource(source, fetchFn) {
  if (source.sourceBytesVerified === true && source.sourceTimestampVerified === true && SHA256_PATTERN.test(String(source.contentSha256 || ""))) {
    return {
      bytesVerified: true,
      timestampVerified: true,
      bytesSha256: source.contentSha256,
      byteLength: source.sourceByteLength ?? null,
      timestamp: source.updatedAt,
      timestampEvidence: source.sourceTimestampEvidence || "source-body",
      immutableUrl: source.url,
      error: null,
    };
  }
  try {
    const document = await fetchDocument(source.url, fetchFn, { accept: "application/json,text/html,text/plain,application/atom+xml", "user-agent": "OrangeFive-Research/1.0" });
    const timestamp = source.updatedAt || document.headers.get("last-modified") || findTimestamp(document.text);
    const timestampVerified = Number.isFinite(Date.parse(timestamp));
    return {
      bytesVerified: true,
      timestampVerified,
      bytesSha256: document.sha256,
      byteLength: document.bytes.length,
      timestamp: timestampVerified ? new Date(timestamp).toISOString() : null,
      timestampEvidence: source.updatedAt ? "primary-registry-record" : document.headers.get("last-modified") ? "http-last-modified" : "source-body",
      immutableUrl: source.url,
      error: timestampVerified ? null : "primary source has no verifiable timestamp",
    };
  } catch (error) {
    return unverifiedSource(error?.message || String(error));
  }
}

function unverifiedSource(error) {
  return { bytesVerified: false, timestampVerified: false, bytesSha256: null, byteLength: null, timestamp: null, timestampEvidence: null, immutableUrl: null, error };
}

async function fetchJson(url, fetchFn, headers) {
  const text = await fetchText(url, fetchFn, headers);
  try { return JSON.parse(text); } catch { throw new Error("source returned invalid JSON"); }
}

async function fetchText(rawUrl, fetchFn, headers = {}) {
  return (await fetchDocument(rawUrl, fetchFn, headers)).text;
}

async function fetchDocument(rawUrl, fetchFn, headers = {}) {
  const url = assertPublicUrl(rawUrl);
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response?.ok) throw new Error(`source returned HTTP ${response?.status || 0}`);
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`source exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`source exceeded ${MAX_RESPONSE_BYTES} bytes`);
    return documentRecord(buffer, response.headers);
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      void reader.cancel(`source exceeded ${MAX_RESPONSE_BYTES} bytes`).catch(() => {});
      throw new Error(`source exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return documentRecord(Buffer.concat(chunks, bytes), response.headers);
}

function documentRecord(bytes, headers) {
  return { bytes, text: bytes.toString("utf8"), headers, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

async function settleWithinBudget(promises, budgetMs, controller) {
  let deadline;
  const settled = new Array(promises.length);
  const tracked = promises.map((promise, index) => Promise.resolve(promise).then(
    (value) => { settled[index] = { status: "fulfilled", value }; },
    (reason) => { settled[index] = { status: "rejected", reason }; },
  ));
  const completed = Promise.all(tracked).then(() => ({ timedOut: false, settled }));
  const exhausted = new Promise((resolve) => {
    deadline = setTimeout(() => {
      controller.abort(new Error(`research budget exhausted after ${budgetMs}ms`));
      resolve({ timedOut: true, settled });
    }, budgetMs);
  });
  try {
    return await Promise.race([completed, exhausted]);
  } finally {
    clearTimeout(deadline);
  }
}

function mergeSignals(a, b) {
  const signals = [a, b].filter(Boolean);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  return b;
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function assertPublicUrl(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("only HTTP(S) research sources are allowed");
  if (url.username || url.password) throw new Error("credentialed research URLs are forbidden");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local research targets are forbidden");
  if (host === "169.254.169.254" || host === "metadata.google.internal") throw new Error("metadata targets are forbidden");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("private-network research targets are forbidden");
  return url;
}

function isPrivateIp(host) {
  if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  const parts = host.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0 || parts[0] >= 224;
}

function normalizeQuery(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("research query must be non-empty text");
  return value.trim().slice(0, 2_000);
}

function compactSearchQuery(query) {
  const stop = new Set(["about", "after", "against", "analyze", "analysis", "assistant", "audit", "build", "check", "create", "current", "deploy", "emit", "from", "implement", "inspect", "into", "json", "launch", "latest", "matching", "model", "models", "new", "newest", "object", "only", "open", "orange", "orange5", "orangefive", "project", "release", "review", "schema", "source", "start", "status", "system", "that", "their", "these", "this", "through", "today", "tool", "tools", "update", "user", "using", "what", "when", "where", "which", "with"]);
  const words = query.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[._-]+/g, " ")
    .match(/[a-z0-9][a-z0-9+]*/g) || [];
  const selected = [...new Set(words.filter((word) => word.length > 2 && !stop.has(word) && !/^20\d\d$/.test(word)))].slice(0, 8);
  return selected.join(" ").slice(0, 160);
}

function providerTerms(query, max = 4) {
  return query.split(/\s+/).filter(Boolean).slice(0, max);
}

function relevanceScore(source, query) {
  const terms = providerTerms(query, 8).map(stem).filter((term) => term.length >= 4);
  const haystack = stem(`${source.title || ""} ${source.summary || ""} ${source.url || ""}`.toLowerCase());
  const matchedTerms = [...new Set(terms.filter((term) => haystack.includes(term)))];
  const generic = new Set(["agent", "analyz", "audit", "build", "check", "creat", "deploy", "implement", "inspect", "launch", "local", "open", "project", "releas", "review", "runtime", "status", "system", "model", "intelligence", "updat"]);
  const distinctiveTerms = terms.filter((term) => !generic.has(term));
  const matchedDistinctive = matchedTerms.filter((term) => !generic.has(term));
  const coverage = terms.length ? matchedTerms.length / terms.length : 0;
  const distinctiveCoverage = distinctiveTerms.length ? matchedDistinctive.length / distinctiveTerms.length : coverage;
  const score = coverage * 0.45 + distinctiveCoverage * 0.55;
  return {
    score: Number(score.toFixed(4)),
    matched: matchedTerms.length,
    queryTerms: terms.length,
    terms: matchedTerms,
    distinctiveMatched: matchedDistinctive.length,
    distinctiveTerms: distinctiveTerms.length,
    admitted: matchedTerms.length >= Math.min(2, terms.length)
      && (distinctiveTerms.length === 0 || matchedDistinctive.length >= 1),
  };
}

function researchRank(source) {
  return (source.relevance?.score || 0) * 0.7 + (source.sourceQuality || 0) * 0.3;
}

function authorityFor(source) {
  if (source.provider === "direct") return "operator_seeded_primary";
  if (source.provider === "arxiv") return "primary_research_source";
  if (source.provider === "npm" || source.provider === "huggingface") return "primary_registry_metadata";
  if (source.provider === "github" && !source.archived && (source.ownerType === "Organization" || Number(source.stars) >= 25)) {
    return "creator_registry_source";
  }
  return "discovery_tip_unverified";
}

function qualityFor(source, authorityTier) {
  const authority = {
    operator_seeded_primary: 1,
    primary_research_source: 0.95,
    creator_registry_source: 0.85,
    primary_registry_metadata: 0.8,
    discovery_tip_unverified: 0.2,
  }[authorityTier] ?? 0.2;
  const popularityRaw = Number(source.stars ?? source.downloads ?? source.likes ?? source.points ?? 0);
  const popularity = Math.min(1, Math.log10(1 + Math.max(0, popularityRaw)) / 5);
  return Number(Math.min(1, authority * 0.9 + popularity * 0.1).toFixed(4));
}

function stem(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/(ations?|ments?|ness|ing|ers?|ed|s)\b/g, "").replace(/\s+/g, " ").trim();
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s<>{}"']+/gi)].map((match) => match[0].replace(/[),.;]+$/, ""));
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!validSource(source)) return false;
    const key = source.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validSource(source) {
  try { assertPublicUrl(source?.url); } catch { return false; }
  return Boolean(source?.title && source?.provider);
}

function evidenceRef(source, artifactSha) {
  const sourceSha = crypto.createHash("sha256").update(source.url).digest("hex").slice(0, 12);
  return `source:${source.provider}:${sourceSha}:artifact:${artifactSha.slice(0, 12)}`;
}

function sourceContentSha256(source) {
  const observed = {
    provider: source.provider || null,
    sourceId: source.sourceId || null,
    title: source.title || null,
    url: source.url || null,
    summary: source.summary || null,
    updatedAt: source.updatedAt || null,
    version: source.version || null,
    license: source.license || null,
  };
  return crypto.createHash("sha256").update(canonical(observed)).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function capture(text, pattern) { return String(text || "").match(pattern)?.[1]?.trim() || ""; }
function decodeXml(text) { return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function stripMarkup(text) { return String(text || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "); }
function cleanText(text, max) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, max); }
function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160); }
