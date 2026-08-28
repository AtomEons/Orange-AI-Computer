import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_ROOT = resolve(MODULE_DIR, '..');
export const PUBLIC_ROOT = resolve(SYSTEM_ROOT, '..');

const DEFAULT_DOCUMENTS = [
  resolve(SYSTEM_ROOT, '00-CHARTER', 'ORANGE5_NOT_GREEN_LEDGER.md'),
  resolve(PUBLIC_ROOT, 'proof', 'EVIDENCE_LEDGER.md'),
];

function isEvidenceReference(value) {
  return /(?:^|[/\\])[^\s`()[\]]+\.(?:json|md)$/i.test(value);
}

function cleanReference(value) {
  return value
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[),.;:]+$/g, '')
    .replace(/\\/g, '/');
}

export function extractEvidenceReferences(markdown) {
  const found = new Set();
  const markdownLinks = /\[[^\]]*\]\(([^)]+)\)/g;
  const codeLiterals = /`([^`]+)`/g;

  for (const pattern of [markdownLinks, codeLiterals]) {
    for (const match of markdown.matchAll(pattern)) {
      const reference = cleanReference(match[1]);
      if (isEvidenceReference(reference) && !/^(?:https?:|mailto:)/i.test(reference)) {
        found.add(reference);
      }
    }
  }

  return [...found].sort();
}

export function resolveEvidenceReference(documentPath, reference) {
  if (isAbsolute(reference)) return resolve(reference);
  if (/^system\//i.test(reference)) return resolve(PUBLIC_ROOT, reference);
  if (/^(?:10-RECEIPTS|00-CHARTER|03-BACKEND|06-ORANGELLM|08-HERMES|12-ATOMSMASHER)\//i.test(reference)) {
    return resolve(SYSTEM_ROOT, reference);
  }
  return resolve(dirname(documentPath), reference);
}

export function auditEvidenceDocuments(documentPaths = DEFAULT_DOCUMENTS) {
  const documents = [];
  const missing = [];

  for (const documentPath of documentPaths) {
    const absoluteDocument = resolve(documentPath);
    if (!existsSync(absoluteDocument)) {
      missing.push({ document: absoluteDocument, reference: null, resolvedPath: absoluteDocument });
      continue;
    }

    const references = extractEvidenceReferences(readFileSync(absoluteDocument, 'utf8'));
    const checked = references.map((reference) => {
      const resolvedPath = resolveEvidenceReference(absoluteDocument, reference);
      const present = existsSync(resolvedPath);
      const item = { reference, resolvedPath, present };
      if (!present) missing.push({ document: absoluteDocument, ...item });
      return item;
    });

    documents.push({ document: absoluteDocument, references: checked });
  }

  return {
    schema: 'orange.public-evidence-audit.v1',
    ok: missing.length === 0,
    documents,
    checkedReferences: documents.reduce((total, item) => total + item.references.length, 0),
    missing,
  };
}

function isMain() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const requestedDocuments = process.argv.slice(2);
  const report = auditEvidenceDocuments(requestedDocuments.length ? requestedDocuments : DEFAULT_DOCUMENTS);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
