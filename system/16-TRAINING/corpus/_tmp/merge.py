#!/usr/bin/env python3
"""Merge seed + generated corpus pairs for OrangeLLM-fatty v0."""
import json
import re
import hashlib
import datetime
import sys
from pathlib import Path

CORPUS_DIR = Path(__file__).resolve().parents[1]
SEED_PATH = CORPUS_DIR / "orangellm-fatty-v0-seed-200.jsonl"
TMP_DIR = CORPUS_DIR / "_tmp"
FINAL_PATH = CORPUS_DIR / "orangellm-fatty-v0-corpus-1000.jsonl"
STAGED_PATH = CORPUS_DIR / "corpus.jsonl"
RECEIPT_PATH = CORPUS_DIR / "orangellm-fatty-v0-corpus-receipt.json"

TEMP_FILES = [
    "master-plan.jsonl",
    "ae-cobra-spec.jsonl",
    "orangeeye-spec.jsonl",
    "month-plan.jsonl",
    "codex-brief.jsonl",
    "colab-pattern.jsonl",
    "codexa-preflight.jsonl",
    "naming-canon.jsonl",
    "not-green-ledger.jsonl",
    "receipts-chain.jsonl",
]

CONCEPTS = [
    # Core platform names
    "orange5", "orangellm", "atomic orange", "ae cobra", "orangeeye",
    "hermes", "mirage", "atomsmasher", "toolmesh", "codexa", "n150",
    "mom's law", "moms law", "frontier-isolation", "frontier isolation",
    "codeless", "gateway", "qwen3", "flux", "schism", "mamba",
    "colpali", "qdrant",
    # Operator + lab
    "atom mccree", "atomeons", "sovereign", "marco island",
    # Orange5 doctrine surfaces (per master plan + receipts chain)
    "cockpit", "vault", "receipt", "receipts", "lane 1", "lane 2", "lane 3", "lane 4",
    "atom standard", "ae misfit", "misfit model", "ae0", "ae factory", "orange trail",
    "four pillars", "four laws", "master plan", "spec locked",
    "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4",
    # Other in-corpus canonical terms
    "operator os", "operator-os", "free, local-first", "local-first",
    "fatty", "skinny", "tofu", "not_green", "not-green",
    "colab", "t4", "lora", "qlora",
    "stargate", "skill.ski", "skilski",
    "ae-code", "aecode", "aer", "openclaw", "black mamba",
    "spiral reasoning", "knowledge strata", "pathwaves",
    # Architecture surfaces from generated corpus
    "ae flow", "flowstate", "currents", "governors", "headwaters", "channels",
    "aesee", "trinity interface", "bioluminescent",
    "strongarm", "gremlin", "byok", "byo-key", "byo key",
    "glm-4.6", "glm frontier", "minimax", "kimi", "deepseek",
    "loopback", "127.0.0.1",
    "orangebox", "orange-box", "orangebox-data",
    "voice lane", "mobile companion", "antigravity",
    "rule of one", "rule of free", "rule of receipts", "rule of taste",
    "four pillars", "four laws",
    "read mount", "write mount", "mirage mount",
    "fatty model", "skinny model", "tofu model",
    "training corpus", "instruction pair",
]

FAKE_GREEN = ["green_assumed", "looks_ok", "probably", "should_work", "fake_green"]


def normalize_key(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def load_jsonl(p: Path):
    out = []
    bad = 0
    with open(p, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                out.append(obj)
            except Exception as e:
                bad += 1
                print(f"  bad line {i} in {p.name}: {e}", file=sys.stderr)
    return out, bad


def valid_pair(p: dict) -> tuple[bool, str]:
    if not isinstance(p, dict):
        return False, "not dict"
    instr = p.get("instruction", "")
    out = p.get("output", "")
    if not isinstance(instr, str) or not instr.strip():
        return False, "empty instruction"
    if not isinstance(out, str) or len(out) < 30:
        return False, "output<30"
    out_lower = out.lower()
    # Concept check spans instruction + output: the question often anchors
    # the Orange5 context ("What is the RAM ceiling for AE Cobra?") and the
    # answer is technical detail. Both halves together must hit doctrine.
    combined = (instr + " " + out).lower()
    if not any(c in combined for c in CONCEPTS):
        return False, "no Orange5 concept"
    for fg in FAKE_GREEN:
        if fg in out_lower:
            return False, f"fake-green:{fg}"
    return True, "ok"


def main():
    # Step 1: seed
    seed, seed_bad = load_jsonl(SEED_PATH)
    print(f"Seed loaded: {len(seed)} (bad lines: {seed_bad})")

    merged = []
    seen_keys = set()
    for s in seed:
        # Normalize structure
        pair = {
            "instruction": s.get("instruction", ""),
            "input": s.get("input", ""),
            "output": s.get("output", ""),
        }
        merged.append(pair)
        seen_keys.add(normalize_key(pair["instruction"]))

    print(f"Seed merged (canonical): {len(merged)}")

    # Step 2: generated
    generated_count = 0
    dropped_dup = 0
    dropped_invalid = 0
    dropped_reasons = {}

    # First pass: count every generated pair from every temp file (truthful total)
    all_generated = []
    for fname in TEMP_FILES:
        p = TMP_DIR / fname
        if not p.exists():
            print(f"  MISSING: {p}", file=sys.stderr)
            continue
        gens, bad = load_jsonl(p)
        print(f"  {fname}: {len(gens)} pairs (bad: {bad})")
        for g in gens:
            all_generated.append((fname, g))
    generated_count = len(all_generated)
    print(f"Total generated pairs across all temp files: {generated_count}")

    # Second pass: validate, dedupe, consume in order until 1000
    full_capacity = False
    for fname, g in all_generated:
        pair = {
            "instruction": g.get("instruction", ""),
            "input": g.get("input", ""),
            "output": g.get("output", ""),
        }
        ok, reason = valid_pair(pair)
        if not ok:
            dropped_invalid += 1
            dropped_reasons[reason] = dropped_reasons.get(reason, 0) + 1
            continue
        key = normalize_key(pair["instruction"])
        if key in seen_keys:
            dropped_dup += 1
            continue
        if len(merged) >= 1000:
            # Capacity reached; remaining valid+unique pairs are simply not consumed
            full_capacity = True
            continue
        seen_keys.add(key)
        merged.append(pair)
    if full_capacity:
        print("  reached 1000 — remaining valid pairs not consumed.")

    print(f"Generated total seen: {generated_count}")
    print(f"Dropped dup: {dropped_dup}")
    print(f"Dropped invalid: {dropped_invalid}  reasons: {dropped_reasons}")
    print(f"Final merged length: {len(merged)}")

    # Truncate to 1000 just in case
    if len(merged) > 1000:
        merged = merged[:1000]

    # Step 6: write final JSONL with LF endings
    buf = []
    for pair in merged:
        buf.append(json.dumps(pair, ensure_ascii=False))
    content = "\n".join(buf) + "\n"
    content_bytes = content.encode("utf-8")

    with open(FINAL_PATH, "wb") as f:
        f.write(content_bytes)
    with open(STAGED_PATH, "wb") as f:
        f.write(content_bytes)

    sha = hashlib.sha256(content_bytes).hexdigest()
    print(f"SHA-256: {sha}")
    print(f"Wrote: {FINAL_PATH}  ({len(content_bytes)} bytes)")
    print(f"Wrote: {STAGED_PATH}")

    # Verify
    with open(FINAL_PATH, "r", encoding="utf-8") as f:
        verify_count = sum(1 for line in f if line.strip())
    print(f"Verify line count: {verify_count}")

    # Receipt
    receipt = {
        "schema": "orange5.corpus-receipt.v0",
        "model": "orangellm-fatty-v0",
        "corpus_path": str(FINAL_PATH).replace("\\", "/"),
        "staged_path": str(STAGED_PATH).replace("\\", "/"),
        "seed_path": str(SEED_PATH).replace("\\", "/"),
        "seed_count": len(seed),
        "generated_count": generated_count,
        "deduped_count": dropped_dup + dropped_invalid,
        "dropped_dup": dropped_dup,
        "dropped_invalid": dropped_invalid,
        "dropped_reasons": dropped_reasons,
        "final_count": len(merged),
        "verify_line_count": verify_count,
        "target": 1000,
        "corpus_sha256": sha,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "doctrine_files": [
            "master-plan", "ae-cobra-spec", "orangeeye-spec", "month-plan",
            "codex-brief", "colab-pattern", "codexa-preflight",
            "naming-canon", "not-green-ledger", "receipts-chain"
        ],
        "method": "workflow-parallel-claude-agents",
    }
    with open(RECEIPT_PATH, "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2)
    print(f"Wrote receipt: {RECEIPT_PATH}")

    # Final summary line for orchestrator
    print(f"\nFINAL|seed={len(seed)}|generated={generated_count}|deduped={dropped_dup+dropped_invalid}|final={len(merged)}|sha={sha}")


if __name__ == "__main__":
    main()
