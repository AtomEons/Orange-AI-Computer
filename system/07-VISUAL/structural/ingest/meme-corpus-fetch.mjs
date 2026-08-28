// meme-corpus-fetch.mjs
// Fetch top 100 imgflip templates + up to 5 real user variants for the top 30.
// Free, no-auth. Bun only. Absolute paths.

import { mkdir, writeFile, appendFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const CORPUS_ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/meme-corpus";
const LOG_PATH = join(tmpdir(), "orange-ai-computer", "meme-fetch.log");
const IMGFLIP_API = "https://api.imgflip.com/get_memes";
const TOP_N_FOR_VARIANTS = 30;
const VARIANTS_PER_TEMPLATE = 5;
const UA = "Mozilla/5.0 (compatible; AEyes1-corpus-builder/1.0)";

async function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}\n`;
  process.stdout.write(msg);
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, msg);
  } catch {}
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "meme";
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function fileExistsNonEmpty(p) {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch { return false; }
}

async function downloadBinary(url, destPath) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 200) throw new Error(`suspiciously small (${buf.length}B): ${url}`);
  await ensureDir(dirname(destPath));
  await writeFile(destPath, buf);
  return buf.length;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// Extract /i/<hash> variant-page identifiers from a meme index page.
// Each hash corresponds to a user-created variant.
function extractVariantHashesFromMemePage(html) {
  const hashes = new Set();
  const re = /\/i\/([a-z0-9]{4,12})(?=[^a-z0-9]|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null) hashes.add(m[1]);
  return [...hashes];
}

// Given the /i/<hash> page HTML, pull the primary image URL. Prefer og:image
// meta tag; fallback to first i.imgflip.com/<hash>.(jpg|png) match.
function extractImageUrlFromVariantPage(html, hash) {
  // og:image tag
  const og = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (og && og[1] && /i\.imgflip\.com/.test(og[1])) return og[1];
  // fallback: first image URL that matches the hash
  const specific = new RegExp(`https?://i\\.imgflip\\.com/${hash}\\.(jpg|jpeg|png)`, "i");
  const s = html.match(specific);
  if (s) return s[0];
  // last resort: first i.imgflip.com/<hash>.jpg on the page
  const any = html.match(/https?:\/\/i\.imgflip\.com\/([a-z0-9]+)\.(jpg|jpeg|png)/i);
  if (any) return any[0];
  return null;
}

async function main() {
  await ensureDir(dirname(LOG_PATH));
  await writeFile(LOG_PATH, ""); // reset log
  await log(`START meme-corpus-fetch — CORPUS_ROOT=${CORPUS_ROOT}`);
  await ensureDir(CORPUS_ROOT);

  // 1) Fetch imgflip index
  await log(`GET ${IMGFLIP_API}`);
  const apiRes = await fetch(IMGFLIP_API, { headers: { "User-Agent": UA } });
  if (!apiRes.ok) {
    await log(`FATAL imgflip API HTTP ${apiRes.status}`);
    process.exit(1);
  }
  const apiJson = await apiRes.json();
  if (!apiJson || !apiJson.success || !apiJson.data || !Array.isArray(apiJson.data.memes)) {
    await log(`FATAL imgflip API bad shape`);
    process.exit(1);
  }
  const memes = apiJson.data.memes;
  await log(`imgflip returned ${memes.length} templates`);

  // Sort by captions desc (proxy for popularity). If missing, fallback to given order.
  const ranked = memes.slice().sort((a, b) => (b.captions || 0) - (a.captions || 0));

  const summary = [];
  let templatesFetched = 0;
  let totalFiles = 0;
  let templatesWith5Variants = 0;
  const noVariantList = [];
  const partialVariantList = [];

  // 2) For each template: download the canonical image; for top N: scrape 5 variants
  for (let i = 0; i < ranked.length; i++) {
    const m = ranked[i];
    const slug = slugify(m.name);
    const conceptDir = join(CORPUS_ROOT, slug);
    await ensureDir(conceptDir);

    const templatePath = join(conceptDir, "template.jpg");
    let templateBytes = 0;
    try {
      if (await fileExistsNonEmpty(templatePath)) {
        const s = await stat(templatePath); templateBytes = s.size;
        await log(`[${i+1}/${ranked.length}] template cached: ${slug} (${templateBytes}B)`);
      } else {
        templateBytes = await downloadBinary(m.url, templatePath);
        await log(`[${i+1}/${ranked.length}] template OK: ${slug} (${templateBytes}B) from ${m.url}`);
      }
      templatesFetched++;
      totalFiles++;
    } catch (e) {
      await log(`[${i+1}/${ranked.length}] template FAIL: ${slug} — ${e.message}`);
      continue;
    }

    // Write metadata for this template
    const meta = {
      slug,
      imgflip_id: m.id,
      name: m.name,
      canonical_url: m.url,
      width: m.width,
      height: m.height,
      box_count: m.box_count,
      captions: m.captions,
      rank_by_captions: i + 1,
    };
    await writeFile(join(conceptDir, "meta.json"), JSON.stringify(meta, null, 2));

    // Variants only for top N
    if (i < TOP_N_FOR_VARIANTS) {
      let variantsSaved = 0;
      // Convert canonical name into imgflip's URL-slug form: dashes preserved
      // and title-case-ish, but imgflip is tolerant. Use dashes-with-spaces->dashes.
      const nameSlug = String(m.name).trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9-]/g, "");
      const memePageUrl = `https://imgflip.com/meme/${encodeURIComponent(nameSlug)}`;
      let variantHashes = [];
      try {
        const html = await fetchText(memePageUrl);
        variantHashes = extractVariantHashesFromMemePage(html);
        await log(`  [${slug}] ${memePageUrl} -> ${variantHashes.length} variant hashes`);
      } catch (e) {
        await log(`  [${slug}] meme-page FAIL: ${memePageUrl} — ${e.message}`);
      }

      for (const h of variantHashes) {
        if (variantsSaved >= VARIANTS_PER_TEMPLATE) break;
        // Fetch the /i/<h> page to resolve the actual image URL (og:image).
        let imgUrl = null;
        try {
          const iPage = await fetchText(`https://imgflip.com/i/${h}`);
          imgUrl = extractImageUrlFromVariantPage(iPage, h);
        } catch (e) {
          await log(`    /i/${h} page FAIL: ${e.message}`);
          continue;
        }
        if (!imgUrl) {
          await log(`    /i/${h} no image URL found`);
          continue;
        }
        const ext = imgUrl.toLowerCase().endsWith(".png") ? "png" : "jpg";
        const outPath = join(conceptDir, `variant-${variantsSaved+1}.${ext}`);
        try {
          const bytes = await downloadBinary(imgUrl, outPath);
          if (bytes < 3000) {
            await log(`    variant reject (${bytes}B): ${imgUrl}`);
            continue;
          }
          variantsSaved++;
          totalFiles++;
          await log(`    variant ${variantsSaved} OK (${bytes}B): ${imgUrl}`);
        } catch (e) {
          await log(`    variant DL FAIL: ${imgUrl} — ${e.message}`);
        }
      }

      if (variantsSaved >= VARIANTS_PER_TEMPLATE) templatesWith5Variants++;
      else if (variantsSaved === 0) noVariantList.push(slug);
      else partialVariantList.push({ slug, variants: variantsSaved });

      summary.push({ slug, name: m.name, id: m.id, captions: m.captions, variants_saved: variantsSaved });
    } else {
      summary.push({ slug, name: m.name, id: m.id, captions: m.captions, variants_saved: 0 });
    }
  }

  // 3) Write summary
  const summaryPath = join(CORPUS_ROOT, "_corpus-summary.json");
  const summaryPayload = {
    generated_at: new Date().toISOString(),
    corpus_root: CORPUS_ROOT,
    templates_fetched: templatesFetched,
    total_files: totalFiles,
    templates_with_5_variants: templatesWith5Variants,
    top_n_for_variants: TOP_N_FOR_VARIANTS,
    templates: summary,
    templates_with_zero_variants: noVariantList,
    templates_with_partial_variants: partialVariantList,
  };
  await writeFile(summaryPath, JSON.stringify(summaryPayload, null, 2));
  await log(`SUMMARY written: ${summaryPath}`);
  await log(`templates_fetched=${templatesFetched} total_files=${totalFiles} templates_with_5_variants=${templatesWith5Variants}`);
  await log(`END meme-corpus-fetch`);
}

main().catch(async (e) => {
  await log(`FATAL ${e.stack || e.message}`);
  process.exit(1);
});
