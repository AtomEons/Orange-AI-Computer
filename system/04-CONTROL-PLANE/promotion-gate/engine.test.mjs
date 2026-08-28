// Tests for promotion-gate engine.mjs
// Run: node --test C:/AtomEons/Orange5/04-CONTROL-PLANE/promotion-gate/engine.test.mjs
//
// No external deps. Uses node:test + node:assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import decide, {
  evaluateBakeoff,
  findFakeGreen,
  verifyReceipt,
  verifyCLRK5,
  BAKEOFF_DIMENSIONS,
  BAKEOFF_WIN_THRESHOLD,
  CLR_K5_K,
  CLR_K5_THRESHOLD,
} from "./engine.mjs";

// ---------- fixture helpers ----------

function makeReceipt(contents = { ok: true, ts: Date.now() }) {
  const dir = mkdtempSync(join(tmpdir(), "promo-gate-"));
  const path = join(dir, "receipt.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fullBakeoff({ candidate = 0.9, baseline = 0.5 } = {}) {
  const cand = {}, base = {};
  for (const dim of BAKEOFF_DIMENSIONS) {
    cand[dim] = candidate;
    base[dim] = baseline;
  }
  return { candidate: cand, baseline: base };
}

function goodOpts(overrides = {}) {
  const r = makeReceipt();
  return {
    _cleanup: r.cleanup,
    opts: {
      receipt_path: r.path,
      bakeoff: fullBakeoff(),
      status: "green",
      risk_level: "low",
      operator_approved: false,
      candidate_text: "all checks passed",
      ...overrides,
    },
  };
}

// ---------- top-level happy path ----------

test("happy path promotes", () => {
  const g = goodOpts();
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "promote");
    assert.match(out.reason, /bakeoff 5\/5/);
  } finally {
    g._cleanup();
  }
});

test("high risk without operator_approved holds", () => {
  const g = goodOpts({ risk_level: "production" });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /operator_approved=true/);
  } finally {
    g._cleanup();
  }
});

test("high risk WITH operator_approved promotes", () => {
  const g = goodOpts({ risk_level: "production", operator_approved: true });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "promote");
    assert.match(out.reason, /operator_approved/);
  } finally {
    g._cleanup();
  }
});

test("destructive risk also gated", () => {
  const g = goodOpts({ risk_level: "destructive" });
  try {
    assert.equal(decide(g.opts).decision, "hold");
  } finally {
    g._cleanup();
  }
});

// ---------- fake-green rejection ----------

test("fake-green word in candidate_text rejects", () => {
  const g = goodOpts({ candidate_text: "LGTM, ship it." });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "reject");
    assert.match(out.reason, /fake-green/);
  } finally {
    g._cleanup();
  }
});

test("fake-green phrase 'good enough' rejects", () => {
  const g = goodOpts({ candidate_text: "this is good enough for now" });
  try {
    assert.equal(decide(g.opts).decision, "reject");
  } finally {
    g._cleanup();
  }
});

test("clean text passes fake-green check", () => {
  assert.equal(findFakeGreen("All 30 tests green; SHA-256 receipt attached."), null);
});

test("yolo as substring of larger word does not trigger", () => {
  // 'yolocoaster' should not match 'yolo' (word-ish boundary).
  assert.equal(findFakeGreen("the yolocoaster project"), null);
});

// ---------- reject statuses ----------

for (const bad of ["failed", "error", "regressed", "broken"]) {
  test(`status=${bad} rejects`, () => {
    const g = goodOpts({ status: bad });
    try {
      const out = decide(g.opts);
      assert.equal(out.decision, "reject");
      assert.match(out.reason, new RegExp(bad));
    } finally {
      g._cleanup();
    }
  });
}

// ---------- hold statuses ----------

for (const amb of ["unknown", "pending", "partial"]) {
  test(`status=${amb} holds`, () => {
    const g = goodOpts({ status: amb });
    try {
      assert.equal(decide(g.opts).decision, "hold");
    } finally {
      g._cleanup();
    }
  });
}

test("status missing holds", () => {
  const g = goodOpts({ status: undefined });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /status missing/);
  } finally {
    g._cleanup();
  }
});

// ---------- receipt missing / bad ----------

test("missing receipt_path holds", () => {
  const g = goodOpts({ receipt_path: undefined });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /receipt/);
  } finally {
    g._cleanup();
  }
});

test("nonexistent receipt_path holds", () => {
  const g = goodOpts({ receipt_path: "C:/__nope__/no-such-receipt.json" });
  try {
    assert.equal(decide(g.opts).decision, "hold");
  } finally {
    g._cleanup();
  }
});

test("malformed JSON receipt holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "promo-gate-bad-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{not json", "utf8");
  const out = decide({
    receipt_path: path,
    bakeoff: fullBakeoff(),
    status: "green",
    risk_level: "low",
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.decision, "hold");
  assert.match(out.reason, /invalid JSON/);
});

// ---------- bakeoff ----------

test("missing bakeoff holds", () => {
  const g = goodOpts({ bakeoff: undefined });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /bakeoff missing/);
  } finally {
    g._cleanup();
  }
});

test("bakeoff: 5/5 wins promotes", () => {
  const g = goodOpts({ bakeoff: fullBakeoff({ candidate: 0.8, baseline: 0.5 }) });
  try {
    assert.equal(decide(g.opts).decision, "promote");
  } finally {
    g._cleanup();
  }
});

test("bakeoff: 4/5 wins promotes (threshold met)", () => {
  const bk = fullBakeoff({ candidate: 0.9, baseline: 0.5 });
  // tie on one dimension -> not a win
  bk.candidate.refusal_discipline = 0.5;
  bk.baseline.refusal_discipline = 0.5;
  const g = goodOpts({ bakeoff: bk });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "promote");
    assert.equal(out.details.bakeoff.wins, BAKEOFF_WIN_THRESHOLD);
  } finally {
    g._cleanup();
  }
});

test("bakeoff: 3/5 wins rejects", () => {
  const bk = fullBakeoff({ candidate: 0.9, baseline: 0.5 });
  bk.candidate.refusal_discipline = 0.1;
  bk.candidate.receipt_grounding = 0.1;
  const g = goodOpts({ bakeoff: bk });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "reject");
    assert.match(out.reason, /bakeoff: candidate won 3\/5/);
  } finally {
    g._cleanup();
  }
});

test("bakeoff: missing dimension is invalid -> hold", () => {
  const bk = fullBakeoff();
  delete bk.candidate.mission_shape;
  const g = goodOpts({ bakeoff: bk });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /bakeoff invalid/);
  } finally {
    g._cleanup();
  }
});

test("bakeoff: out-of-range score is invalid -> hold", () => {
  const bk = fullBakeoff();
  bk.candidate.mission_shape = 1.5;
  const g = goodOpts({ bakeoff: bk });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "hold");
    assert.match(out.reason, /bakeoff invalid/);
  } finally {
    g._cleanup();
  }
});

// ---------- risk_level ----------

test("missing risk_level holds", () => {
  const g = goodOpts({ risk_level: undefined });
  try {
    assert.equal(decide(g.opts).decision, "hold");
  } finally {
    g._cleanup();
  }
});

test("invalid risk_level holds", () => {
  const g = goodOpts({ risk_level: "nuclear" });
  try {
    assert.equal(decide(g.opts).decision, "hold");
  } finally {
    g._cleanup();
  }
});

// ---------- CLR-K5 ----------

test("CLR-K5 absent does not block promotion", () => {
  const g = goodOpts();
  try {
    assert.equal(decide(g.opts).decision, "promote");
  } finally {
    g._cleanup();
  }
});

test("CLR-K5 wrong k rejects", () => {
  const g = goodOpts({ clr: { k: 1, score: 0.9 } });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "reject");
    assert.match(out.reason, /CLR-K5/);
  } finally {
    g._cleanup();
  }
});

test("CLR-K5 below threshold rejects", () => {
  const g = goodOpts({ clr: { k: CLR_K5_K, score: CLR_K5_THRESHOLD - 0.01 } });
  try {
    const out = decide(g.opts);
    assert.equal(out.decision, "reject");
    assert.match(out.reason, /below threshold/);
  } finally {
    g._cleanup();
  }
});

test("CLR-K5 at threshold promotes", () => {
  const g = goodOpts({ clr: { k: CLR_K5_K, score: CLR_K5_THRESHOLD } });
  try {
    assert.equal(decide(g.opts).decision, "promote");
  } finally {
    g._cleanup();
  }
});

// ---------- sub-check direct tests ----------

test("verifyReceipt: empty path", () => {
  assert.equal(verifyReceipt("").ok, false);
});

test("verifyCLRK5: rejects non-object", () => {
  assert.equal(verifyCLRK5(null).ok, false);
  assert.equal(verifyCLRK5("nope").ok, false);
});

test("evaluateBakeoff: well-formed scores", () => {
  const r = evaluateBakeoff(fullBakeoff({ candidate: 0.7, baseline: 0.6 }));
  assert.equal(r.wins, 5);
  assert.deepEqual(r.losses, []);
});

test("decide: bad opts shape rejects", () => {
  assert.equal(decide(null).decision, "reject");
  assert.equal(decide("string").decision, "reject");
});

// ---------- precedence: fake-green beats everything ----------

test("fake-green is checked before status", () => {
  const out = decide({
    candidate_text: "yolo",
    status: "green",
    risk_level: "low",
  });
  assert.equal(out.decision, "reject");
  assert.match(out.reason, /fake-green/);
});

test("reject-status is checked before receipt", () => {
  // no receipt, no bakeoff, but status=failed should still reject (not hold)
  const out = decide({ status: "failed", risk_level: "low" });
  assert.equal(out.decision, "reject");
});
