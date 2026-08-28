# Orange5 — Repair Queue

When a service or test goes red, the repair lands here. Each entry has a fix command + receipt path.

## How to use

```powershell
# Run the full Orange5 verifier (see 00-CHARTER/run-all-tests.ps1)
powershell -ExecutionPolicy Bypass -File C:/AtomEons/Orange5/00-CHARTER/run-all-tests.ps1
```

Anything red goes in this file with:
- entry timestamp
- failed component
- error excerpt
- fix command
- post-fix receipt

---

## Current entries

### 2026-06-24 — Colab notebook v0 install cell pinned torch (Mom's Law violation by Opus)

**Component:** `16-TRAINING/configs/orangellm-fatty-v0.ipynb` (initial author)

**Error:**
```
RuntimeError: operator torchvision::nms does not exist
ModuleNotFoundError: BloomPreTrainedModel
axolotl 0.17.0.dev0 requires torch>=2.9.1, but you have torch 2.4.1+cu121
```

**Root cause:** Pinned `torch==2.4.1+cu121` while Axolotl main needed `torch>=2.9.1`. Authored blind without Colab dry-run.

**Fix:** Rip Axolotl out, switch to Unsloth, remove torch pin entirely, use Colab default torch + install Unsloth on top.

**Receipt:** `10-RECEIPTS/orange5-build/2026-06-25-orangellm-fatty-v0-adapter-landed.md` (#025) — the eventual successful v0 train
**Lesson memory:** `feedback_colab_torch_pins.md`

---

### 2026-06-25 — Colab notebook v1 A100 `sys.modules.pop` torch reload (Mom's Law violation by Opus)

**Component:** `16-TRAINING/configs/orangellm-fatty-v1-a100.ipynb` (gist `63f45f759da773aa84307123373f4b48`)

**Error:**
```
RuntimeError: function '_has_torch_function' already has a docstring
```

**Root cause:** GPU-verify cell imported `torch` BEFORE the Unsloth install cell. After install changed torch's `.so` files, `sys.modules.pop` + re-import tried to re-register C-level docstrings → collision. Operator burned ~10 min of A100 time. Combined with v0 burn, operator called out 6 hours of bad craftsmanship.

**Fix:** Re-order cells so install is first; first-and-only `import torch` happens AFTER install; remove all `sys.modules.pop` dances; add header note instructing operator to "Runtime → Disconnect and delete runtime" for recovery.

**Receipt:** in-conversation patched gist (same Colab URL)
**Lesson memory:** `feedback_six_hours_burned_be_better.md` (8-rule Colab discipline locked, read on every session open)

---

## Pattern

```markdown
### 2026-06-XX HH:MM — <component>

**Error:**
\`\`\`
<paste>
\`\`\`

**Fix:**
\`\`\`bash
<command>
\`\`\`

**Receipt:** `10-RECEIPTS/orange5-build/<ts>-repair-<component>.md`
```

---

**Mom is watching. Repairs land here, not in slack threads.**
