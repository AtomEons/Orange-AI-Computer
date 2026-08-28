#!/usr/bin/env bun
// 07-VISUAL/test-pdf-generator.mjs — OrangeEye Phase-1 smoke fixture generator.
//
// Emits a single-page, hand-rolled PDF 1.4 with a deterministic English string
// ("OrangeEye Phase-1 smoke ...") that the smoke test can re-query against the
// MaxSim index. No dependencies — we build the PDF bytes by hand so the smoke
// suite is fully offline-runnable and the file budget stays at three files.
//
// Why hand-rolled instead of pdfkit:
//   - Mom's Law: a dep we don't need is fluff. Smoke fixtures must not pull
//     a node_modules tree (~12 MB for pdfkit) onto Codexa just to draw a line
//     of black text.
//   - Determinism: the same bytes every run → same SHA-256 → stable Qdrant
//     doc_id during repeat smoke runs.
//   - No fonts on disk required: we use the PDF base-14 font Helvetica, which
//     every PDF reader (and ColPali's pdf2image preprocessor) supports
//     intrinsically. ColPali ultimately rasterises the page to a PNG before
//     embedding, so the font choice only affects rasterised pixels.
//
// CLI:
//   bun test-pdf-generator.mjs              -> writes test-fixture.pdf next to this script
//   bun test-pdf-generator.mjs out.pdf      -> writes to out.pdf
//   bun test-pdf-generator.mjs --stdout > x -> emits to stdout (no newline)
//
// What this does NOT do (yet):
//   - no multi-page support
//   - no embedded images / charts / tables (the smoke test only needs text)
//   - no PDF/A compliance, no encryption, no metadata XMP — pure raw bytes
//   - no Unicode beyond WinAnsiEncoding (Helvetica's default code page)
//
// Exit codes:
//   0 — file written (or stdout flushed) successfully
//   2 — I/O error writing the output path

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Canonical smoke text. Keep stable — the smoke-test query string is derived
// from a substring of this.
export const SMOKE_TEXT_LINES = [
  "OrangeEye Phase-1 smoke fixture",
  "Codexa visual stack: ColPali, Qdrant, GLM-4.6V, AE Cobra",
  "If you can read this through the visual lane the eye is open",
  "doc id: ae-orangeeye-smoke-2026-06-24",
];

/**
 * Build a minimal, deterministic PDF 1.4 byte buffer containing one page with
 * the supplied lines rendered in Helvetica 14pt, US Letter portrait, top-left
 * origin baseline at (72pt, 720pt), 24pt line spacing.
 *
 * @param {string[]} lines  Lines of WinAnsi-safe text.
 * @returns {Uint8Array}    Raw PDF bytes.
 */
export function buildSmokePdf(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("buildSmokePdf: lines must be a non-empty array");
  }
  for (const ln of lines) {
    if (typeof ln !== "string") {
      throw new Error("buildSmokePdf: every line must be a string");
    }
  }

  // PDF strings: escape \, (, ) and force ASCII range. ColPali rasterises
  // before embedding, so we don't need fancy Unicode — but we DO need
  // to make sure the PDF parser doesn't choke.
  const escape = (s) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      // Drop anything outside printable ASCII; the smoke text is ASCII-only,
      // but defend against accidental smart-quote paste.
      .replace(/[^\x20-\x7E]/g, "?");

  // Build the page content stream: a text object that walks the y-cursor
  // downward by 24pt for each line.
  const tjLines = lines
    .map((ln, idx) => {
      const dy = idx === 0 ? 0 : -24;
      const cmd = idx === 0 ? "" : `0 ${dy} Td\n`;
      return `${cmd}(${escape(ln)}) Tj`;
    })
    .join("\n");

  const contentStream =
    "BT\n" +
    "/F1 14 Tf\n" +
    "72 720 Td\n" +
    `${tjLines}\n` +
    "ET\n";

  const contentBytes = new TextEncoder().encode(contentStream);

  // We assemble objects 1..5 then patch the xref offsets.
  // 1: Catalog, 2: Pages, 3: Page, 4: Content stream, 5: Helvetica font.
  const objects = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R " +
      "/MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> " +
      "/Contents 4 0 R >>\nendobj\n",
  );

  // Object 4 = the stream. Its body is binary, so we encode in two halves
  // (header text + raw stream bytes + footer text) when we serialise below.
  const obj4Header = `4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`;
  const obj4Footer = "\nendstream\nendobj\n";

  objects.push({ header: obj4Header, body: contentBytes, footer: obj4Footer });

  objects.push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 " +
      "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
  );

  // Serialise to bytes, recording each object's byte-offset from file start.
  // PDF 1.4 header + high-bit binary marker comment (ISO 32000-1 §7.5.2):
  // four bytes > 0x7F so downstream tools treat the file as binary, not text.
  const headerAscii = new TextEncoder().encode("%PDF-1.4\n");
  const headerBinaryMarker = new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);
  const parts = [];
  parts.push(headerAscii, headerBinaryMarker);
  const offsets = [];
  let cursor = headerAscii.length + headerBinaryMarker.length;

  for (const obj of objects) {
    offsets.push(cursor);
    if (typeof obj === "string") {
      const b = new TextEncoder().encode(obj);
      parts.push(b);
      cursor += b.length;
    } else {
      const h = new TextEncoder().encode(obj.header);
      const f = new TextEncoder().encode(obj.footer);
      parts.push(h, obj.body, f);
      cursor += h.length + obj.body.length + f.length;
    }
  }

  const xrefStart = cursor;
  const padOff = (n) => String(n).padStart(10, "0");
  const xrefLines = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    `${padOff(offsets[0])} 00000 n `,
    `${padOff(offsets[1])} 00000 n `,
    `${padOff(offsets[2])} 00000 n `,
    `${padOff(offsets[3])} 00000 n `,
    `${padOff(offsets[4])} 00000 n `,
    "",
  ].join("\n");
  parts.push(new TextEncoder().encode(xrefLines));

  const trailer =
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(new TextEncoder().encode(trailer));

  // Concatenate
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * CLI entry. Default path: ./test-fixture.pdf next to this script.
 */
async function main() {
  const args = process.argv.slice(2);
  const wantStdout = args.includes("--stdout");
  const outArg = args.find((a) => !a.startsWith("--"));

  const bytes = buildSmokePdf(SMOKE_TEXT_LINES);

  if (wantStdout) {
    process.stdout.write(bytes);
    return;
  }

  const outPath = outArg
    ? resolve(process.cwd(), outArg)
    : resolve(HERE, "test-fixture.pdf");

  try {
    await writeFile(outPath, bytes);
  } catch (err) {
    console.error(`[test-pdf-generator] write failed: ${err.message}`);
    process.exit(2);
  }

  console.log(`[test-pdf-generator] wrote ${bytes.length} bytes -> ${outPath}`);
}

// Only run main() when invoked directly, not when imported by the smoke test.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1]?.replaceAll("\\", "/") ?? "");

if (invokedDirectly) {
  await main();
}
