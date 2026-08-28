#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const docsRoot = import.meta.dir;
const pdfRoot = join(docsRoot, 'pdf');
const manifestPath = join(docsRoot, 'manual-build-manifest.json');
const tempRoot = join(tmpdir(), `ae-orange-manuals-${process.pid}`);

const browserCandidates = [
  process.env.ORANGE_DOCS_BROWSER,
  process.env.PROGRAMFILES &&
    join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] &&
    join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.PROGRAMFILES &&
    join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

const browser = browserCandidates.find((candidate) => existsSync(candidate));
if (!browser) {
  throw new Error('Chrome or Edge is required to render Æ Orange AI Computer PDFs');
}

const manualNames = readdirSync(docsRoot)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort((left, right) => left.localeCompare(right));

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

function stemOf(name) {
  return name.replace(/\.md$/i, '').toLowerCase().replaceAll('_', '-');
}

const css = `
  :root { color-scheme: light; --orange:#e84d10; --ink:#171717; --muted:#626262; --line:#d8d8d8; --paper:#fff; }
  * { box-sizing:border-box; }
  @page { size:Letter; margin:0.7in 0.66in 0.72in; }
  html { background:#ececec; }
  body { max-width:8.5in; margin:0 auto; padding:0.72in 0.66in; background:var(--paper); color:var(--ink); font-family:Inter,"Segoe UI",Arial,sans-serif; font-size:10.5pt; line-height:1.48; }
  body::before { content:"ATOM EONS / Æ ORANGE AI COMPUTER"; display:block; color:var(--orange); font-size:8pt; font-weight:800; letter-spacing:.12em; border-bottom:2px solid var(--orange); padding-bottom:8px; margin-bottom:28px; }
  h1,h2,h3,h4 { break-after:avoid; line-height:1.18; color:#111; }
  h1 { font-size:28pt; margin:0 0 20px; }
  h2 { font-size:18pt; margin:30px 0 11px; padding-top:7px; border-top:1px solid var(--line); }
  h3 { font-size:13.5pt; margin:23px 0 8px; }
  h4 { font-size:11pt; margin:18px 0 6px; }
  p,li { orphans:3; widows:3; }
  a { color:#a9360b; text-decoration:none; }
  blockquote { margin:18px 0; padding:10px 15px; border-left:4px solid var(--orange); background:#fff5f0; }
  code { font-family:"Cascadia Mono",Consolas,monospace; background:#f3f3f3; padding:1px 4px; border-radius:3px; font-size:9pt; }
  pre { break-inside:avoid; white-space:pre-wrap; overflow-wrap:anywhere; background:#171717; color:#f7f7f7; padding:13px 15px; border-left:4px solid var(--orange); border-radius:4px; }
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
  .book-cover .mark { color:var(--orange); font-size:11pt; font-weight:800; letter-spacing:.16em; }
  .book-cover h1 { font-size:40pt; max-width:6.5in; margin:16px 0; }
  .book-cover p { color:var(--muted); font-size:14pt; max-width:5.7in; }
  .manual-section { page-break-before:always; }
  @media print { html,body { background:#fff; } body { padding:0; max-width:none; } }
`;

function documentHtml(title, body, sourceLabel, combined = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>${combined ? '' : `<div class="manual-meta">Canonical source: ${escapeHtml(sourceLabel)}</div>`}${body}</body></html>`;
}

async function printPdf(htmlPath, pdfPath) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    rmSync(pdfPath, { force: true });
    const profilePath = join(tempRoot, `chrome-${basename(htmlPath, '.html')}-${attempt}`);
    const process = Bun.spawn([
      browser,
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-logging',
      '--log-level=3',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      '--allow-file-access-from-files',
      `--user-data-dir=${profilePath}`,
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdout: 'ignore', stderr: 'ignore' });

    const pdfReady = (async () => {
      let priorSize = -1;
      let stableChecks = 0;
      for (let check = 0; check < 180; check += 1) {
        await Bun.sleep(250);
        if (!existsSync(pdfPath)) continue;
        const size = readFileSync(pdfPath).byteLength;
        stableChecks = size === priorSize ? stableChecks + 1 : 0;
        priorSize = size;
        if (size > 1024 && stableChecks >= 4) return { type: 'pdf' };
      }
      return { type: 'timeout' };
    })();

    const outcome = await Promise.race([
      process.exited.then((exitCode) => ({ type: 'exit', exitCode })),
      pdfReady,
    ]);

    if (outcome.type !== 'exit') process.kill();
    await process.exited;

    if (
      existsSync(pdfPath) &&
      (outcome.type === 'pdf' || (outcome.type === 'exit' && outcome.exitCode === 0))
    ) return;
  }

  throw new Error(`PDF render failed twice for ${basename(htmlPath)}`);
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
  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown';
}

rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });
mkdirSync(pdfRoot, { recursive: true });

for (const name of readdirSync(pdfRoot)) {
  if (name.endsWith('.pdf')) rmSync(join(pdfRoot, name), { force: true });
}

const generatedAt = new Date().toISOString();
const entries = [];
const completeSections = [];

try {
  for (const name of manualNames) {
    const sourcePath = join(docsRoot, name);
    const markdown = readFileSync(sourcePath, 'utf8');
    const title = titleOf(markdown, name.replace(/\.md$/i, ''));
    const stem = stemOf(name);
    const htmlPath = join(tempRoot, `${stem}.html`);
    const pdfPath = join(pdfRoot, `${stem}.pdf`);
    const rendered = Bun.markdown.html(markdown, { tables: true, headingIds: true });

    writeFileSync(htmlPath, documentHtml(title, rendered, `docs/${name}`));
    await printPdf(htmlPath, pdfPath);

    const pdf = readFileSync(pdfPath);
    entries.push({
      title,
      source: `docs/${name}`,
      sourceSha256: sha256(markdown),
      pdf: `docs/pdf/${basename(pdfPath)}`,
      pdfSha256: sha256(pdf),
      pdfBytes: pdf.byteLength,
    });
    completeSections.push(`<section class="manual-section">${rendered}</section>`);
  }

  const completeTitle = 'Æ Orange AI Computer Public Manual Set';
  const cover = `<section class="book-cover"><div class="mark">ATOM EONS / Æ ORANGE AI COMPUTER</div><h1>${completeTitle}</h1><p>Current source boundaries, operating guidance, public evidence, and explicit gaps.</p><div class="manual-meta">Generated ${escapeHtml(generatedAt)} from public Markdown.</div></section>`;
  const completeHtmlPath = join(tempRoot, 'orange-ai-computer-public-manuals.html');
  const completePdfPath = join(pdfRoot, 'orange-ai-computer-public-manuals.pdf');
  writeFileSync(
    completeHtmlPath,
    documentHtml(completeTitle, `${cover}${completeSections.join('\n')}`, 'public manual set', true),
  );
  await printPdf(completeHtmlPath, completePdfPath);

  const completePdf = readFileSync(completePdfPath);
  const manifest = {
    schema: 'ae.orange-ai-computer.public-manual-build.v1',
    generatedAt,
    canonicalFormat: 'markdown',
    generator: {
      bun: Bun.version,
      browser,
      browserVersion: browserVersionOf(browser),
    },
    manuals: entries,
    completeBook: {
      pdf: 'docs/pdf/orange-ai-computer-public-manuals.pdf',
      pdfSha256: sha256(completePdf),
      pdfBytes: completePdf.byteLength,
    },
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'PUBLIC_MANUALS_BUILT',
    manuals: entries.length,
    manifest: manifestPath,
    completePdf: completePdfPath,
    completePdfSha256: manifest.completeBook.pdfSha256,
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
