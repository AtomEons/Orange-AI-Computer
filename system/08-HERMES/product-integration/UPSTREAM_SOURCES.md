# Upstream Sources

Pinned product:

- Hermes Agent 0.20.5
- tag `v2026.8.19`
- commit `fcbd1076a93841fa88855acce810e342a5b78101`
- repository: https://github.com/NousResearch/hermes-agent

Primary references used:

- Release: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19
- Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles/
- Multi-profile gateway: https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways/
- Kanban: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban/
- MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/
- API server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- Providers: https://hermes-agent.nousresearch.com/docs/integrations/providers/
- Toolsets: https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference/

Pinned operational guards:

- The release metadata is not treated as immutable authority and the annotated tag
  is not relied upon as a signature. Installation verifies the exact Git commit and
  requires the upstream `uv.lock` through `uv sync --locked`.

- Set both `gateway.multiplex_profiles: true` and
  `GATEWAY_MULTIPLEX_PROFILES=true`. This prevents container supervisors from
  starting named-profile gateway slots beside the multiplexer on affected builds.
- Never run `hermes -p <name> gateway start` for a named profile in this pack.
- Keep `platforms.api_server.enabled: false` in every named profile. The
  profile-specific API key still authenticates `/p/<profile>/...` on the
  owner's shared listener; without the explicit false, Hermes 0.20.5 treats
  the key as a request for another listener and skips that profile.
- Never use `/model --global` from a secondary profile. Change the profile's
  managed template and rematerialize instead, preserving the owner's multiplex config.
- Profiles isolate Hermes state but are not operating-system sandboxes. This pack
  scopes capability through toolsets and Orange MCP; Builder is the only profile
  with Hermes debugging/file mutation tools.
