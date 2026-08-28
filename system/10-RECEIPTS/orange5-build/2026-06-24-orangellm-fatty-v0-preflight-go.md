# Receipt — OrangeLLM-fatty v0 Pre-flight Synthesis

- **Receipt ID:** 2026-06-24-orangellm-fatty-v0-preflight-go
- **Generated at:** 2026-06-24
- **Schema:** orange5.receipt.v0
- **Actor:** Claude / orangellm-fatty-v0-preflight workflow
- **Status:** GO
- **Confidence:** 0.97
- **Sovereign:** Atom McCree
- **Prior receipt:** 2026-06-24-colab-notebook-gist-published (hash chain #015)
- **Hash chain position:** 16

---

## Purpose

Synthesize three independent verifier reports (integrity, quality, safety) on the
OrangeLLM-fatty v0 training corpus and Colab notebook surface, and emit a single
GO/BLOCK pre-flight decision before the operator launches the QLoRA fine-tune on
`Qwen/Qwen3-30B-A3B-Instruct` in Colab Pro A100.

---

## Verifier 1 — Integrity

| Field | Value |
|---|---|
| corpus_lines | 1000 |
| corpus_sha256_actual | 6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f |
| corpus_sha256_matches | true |
| malformed_lines | 0 |
| missing_fields_count | 0 |
| yaml_parses | true |
| yaml_base_model | Qwen/Qwen3-30B-A3B-Instruct |
| yaml_lora_r | 16 |
| yaml_dataset_path | /content/drive/MyDrive/orangellm-fatty-v0/corpus.jsonl |
| notebook_parses | true |
| notebook_cell_count | 16 |
| notebook_has_drive_mount | true |
| notebook_has_axolotl_install | true |
| notebook_has_train_cell | true |
| gist_url | https://gist.github.com/AtomEons/a1e6b4a3349b3239eb3aabcf56a789ed |
| gist_http_status | 200 |
| gist_live | true |
| **verdict** | **pass** |
| failures | [] |

---

## Verifier 2 — Quality

| Field | Value |
|---|---|
| sampled_count | 50 |
| avg_instruction_chars | 43 |
| avg_output_chars | 199 |
| fake_green_hits | 0 (regex 4, all false positives — teaching the forbidden-word list) |
| no_orange5_concept_hits | 99 / 1000 (9.9% — generic doctrine pairs, acceptable) |
| contradictions_with_doctrine | 0 (regex 2, both false positives in negation context) |
| instruction_diversity_score | 0.85 |
| output_grounding_score | 0.90 |
| overall_quality_grade | **A** |
| **verdict** | **pass** |

**Notes (verbatim from quality auditor):** Stratified seed=42 sample across 0–333, 333–666, 666–1000.
10 distinct instruction starters; 'what' dominates at 60% (honest 0.85 cap).
45/50 outputs cite specific doctrine anchors — ports 1337/8797/11434/8097/7419/6333, qwen3,
Codexa, N150, OrangeLLM, Mom's Law, Frontier-Isolation, hash chain, receipts, ColPali, Æ Cobra.
Truth anchors (1-tier locked, Smart Skinny retired, frontier-isolation at :1337) verified
consistent. Corpus is training-ready for OrangeLLM-fatty v0 QLoRA on qwen3:30b-a3b.

---

## Verifier 3 — Safety

| Field | Value |
|---|---|
| pii_emails_found | 0 (regex 1 was '128x128@2x.png' — Apple icon filename, excluded) |
| pii_phones_found | 0 |
| api_keys_found | 0 |
| api_keys_redacted_only | 0 |
| private_paths_leaked | 0 |
| private_paths_examples | [] |
| secrets_strings_found | 0 |
| operator_real_name_count | 15 (intentional doctrine identity — acceptable) |
| operator_real_email_count | 0 |
| **verdict** | **pass** |

**Notes:** Corpus is clean to publish-train. Operator's email `a.mccree@gmail.com` does not appear.
Operator's identity ('Atom McCree' / 'Ætom ÆoNs') appears 15 times by design — this is an
operator-aligned model and identity grounding is doctrine, not leakage.

---

## Final verdict: **GO**

**Reasoning:**

- Integrity: PASS. SHA-256 of corpus matches expected. 1000/1000 JSONL pairs valid.
  YAML parses with correct base model, LoRA r=16, and Drive dataset path. Notebook parses,
  16 cells, has Drive mount + axolotl install + train cell. Gist is live (HTTP 200).
- Quality: PASS, Grade A. Zero real fake-green emissions. Zero real doctrine contradictions.
  Strong grounding (0.90). Diverse instruction openings (0.85, honestly capped for 'what' skew).
  Substantive outputs (avg 199 chars).
- Safety: PASS. Zero PII, zero API keys, zero private path leaks, zero secrets. Operator
  identity grounding is intentional and bounded.

All three verifiers pass cleanly. No safety concerns. No quality grade below A. No failures.
The pre-flight is GO.

### Failures

(none)

### Warnings

- Instruction-opener distribution skews toward 'what' (60%). Honest, not blocking — Grade A
  was awarded with this skew openly priced in (0.85 not 1.0).
- 9.9% of pairs (99/1000) lack Orange5 concept keywords; these are generic doctrine pairs
  (Mom's Law philosophy, receipt format, completion law). Acceptable — they teach the
  meta-doctrine, not the surface vocabulary.
- Operator real name appears 15× by design. If this model is ever distributed beyond the
  Sovereign's own runtime, scrub before release. For local use: intentional and clean.

---

## Operator action block (GO path)

1. Open the Colab gist:
   **https://gist.github.com/AtomEons/a1e6b4a3349b3239eb3aabcf56a789ed**
2. Click **Open in Colab** (or paste the gist into a fresh Colab notebook).
3. **Runtime → Change runtime type → A100 GPU** (Colab Pro / Pro+ required).
4. Upload to your Google Drive at `MyDrive/orangellm-fatty-v0/`:
   - `corpus.jsonl` (SHA-256: `6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f`)
   - the axolotl YAML (base model `Qwen/Qwen3-30B-A3B-Instruct`, LoRA r=16)
5. **Runtime → Run all.** First cell mounts Drive; axolotl installs; training begins.
6. When training completes, download the LoRA adapter and stage in
   `C:/AtomEons/Orange5/16-TRAINING/adapters/orangellm-fatty-v0/`.
7. Emit the next receipt (chain #17): `2026-06-24-orangellm-fatty-v0-trained.md`.

---

## Rollback

To roll back this pre-flight decision:
- Delete this receipt file:
  `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-24-orangellm-fatty-v0-preflight-go.md`
- No other state changes. Corpus, YAML, notebook, and gist are unmodified by this synthesis.
- The hash chain at #16 is vacated; the next attempt re-occupies #16 against the same
  prior receipt (#015, `2026-06-24-colab-notebook-gist-published`).

---

## Mom's Law alignment

Full effort, every line. Three independent verifiers were each given honest scope and each
returned honest findings, including disclosing their own false-positive regex hits rather
than hiding them. The 'what' instruction skew was priced into the diversity score honestly
(0.85, not 1.0). The 9.9% non-keyword pairs were explained, not buried. The 15 operator-name
occurrences were called out and explained as intentional, not silently passed. No theater,
no fake green. Receipt has its evidence; the gist is live; the corpus hash matches.
Mom would sign this.

---

## Hash chain footer

- **Chain position:** 16
- **Prior:** 2026-06-24-colab-notebook-gist-published (#015)
- **This:** 2026-06-24-orangellm-fatty-v0-preflight-go (#016)
- **Next (expected):** 2026-06-24-orangellm-fatty-v0-trained (#017) — emitted after Colab run completes
- **Corpus SHA-256 anchor:** 6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f
- **Gist URL anchor:** https://gist.github.com/AtomEons/a1e6b4a3349b3239eb3aabcf56a789ed
- **Schema:** orange5.receipt.v0
- **Sovereign:** Atom McCree
