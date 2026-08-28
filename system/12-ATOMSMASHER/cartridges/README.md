# AtomSmasher Module #3 — Cartridges

**Pre-compiled domain capability units. Hot-swappable. Content-addressed. LIVE.**

A cartridge is a self-contained bundle that turns a generic model session into
a domain-competent one in a single load call. It carries a `system_prompt` (the
persona/contract injected into the model's system role), a list of declared
`capabilities` (so the router knows when a cartridge is eligible), and an array
of `tool_cards` (typed tool descriptors the model can call). Cartridges are
inert descriptors — they don't execute anything themselves. Execution is the
gateway's job.

This module follows the same LIVE pattern as Commitment Atoms (Module #1) and
EquationStore (Module #2): a schema in `09-SCHEMAS/`, an encoder/loader and
store here under `12-ATOMSMASHER/cartridges/`, a gateway adapter under
`06-ORANGELLM/server/routes/atomsmasher-cartridges.mjs`, and a smoke test that
exits non-zero on any failure.

## Files

| File | What it does |
| --- | --- |
| `registry.json` | On-disk seed of cartridges. The loader reads it on `init()`. Three cartridges ship by default: `orange5-doctrine`, `ae-cobra-memory`, `orangeeye-visual`. |
| `loader.mjs` | Validator + in-memory loader + hot-swap mutations (`load`, `swap`, `unload`) + atomic `persist()`. Exposes `validateCartridge`, `computeCartridgeId`. |
| `smoke-test.mjs` | End-to-end smoke. Validator unit checks, init from seed, list/describe, load/swap/unload, persist + re-load round-trip, malformed-registry refusal, content-addressed id determinism. **56/56 green** as of authoring. |
| `README.md` | This file. |

## Cartridge shape

```jsonc
{
  "schema": "orange5.atomsmasher.cartridge.v0",
  "name": "orange5-doctrine",                 // ^[a-z][a-z0-9-]*[a-z0-9]$
  "version": "0.1.0",                          // semver
  "summary": "One-line human description.",
  "capabilities": [                            // ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$
    "doctrine.recall",
    "release.gate"
  ],
  "system_prompt": "You operate under AtomEons doctrine ...",
  "tool_cards": [
    {
      "name": "cite_doctrine",                 // ^[a-z][a-z0-9_]*$, unique within cartridge
      "description": "Quote an AtomEons clause by file + line range.",
      "input_schema": { "type": "object", "required": ["file", "lines"], "properties": { ... } }
    }
  ],
  "tags": ["doctrine", "operator-facing"]      // optional
}
```

## Content addressing

`cartridge_id = sha256(canonical({name, version, capabilities, system_prompt, tool_cards}))`

The id is **derived**, never stored on disk. Two callers seeding the same
cartridge content arrive at the same id, so downstream consumers can prove
which cartridge they used by quoting the id back. Key-insertion order in the
JSON is irrelevant — `canonicalStringify` sorts keys at every depth.

`tags` and `summary` are intentionally **excluded** from the id so a curator
can refine human-facing metadata without churning the id.

## Hot-swap semantics

- `load(c)` — insert a new cartridge. **Rejects** if `name` already exists.
- `swap(c, {expected_version})` — replace existing cartridge under same name.
  Rejects if the cartridge isn't loaded, if `expected_version` doesn't match
  current, or if the new version isn't strictly different (no in-place same-
  version edits).
- `unload(name)` — remove from in-memory table. Rejects if not loaded.
- `persist()` — atomically rewrite `registry.json` from the current in-memory
  state. Uses tempfile + fsync + rename, so the on-disk file is always a
  valid, complete snapshot.

Every mutation emits an `event` (`'loaded'|'swapped'|'unloaded'|'persisted'`)
on the loader's `EventEmitter` so a sidecar can keep a Commitment Atom or a
Saved Work Certificate chain in sync.

## Gateway surface

The HTTP adapter lives at
`06-ORANGELLM/server/routes/atomsmasher-cartridges.mjs`. Five routes under
`/v1/atomsmasher/cartridges`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/v1/atomsmasher/cartridges` | List loaded cartridges (summaries, no full prompt body). |
| `GET`  | `/v1/atomsmasher/cartridges/:name` | Describe one cartridge (full prompt + tool_cards). |
| `POST` | `/v1/atomsmasher/cartridges/load` | Load OR swap a cartridge. Body: `{cartridge, expected_version?, persist?}`. |
| `POST` | `/v1/atomsmasher/cartridges/:name/unload` | Unload by name. |
| `POST` | `/v1/atomsmasher/cartridges/persist` | Rewrite `registry.json` from current in-memory state. |

`POST /load` is the primary hot-swap entry point named in the AtomSmasher
spec. It chooses `load` vs `swap` based on whether `name` is already known:
new name → `load`; known name → `swap` (with `expected_version` honored as
compare-and-set).

## Mom's Law

Every code path that touches a cartridge returns a structured result with a
real error message on failure. No silent rejects. No theatrical successes.
The smoke test asserts every negative case (`load` on existing name, `swap`
without bump, malformed registry, bad name pattern, duplicate tool name)
**fails the way it's supposed to**, not "looks_ok / probably / should_work."

## Running the smoke

```bash
node 12-ATOMSMASHER/cartridges/smoke-test.mjs
```

Exits `0` on green, non-zero on any failed check. No test framework
dependency.

## Honest gaps

Things this module deliberately does **not** do (yet):

- **No execution.** `tool_cards[].input_schema` is a descriptor, not a
  callable. The tool-runner lives elsewhere and consumes these descriptors.
- **No version history.** `swap()` overwrites the in-memory entry; there's no
  Reality-lane append-only log of cartridge mutations. If you need an audit
  trail, subscribe to the loader's `event` emitter and mint a Commitment Atom
  per event (the natural pairing).
- **No signature on the cartridge itself.** `cartridge_id` proves content,
  but there's no operator signature claiming "I, Atom McCree, sanctioned this
  cartridge." That belongs in a sibling Saved Work Certificate (Module #8).
- **No capability conflict resolution.** Two loaded cartridges may both claim
  `memory.read`; the router picks. We don't enforce uniqueness on
  capabilities across cartridges by design — capability negotiation is the
  Least-action Router's job (Module #5).
