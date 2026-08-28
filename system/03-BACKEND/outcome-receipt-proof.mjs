#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME_ALPHA_PROOF_SCHEMA,
  OUTCOME_RECEIPT_MODE,
  OutcomeReceiptSession,
  RECEIPT_GENESIS,
  TERMINAL_OUTCOMES,
  canonicalJson,
  chainCanonicalRecord,
  countTerminalOutcomes,
  sha256Bytes,
  sha256Canonical,
  verifyCanonicalRecord,
  verifyOutcomeReceipt,
} from './outcome-receipt.mjs';

export const OUTCOME_ALPHA_DOMAINS = Object.freeze(['file', 'process', 'http', 'artifact']);
export const OUTCOME_ALPHA_SCENARIOS = Object.freeze([
  'happy-path',
  'false-executor-success',
  'stale-observation',
  'partial-write',
  'verifier-disagreement',
  'missing-identity',
  'duplicate-terminal-attempt',
  'limitation-omission',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = path.join(ROOT, '03-BACKEND', 'outcome-receipt.mjs');
const PROOF_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = path.join(ROOT, '03-BACKEND', 'tests', 'outcome-receipt.test.mjs');
const FIXTURE_EPOCH_MS = 1_788_220_800_000;
const OBSERVATION_MAX_AGE_MS = 250;
const READY_PROCESS_SOURCE = "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);";
const PARTIAL_PROCESS_SOURCE = "process.stdout.write('STARTED\\n'); setInterval(() => {}, 1000);";

const REQUIRED_REFUSAL = Object.freeze({
  'false-executor-success': 'EXECUTOR_ORACLE_DISAGREEMENT',
  'stale-observation': 'STALE_OBSERVATION',
  'partial-write': 'ORACLE_EFFECT_NOT_SATISFIED',
  'verifier-disagreement': 'VERIFIER_ORACLE_DISAGREEMENT',
  'missing-identity': 'VERIFIER_IDENTITY_MISSING',
  'duplicate-terminal-attempt': 'DUPLICATE_TERMINAL_ATTEMPT',
  'limitation-omission': 'LIMITATIONS_NOT_CARRIED',
});

function identity(id, implementation) {
  return {
    id,
    implementation_sha256: sha256Canonical({ implementation }),
  };
}

function stateArtifactHash(domain, state) {
  if (domain === 'process') return state.executable_sha256;
  if (domain === 'http') return state.body_sha256;
  return state.content_sha256;
}

function variantForScenario(scenario) {
  if (scenario === 'false-executor-success') return 'absent';
  if (scenario === 'partial-write') return 'partial';
  return 'complete';
}

function fileState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { byte_length: 0, content_sha256: null, exists: false };
  }
  const bytes = fs.readFileSync(filePath);
  return {
    byte_length: bytes.length,
    content_sha256: sha256Bytes(bytes),
    exists: true,
  };
}

function artifactState(filePath, manifestSha256) {
  const state = fileState(filePath);
  return { ...state, manifest_sha256: state.exists ? manifestSha256 : null };
}

function writeVariant(filePath, completeBytes, variant) {
  if (variant === 'absent') return;
  const bytes = variant === 'partial'
    ? completeBytes.subarray(0, Math.max(1, Math.floor(completeBytes.length / 2)))
    : completeBytes;
  fs.writeFileSync(filePath, bytes);
}

function startHttpOracle() {
  const routes = new Map();
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(route.status, { 'content-type': route.contentType });
    response.end(route.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        routes,
        server,
        urlFor: (caseId) => `http://127.0.0.1:${address.port}/${caseId}`,
      });
    });
  });
}

async function closeHttpOracle(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function startProcessFixture(source) {
  const child = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('process fixture did not emit a readiness marker'));
    }, 5_000);
    const finish = (callback) => (value) => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onError = finish(reject);
    const onExit = finish((code) => reject(new Error(`process fixture exited before readiness: ${code}`)));
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.once('data', finish((chunk) => resolve({
      child,
      marker: chunk.toString('utf8').trim(),
    })));
  });
}

async function stopProcessFixture(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const result = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!result && child.exitCode === null) child.kill('SIGKILL');
}

function logicalTarget(domain, caseId) {
  if (domain === 'http') return `http://outcome-receipt.local/${caseId}`;
  return `${domain}://outcome-receipt/${caseId}`;
}

async function acquireDomainTruth(context, domain, scenario, caseId) {
  const variant = variantForScenario(scenario);
  const target = logicalTarget(domain, caseId);

  if (domain === 'file') {
    const completeBytes = Buffer.from(`orange5 outcome file ${caseId} complete\n`, 'utf8');
    const filePath = path.join(context.tempRoot, `${caseId}.txt`);
    writeVariant(filePath, completeBytes, variant);
    return {
      actualState: fileState(filePath),
      expectedState: {
        byte_length: completeBytes.length,
        content_sha256: sha256Bytes(completeBytes),
        exists: true,
      },
      target,
    };
  }

  if (domain === 'artifact') {
    const completeBytes = Buffer.from(canonicalJson({ case_id: caseId, complete: true, version: 1 }), 'utf8');
    const manifestSha256 = sha256Canonical({ artifact: caseId, media_type: 'application/json', version: 1 });
    const filePath = path.join(context.tempRoot, `${caseId}.artifact`);
    writeVariant(filePath, completeBytes, variant);
    return {
      actualState: artifactState(filePath, manifestSha256),
      expectedState: {
        byte_length: completeBytes.length,
        content_sha256: sha256Bytes(completeBytes),
        exists: true,
        manifest_sha256: manifestSha256,
      },
      target,
    };
  }

  if (domain === 'process') {
    const expectedExecutableSha256 = sha256Bytes(READY_PROCESS_SOURCE);
    const expectedState = {
      executable_sha256: expectedExecutableSha256,
      ready: true,
      running: true,
    };
    if (variant === 'absent') {
      return {
        actualState: { executable_sha256: null, ready: false, running: false },
        expectedState,
        target,
      };
    }
    const source = variant === 'partial' ? PARTIAL_PROCESS_SOURCE : READY_PROCESS_SOURCE;
    const fixture = await startProcessFixture(source);
    context.children.push(fixture.child);
    return {
      actualState: {
        executable_sha256: sha256Bytes(source),
        ready: fixture.marker === 'READY',
        running: fixture.child.exitCode === null,
      },
      expectedState,
      target,
    };
  }

  const completeBody = canonicalJson({ case_id: caseId, committed: true, version: 1 });
  let actualBody = completeBody;
  let status = 200;
  if (variant === 'absent') {
    actualBody = canonicalJson({ case_id: caseId, committed: false, version: 1 });
    status = 503;
  } else if (variant === 'partial') {
    actualBody = completeBody.slice(0, Math.max(1, Math.floor(completeBody.length / 2)));
    status = 206;
  }
  const routePath = `/${caseId}`;
  context.http.routes.set(routePath, {
    body: actualBody,
    contentType: 'application/json',
    status,
  });
  const response = await fetch(context.http.urlFor(caseId));
  const responseBody = await response.text();
  return {
    actualState: {
      body_sha256: sha256Bytes(responseBody),
      byte_length: Buffer.byteLength(responseBody),
      content_type: response.headers.get('content-type'),
      status: response.status,
    },
    expectedState: {
      body_sha256: sha256Bytes(completeBody),
      byte_length: Buffer.byteLength(completeBody),
      content_type: 'application/json',
      status: 200,
    },
    target,
  };
}

async function createCase(context, domain, scenario, index, previousReceiptHash) {
  const caseId = `${String(index).padStart(2, '0')}-${domain}-${scenario}`;
  const truth = await acquireDomainTruth(context, domain, scenario, caseId);
  const requestId = `request:${caseId}`;
  const authorizationId = `authorization:${caseId}`;
  const baseMs = FIXTURE_EPOCH_MS + index * 1_000;
  const expectedStateSha256 = sha256Canonical(truth.expectedState);
  const oracleStateSha256 = sha256Canonical(truth.actualState);
  const observedState = scenario === 'false-executor-success'
    ? truth.expectedState
    : truth.actualState;
  const observedAtMs = scenario === 'stale-observation' ? baseMs - 1_000 : baseMs + 300;
  const limitations = [
    'Alpha proof only; production execution paths remain unwired.',
    `Deterministic local ${domain} fixture only.`,
  ];
  const submittedLimitations = scenario === 'limitation-omission'
    ? limitations.slice(0, 1)
    : limitations;
  const request = {
    domain,
    expected_artifact_sha256: stateArtifactHash(domain, truth.expectedState),
    expected_state: truth.expectedState,
    expected_state_sha256: expectedStateSha256,
    request_id: requestId,
    target: truth.target,
  };
  const authorization = {
    authorization_id: authorizationId,
    authorized_at_ms: baseMs + 100,
    granted: true,
    principal: { id: 'operator:outcome-alpha-proof' },
    request_id: requestId,
    scope_sha256: sha256Canonical({
      domain,
      expected_state_sha256: expectedStateSha256,
      target: truth.target,
    }),
  };
  const oracle = {
    artifact_sha256: stateArtifactHash(domain, truth.actualState),
    captured_at_ms: baseMs + 400,
    identity: identity(`oracle:${domain}:v1`, `outcome-alpha-${domain}-raw-state-oracle-v1`),
    request_id: requestId,
    state: truth.actualState,
    state_sha256: oracleStateSha256,
    target: truth.target,
  };
  const observedEffect = {
    artifact_sha256: stateArtifactHash(domain, observedState),
    observed_at_ms: observedAtMs,
    observer_identity: identity(`observer:${domain}:v1`, `outcome-alpha-${domain}-observer-v1`),
    request_id: requestId,
    state: observedState,
    state_sha256: sha256Canonical(observedState),
    target: truth.target,
  };
  const input = {
    authorization,
    executor_attestation: {
      authorization_id: authorizationId,
      claimed_state_sha256: expectedStateSha256,
      claimed_success: true,
      completed_at_ms: baseMs + 200,
      identity: identity(`executor:${domain}:v1`, `outcome-alpha-${domain}-executor-v1`),
      request_id: requestId,
    },
    independent_verifier: {
      effect_satisfied: scenario === 'verifier-disagreement' ? false : true,
      identity: scenario === 'missing-identity'
        ? null
        : identity(`verifier:${domain}:v1`, `outcome-alpha-${domain}-verifier-v1`),
      observed_effect_sha256: sha256Canonical(observedEffect),
      oracle_state_sha256: oracleStateSha256,
      request_id: requestId,
      verified_at_ms: baseMs + 500,
    },
    issued_at: new Date(baseMs).toISOString(),
    limitations,
    max_observation_age_ms: OBSERVATION_MAX_AGE_MS,
    observed_effect: observedEffect,
    public_claim: {
      claim_id: `claim:${caseId}`,
      limitations: submittedLimitations,
      request_id: requestId,
      statement: `The ${domain} outcome for ${caseId} satisfies its requested state.`,
    },
    receipt_id: `outcome-receipt:${caseId}`,
    request,
  };
  const session = new OutcomeReceiptSession(input);
  session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
  if (scenario === 'duplicate-terminal-attempt') {
    session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
  }
  const receipt = session.seal({
    oracle,
    previousReceiptHash,
    sequence: index,
  });
  const verification = verifyOutcomeReceipt(receipt, { expectedPreviousReceiptHash: previousReceiptHash });
  const expectedOutcome = scenario === 'happy-path'
    ? TERMINAL_OUTCOMES.PROVEN
    : TERMINAL_OUTCOMES.REFUSED;
  const requiredRefusal = REQUIRED_REFUSAL[scenario] ?? null;
  return {
    case_id: caseId,
    domain,
    expected_outcome: expectedOutcome,
    passed: verification.ok
      && receipt.terminal_outcome === expectedOutcome
      && (!requiredRefusal || receipt.verification.refusal_codes.includes(requiredRefusal)),
    receipt,
    required_refusal: requiredRefusal,
    scenario,
    verification,
  };
}

function hashSourceFile(filePath) {
  return fs.existsSync(filePath) ? sha256Bytes(fs.readFileSync(filePath)) : null;
}

function countBy(cases, key) {
  return Object.fromEntries(
    [...new Set(cases.map((entry) => entry[key]))]
      .sort()
      .map((value) => [value, cases.filter((entry) => entry[key] === value).length]),
  );
}

function summarizeCase(entry) {
  return {
    case_id: entry.case_id,
    domain: entry.domain,
    oracle_effect_satisfied: entry.receipt.verification.oracle_effect_satisfied,
    previous_receipt_hash: entry.receipt.chain.previous_receipt_hash,
    receipt_hash: entry.receipt.chain.receipt_hash,
    refusal_codes: entry.receipt.verification.refusal_codes,
    result: entry.receipt.terminal_outcome,
    scenario: entry.scenario,
    verified: entry.verification.ok,
  };
}

export async function runOutcomeReceiptAlphaProof({ generatedAt = new Date().toISOString() } = {}) {
  const context = {
    children: [],
    http: await startHttpOracle(),
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-outcome-receipt-')),
  };
  try {
    const cases = [];
    let previousReceiptHash = RECEIPT_GENESIS;
    let index = 0;
    for (const domain of OUTCOME_ALPHA_DOMAINS) {
      for (const scenario of OUTCOME_ALPHA_SCENARIOS) {
        index += 1;
        const entry = await createCase(context, domain, scenario, index, previousReceiptHash);
        cases.push(entry);
        previousReceiptHash = entry.receipt.chain.receipt_hash;
      }
    }

    const summaries = cases.map(summarizeCase);
    const falseSuccessCases = cases.filter((entry) => entry.scenario !== 'happy-path');
    const mismatchCases = cases.filter((entry) => entry.receipt.verification.refusal_codes.length > 0);
    const falseProven = falseSuccessCases.filter(
      (entry) => entry.receipt.terminal_outcome === TERMINAL_OUTCOMES.PROVEN,
    );
    const mismatchesProven = mismatchCases.filter(
      (entry) => entry.receipt.terminal_outcome === TERMINAL_OUTCOMES.PROVEN,
    );
    const sourceArtifacts = {
      '03-BACKEND/outcome-receipt-proof.mjs': hashSourceFile(PROOF_PATH),
      '03-BACKEND/outcome-receipt.mjs': hashSourceFile(MODULE_PATH),
      '03-BACKEND/tests/outcome-receipt.test.mjs': hashSourceFile(TEST_PATH),
    };
    const proofPassed = cases.length >= 30
      && OUTCOME_ALPHA_DOMAINS.every((domain) => cases.some((entry) => entry.domain === domain))
      && OUTCOME_ALPHA_SCENARIOS.every((scenario) => cases.some((entry) => entry.scenario === scenario))
      && cases.every((entry) => entry.passed)
      && falseProven.length === 0
      && mismatchesProven.length === 0
      && Object.values(sourceArtifacts).every((hash) => typeof hash === 'string');
    const limitations = [
      'Alpha proof only; production execution paths remain unwired.',
      'The oracle exercises deterministic local fixtures, not arbitrary external systems.',
      'Identity is content-bound but not backed by production signing keys in this alpha proof.',
    ];
    const proofRequest = {
      acceptance: 'At least 30 deterministic file, process, HTTP, and artifact cases; every mismatch refuses PROVEN.',
      request_id: 'ranked-alpha-3-outcome-receipts',
      scope: [
        '03-BACKEND/outcome-receipt.mjs',
        '03-BACKEND/tests/outcome-receipt.test.mjs',
        '03-BACKEND/outcome-receipt-proof.mjs',
      ],
    };
    const proofAuthorization = {
      authorization_id: 'authorization:ranked-alpha-3-local-proof',
      granted: true,
      principal: { id: 'operator:ranked-alpha-3' },
      production_wiring_allowed: false,
      request_id: proofRequest.request_id,
    };
    const proofExecutor = {
      case_chain_head: previousReceiptHash,
      executed_case_count: cases.length,
      identity: identity('executor:outcome-receipt-proof:v1', '03-BACKEND/outcome-receipt-proof.mjs'),
      request_id: proofRequest.request_id,
    };
    const proofObservation = {
      domain_counts: countBy(cases, 'domain'),
      false_proven_count: falseProven.length,
      mismatch_proven_count: mismatchesProven.length,
      passed_case_count: cases.filter((entry) => entry.passed).length,
      scenario_counts: countBy(cases, 'scenario'),
      total_case_count: cases.length,
    };
    const proofVerifier = {
      all_case_receipts_verified: cases.every((entry) => entry.verification.ok),
      identity: identity('verifier:outcome-receipt-chain:v1', 'outcome-receipt-semantic-and-chain-verifier-v1'),
      independent_from_executor: true,
      request_id: proofRequest.request_id,
    };
    const alphaBody = {
      schema: OUTCOME_ALPHA_PROOF_SCHEMA,
      mode: OUTCOME_RECEIPT_MODE,
      production_wired: false,
      proof_id: 'ranked-alpha-3-outcome-receipts',
      generated_at: generatedAt,
      request: proofRequest,
      authorization: proofAuthorization,
      executor_attestation: proofExecutor,
      observed_effect: proofObservation,
      independent_verifier: proofVerifier,
      artifact_state_hashes: {
        case_index_sha256: sha256Canonical(summaries),
        case_receipt_chain_head_sha256: previousReceiptHash,
        source_artifacts_sha256: sourceArtifacts,
      },
      limitations,
      public_claim: {
        limitations,
        statement: proofPassed
          ? 'Ranked alpha 3 outcome receipts refused PROVEN for every seeded false-success and mismatch path.'
          : 'Ranked alpha 3 outcome receipts are not proven.',
      },
      verification: {
        all_mismatches_refused_proven: mismatchesProven.length === 0,
        all_seeded_false_success_refused_proven: falseProven.length === 0,
        case_chain_verified: cases.every((entry) => entry.verification.ok),
        minimum_case_count_satisfied: cases.length >= 30,
        required_domains_covered: OUTCOME_ALPHA_DOMAINS,
        required_scenarios_covered: OUTCOME_ALPHA_SCENARIOS,
      },
      cases: summaries,
      terminal_outcome: proofPassed ? TERMINAL_OUTCOMES.PROVEN : TERMINAL_OUTCOMES.REFUSED,
    };
    const receipt = chainCanonicalRecord(alphaBody, { previousReceiptHash });
    const receiptVerification = verifyCanonicalRecord(receipt, {
      expectedPreviousReceiptHash: previousReceiptHash,
    });
    const proofOk = proofPassed
      && receiptVerification.ok
      && countTerminalOutcomes(receipt) === 1
      && receipt.terminal_outcome === TERMINAL_OUTCOMES.PROVEN;
    return {
      canonical: canonicalJson(receipt),
      caseReceipts: cases.map((entry) => entry.receipt),
      cases: summaries,
      ok: proofOk,
      receipt,
      receiptVerification,
    };
  } finally {
    for (const child of context.children.reverse()) await stopProcessFixture(child);
    await closeHttpOracle(context.http.server);
    fs.rmSync(context.tempRoot, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  try {
    const proof = await runOutcomeReceiptAlphaProof();
    process.stdout.write(`${proof.canonical}\n`);
    if (!proof.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

