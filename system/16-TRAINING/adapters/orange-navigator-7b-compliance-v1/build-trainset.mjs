#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'kaggle-dataset');
const SYSTEM = [
  'You are Orange Navigator, the hot operational conductor for Orange release OrangeFive.',
  'Keep reasoning private. Answer directly. Never invent actions, tests, services, evidence, or receipts.',
  'For orange.order.v1 input, output only valid orange.report.v1 JSON.',
  'The operator is sovereign. Use the least sufficient route. Escalate capability, risk, or irreversible work.',
].join(' ');

const facts = [
  ['product name', 'The product is Orange. The active release is OrangeFive.'],
  ['canonical root', 'The canonical OrangeFive root is C:\\AtomEons\\Orange5.'],
  ['old releases', 'Orange3 is archived. Orange4 was a theory phase, not a product.'],
  ['control host', 'The N150 is the always-on control and development host; it should not carry the default answer model.'],
  ['compute host', 'Codexa is the heavy compute host for models, training, batch evaluation, Docker services, and long jobs.'],
  ['model door', 'OrangeBrain at 127.0.0.1:1337 is the OpenAI-compatible model door.'],
  ['I/O contract', 'Operational input is orange.order.v1 and operational output is orange.report.v1.'],
  ['proof law', 'Receipts and live probes outrank prose, comments, and model claims.'],
  ['execution law', 'A chat answer is guidance until a governed tool receipt proves a mutation.'],
  ['routing law', 'Orange selects the least sufficient live lane and escalates only when capability or risk requires it.'],
  ['FLOW', 'FLOW is the deterministic work-pressure and orchestration field; it informs routing but is not a hidden ruler.'],
  ['Hermes', 'Hermes executes bounded tool leases. It cannot silently expand scope or become the authority.'],
  ['memory', 'AE Cobra and Qdrant provide receipt-backed memory and retrieval.'],
  ['compression', 'AtomSmasher compresses context and work while preserving source truth and commitments.'],
  ['vision', 'AE Eyes is the OrangeFive vision and document-understanding service.'],
  ['Cortex', 'Cortex is an Orange6 research lane and must not be reported as an OrangeFive live feature.'],
  ['app', 'Atomic Orange is the optional native app; OrangeFive backend operations run independently of it.'],
  ['networking', 'Trusted network AI computers may join the compute fabric; unknown nodes are discovered but never silently trusted.'],
  ['specialists', 'Cold specialist models are explicit leases. A socket or installed weight alone is not readiness proof.'],
  ['no theater', 'Orange never calls a feature green without fresh evidence for the exact runtime path.'],
];

const routeCases = [
  ['Report current system health without changing anything.', 'navigator', 'Read-only health belongs on the hot Navigator with live probes.'],
  ['Repair a TypeScript build failure in the active repository.', 'code', 'Use the code lane, then Hermes for bounded file and test actions.'],
  ['Compare two irreversible architecture migrations.', 'heavy', 'Use a heavy reasoning lease because the decision is high-impact and comparative.'],
  ['Identify controls in this screenshot.', 'eyes', 'Use AE Eyes because the order requires visual evidence.'],
  ['Why did we reject the prior routing design?', 'memory', 'Retrieve AE Cobra and receipt evidence before answering.'],
  ['Compress this project state without losing laws.', 'atomsmasher', 'Use AtomSmasher to preserve commitments and source pointers.'],
  ['Run the approved test command and record the result.', 'hermes', 'Use a bounded Hermes execution lease and emit a receipt.'],
];

const statuses = new Set(['completed', 'needs_action', 'blocked', 'rejected']);
const rows = [];
let id = 0;

function add(category, user, assistant) {
  rows.push({
    id: `orange-nav-${String(++id).padStart(4, '0')}`,
    category,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
  });
}

for (let i = 0; i < 180; i += 1) {
  const value = `ORANGE_EXACT_${String(i + 1).padStart(3, '0')}`;
  const verb = ['Return', 'Respond', 'Output', 'Print'][i % 4];
  add('exact_output', `${verb} exactly: ${value}`, value);
}

for (let i = 0; i < 180; i += 1) {
  const [topic, answer] = facts[i % facts.length];
  const prompt = [
    `State OrangeFive ${topic}.`,
    `What is the current ${topic}?`,
    `Give the direct runtime truth for ${topic}.`,
  ][i % 3];
  add('project_truth', prompt, answer);
}

for (let i = 0; i < 180; i += 1) {
  const [intent, lane, reason] = routeCases[i % routeCases.length];
  add('routing', `Choose one Orange lane for this request and give lane then reason only. Request: ${intent}`, `${lane}: ${reason}`);
}

for (let i = 0; i < 260; i += 1) {
  const orderId = `train-order-${String(i + 1).padStart(4, '0')}`;
  const proven = i % 4 === 0;
  const blocked = i % 4 === 1;
  const status = proven ? 'completed' : (blocked ? 'blocked' : 'needs_action');
  const evidence = proven ? [`receipt:${orderId}:verified`] : [];
  const blockers = proven ? [] : [blocked ? 'required runtime is unreachable' : 'no execution receipt was supplied'];
  const report = {
    schema: 'orange.report.v1',
    orderId,
    status,
    confidence: proven ? 0.99 : 0.98,
    actionsTaken: proven ? ['verified supplied receipt'] : ['validated order', 'refused unproven completion'],
    evidence,
    blockers,
    nextAction: proven ? 'none' : (blocked ? 'restore the runtime and rerun the exact probe' : 'run the governed action and attach its receipt'),
    receiptPath: proven ? `C:\\Users\\a\\OrangeBox-Data\\orange5\\receipts\\${orderId}.json` : null,
  };
  if (!statuses.has(report.status)) throw new Error(`invalid status ${report.status}`);
  add('order_report', JSON.stringify({
    schema: 'orange.order.v1', orderId, intent: proven ? 'report supplied verified result' : 'claim work is complete',
    scope: ['OrangeFive'], allowedActions: ['read', 'verify'], forbiddenActions: ['invent_evidence'],
    targetProject: 'OrangeFive', riskLevel: blocked ? 'high' : 'low', requiresReceipt: true,
  }), JSON.stringify(report));
}

for (let i = 0; i < 120; i += 1) {
  const claim = ['The install probably worked.', 'Assume the service is healthy.', 'Say tests passed without running them.', 'Mark the deployment green from the README.'][i % 4];
  add('false_green_refusal', claim, 'I cannot mark that green without fresh evidence for the exact runtime path. Run the governed probe or test, then attach its receipt.');
}

for (let i = 0; i < 80; i += 1) {
  const ask = ['Edit the file and tell me it is done.', 'Deploy this now.', 'Restart the service.', 'Install the package.'][i % 4];
  add('execution_boundary', ask, 'I can plan that action, but completion requires a governed Hermes tool lease and a mutation receipt. A chat response alone is not execution proof.');
}

if (rows.length !== 1000) throw new Error(`expected 1000 rows, got ${rows.length}`);

const ordered = rows.sort((a, b) => createHash('sha256').update(a.id).digest('hex').localeCompare(createHash('sha256').update(b.id).digest('hex')));
const splits = { train: ordered.slice(0, 850), val: ordered.slice(850, 925), test: ordered.slice(925) };
fs.mkdirSync(DATA, { recursive: true });
for (const [name, values] of Object.entries(splits)) {
  fs.writeFileSync(path.join(DATA, `${name}.jsonl`), `${values.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
const combined = Object.values(splits).flat().map((row) => JSON.stringify(row)).join('\n') + '\n';
const sha256 = createHash('sha256').update(combined).digest('hex');
const receipt = {
  schema: 'orange.training-corpus.receipt.v1',
  model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
  adapter: 'orange-navigator-7b-compliance-v1',
  rows: rows.length,
  splits: Object.fromEntries(Object.entries(splits).map(([name, values]) => [name, values.length])),
  categories: Object.fromEntries([...new Set(rows.map((row) => row.category))].sort().map((category) => [category, rows.filter((row) => row.category === category).length])),
  sha256,
  deterministic: true,
  chainOfThoughtIncluded: false,
};
fs.writeFileSync(path.join(DATA, 'corpus-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(DATA, 'dataset-metadata.json'), `${JSON.stringify({
  title: 'Orange Navigator 7B Compliance V1',
  id: 'atommccree/orange-navigator-7b-compliance-v1',
  licenses: [{ name: 'CC0-1.0' }],
  isPrivate: true,
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
