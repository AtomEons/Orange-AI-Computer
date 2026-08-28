#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const guideRoot = join(root, '00-CHARTER', 'GUIDES');
const htmlRoot = join(guideRoot, 'html');
const pdfRoot = join(guideRoot, 'pdf');
const manifestPath = join(guideRoot, 'manual-build-manifest.json');

const manualNames = [
  'QUICK_START.md',
  'OPERATOR_MANUAL.md',
  'LLM_OPERATOR_GUIDE.md',
  'TECHNICAL_ARCHITECTURE.md',
  'FEATURES_GUIDE.md',
  'MODEL_INSTALLATION_GUIDE.md',
  'BUN_RUNTIME.md',
  'MEMORY_AND_LEARNING.md',
  'RECEIPTS_AND_AUDIT.md',
  'ATOMIC_ORANGE_NATIVE_APP.md',
  'ATOMSMASHER_PRODUCTION.md',
  'FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md',
  'SKEPTICS_FIELD_GUIDE.md',
  'PROOF_AND_BENCHMARKS.md',
  'TROUBLESHOOTING_AND_RECOVERY.md',
];

const browserCandidates = [
  process.env.ORANGE_DOCS_BROWSER,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

const browser = browserCandidates.find((candidate) => existsSync(candidate));
if (!browser) throw new Error('Chrome or Edge is required to render Æ Orange AI Computer PDFs');

function sha256(input) {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function titleOf(markdown, fallback) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

const css = `
  :root { color-scheme: light; --orange:#ff5a1f; --ink:#171717; --muted:#666; --line:#dedede; --paper:#fff; }
  * { box-sizing: border-box; }
  @page { size: Letter; margin: 0.7in 0.66in 0.72in; }
  html { background:#ececec; }
  body { max-width: 8.5in; margin: 0 auto; padding: 0.72in 0.66in; background:var(--paper); color:var(--ink); font-family: Inter, "Segoe UI", Arial, sans-serif; font-size:10.5pt; line-height:1.48; }
  body::before { content:"ATOM EONS  /  Æ ORANGE AI COMPUTER"; display:block; color:var(--orange); font-size:8pt; font-weight:800; letter-spacing:.14em; border-bottom:2px solid var(--orange); padding-bottom:8px; margin-bottom:28px; }
  h1,h2,h3,h4 { break-after:avoid; line-height:1.15; color:#111; }
  h1 { font-size:28pt; margin:0 0 20px; }
  h2 { font-size:18pt; margin:30px 0 11px; padding-top:7px; border-top:1px solid var(--line); }
  h3 { font-size:13.5pt; margin:23px 0 8px; }
  h4 { font-size:11pt; margin:18px 0 6px; }
  p, li { orphans:3; widows:3; }
  a { color:#b7390d; text-decoration:none; }
  strong { color:#111; }
  blockquote { margin:18px 0; padding:10px 15px; border-left:4px solid var(--orange); background:#fff5f0; }
  code { font-family:"Cascadia Mono",Consolas,monospace; background:#f4f4f4; padding:1px 4px; border-radius:3px; font-size:9pt; }
  pre { break-inside:avoid; white-space:pre-wrap; background:#161616; color:#f7f7f7; padding:13px 15px; border-left:4px solid var(--orange); border-radius:4px; overflow-wrap:anywhere; }
  pre code { color:inherit; background:none; padding:0; }
  table { width:100%; border-collapse:collapse; margin:15px 0 21px; break-inside:auto; font-size:9pt; }
  thead { display:table-header-group; }
  tr { break-inside:avoid; }
  th,td { border:1px solid var(--line); padding:7px 8px; vertical-align:top; }
  th { text-align:left; background:#fff1eb; }
  ul,ol { padding-left:22px; }
  img { max-width:100%; height:auto; }
  hr { border:0; border-top:1px solid var(--line); margin:28px 0; }
  .manual-meta { color:var(--muted); font-size:8.5pt; margin:-10px 0 30px; }
  .book-cover { min-height:8.2in; display:flex; flex-direction:column; justify-content:center; page-break-after:always; }
  .book-cover .mark { color:var(--orange); font-size:11pt; font-weight:800; letter-spacing:.18em; }
  .book-cover h1 { font-size:42pt; max-width:6.5in; margin:16px 0; }
  .book-cover p { color:var(--muted); font-size:15pt; max-width:5.7in; }
  .manual-section { page-break-before:always; }
  @media print { html,body { background:#fff; } body { padding:0; max-width:none; } }
`;

function documentHtml(title, body, sourceLabel, combined = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body class="${combined ? 'complete-book' : 'single-manual'}">
${combined ? '' : `<div class="manual-meta">Canonical source: ${escapeHtml(sourceLabel)}</div>`}
${body}
</body></html>`;
}

function printPdf(htmlPath, pdfPath) {
  rmSync(pdfPath, { force: true });
  const result = Bun.spawnSync([
    browser,
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--allow-file-access-from-files',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0 || !existsSync(pdfPath)) {
    throw new Error(`PDF render failed for ${basename(htmlPath)}: ${result.stderr.toString()}`);
  }
}

function browserVersionOf(executable) {
  const result = Bun.spawnSync([
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-Item -LiteralPath $env:ORANGE_DOCS_BROWSER_EXE).VersionInfo.ProductVersion',
  ], {
    env: { ...process.env, ORANGE_DOCS_BROWSER_EXE: executable },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const version = result.stdout.toString().trim();
  return result.exitCode === 0 && version ? version : 'unknown';
}

mkdirSync(htmlRoot, { recursive: true });
mkdirSync(pdfRoot, { recursive: true });

const generatedAt = new Date().toISOString();
const entries = [];
const completeSections = [];

for (const name of manualNames) {
  const sourcePath = join(guideRoot, name);
  if (!existsSync(sourcePath)) throw new Error(`missing canonical manual: ${sourcePath}`);
  const markdown = readFileSync(sourcePath, 'utf8');
  const title = titleOf(markdown, name.replace(/\.md$/i, ''));
  const stem = name.replace(/\.md$/i, '').toLowerCase().replaceAll('_', '-');
  const htmlPath = join(htmlRoot, `${stem}.html`);
  const pdfPath = join(pdfRoot, `${stem}.pdf`);
  const rendered = Bun.markdown.html(markdown, { tables: true, headingIds: true });
  const html = documentHtml(title, rendered, relative(root, sourcePath).replaceAll('\\', '/'));
  writeFileSync(htmlPath, html);
  printPdf(htmlPath, pdfPath);
  entries.push({
    title,
    source: relative(root, sourcePath).replaceAll('\\', '/'),
    sourceSha256: sha256(markdown),
    html: relative(root, htmlPath).replaceAll('\\', '/'),
    htmlSha256: sha256(readFileSync(htmlPath)),
    pdf: relative(root, pdfPath).replaceAll('\\', '/'),
    pdfSha256: sha256(readFileSync(pdfPath)),
    pdfBytes: readFileSync(pdfPath).byteLength,
  });
  completeSections.push(`<section class="manual-section">${rendered}</section>`);
}

const completeTitle = 'Æ Orange AI Computer Complete Manual';
const cover = `<section class="book-cover"><div class="mark">ATOM EONS / ORANGE</div><h1>${completeTitle}</h1><p>A local-first AI computer control plane for building, operating, remembering, compressing, and proving work.</p><div class="manual-meta">Generated ${escapeHtml(generatedAt)} from canonical Markdown.</div></section>`;
const completeHtmlPath = join(htmlRoot, 'orange-ai-computer-complete-manual.html');
const completePdfPath = join(pdfRoot, 'orange-ai-computer-complete-manual.pdf');
writeFileSync(completeHtmlPath, documentHtml(completeTitle, `${cover}${completeSections.join('\n')}`, 'canonical manual set', true));
printPdf(completeHtmlPath, completePdfPath);

const browserVersion = browserVersionOf(browser);
const manifest = {
  schema: 'orange5.manual-build-manifest.v1',
  generatedAt,
  canonicalFormat: 'markdown',
  generator: { bun: Bun.version, browser, browserVersion },
  manuals: entries,
  completeBook: {
    html: relative(root, completeHtmlPath).replaceAll('\\', '/'),
    htmlSha256: sha256(readFileSync(completeHtmlPath)),
    pdf: relative(root, completePdfPath).replaceAll('\\', '/'),
    pdfSha256: sha256(readFileSync(completePdfPath)),
    pdfBytes: readFileSync(completePdfPath).byteLength,
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  status: 'ORANGE5_MANUALS_BUILT',
  manuals: entries.length,
  manifest: manifestPath,
  completePdf: completePdfPath,
  completePdfBytes: manifest.completeBook.pdfBytes,
  completePdfSha256: manifest.completeBook.pdfSha256,
}, null, 2));
