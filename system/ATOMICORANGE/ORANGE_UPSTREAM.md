# Atomic Orange V1

Atomic Orange is the OrangeFive edition of Atomic Chat.

- Upstream: `AtomicBot-ai/Atomic-Chat`
- Upstream tag: `v2.0.23`
- Upstream commit: `9097a05f33e43156ab48278e1e619f4faaa95dd2`
- Imported: `2026-08-25`
- Orange runtime: `C:\\AtomEons\\Orange5`
- Only chat provider: `http://127.0.0.1:1337/v1` (`orangebrain`)

The fork preserves Atomic Chat's native shell, local-model engines, projects,
MCP support, artifacts, agent launchers, and future upstream path. Orange adds
the mandatory model crossing: every chat turn goes through OrangeBrain before
any model output reaches the operator.

Do not rename legacy `jan*` internal identifiers. They remain migration and
extension contracts. User-facing product identity is Atomic Orange.
