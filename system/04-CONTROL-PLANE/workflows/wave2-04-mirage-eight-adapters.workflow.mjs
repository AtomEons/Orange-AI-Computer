// wave2-04-mirage-eight-adapters.workflow.mjs — promote 8 STUB Mirage adapters to READY.

export const meta = { name: 'wave2-04-mirage-eight-adapters', description: '8 Mirage adapters STUB → READY', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, adapters_wired: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'adapters_wired', 'receipt_path'], additionalProperties: false }

const CTX = `
Mirage adapter discipline (read 11-MIRAGE/adapters/flux.mjs for the READY-adapter pattern):
- Each adapter exports {read, write, healthz}
- Real client lib + auth env vars (operator brings creds)
- writes_require_approval=true (data-plane mounts): write() must call Hermes /v1/hermes/lease before mutating
- read() can proceed without approval (read-only is safe)
- All loopback unless the adapter NEEDS external (postgres external = OK, gmail = OK)
- Honest stubs in healthz when creds missing (not throws)
- Tests at 11-MIRAGE/tests/<name>.test.mjs
`

phase('Author')
const adapters = [
  { id: 'postgres', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/postgres.mjs with the pg npm client. Auth: ATOMEONS_PG_URL env. Read: query(sql, params), schema(table), list_tables(). Write: insert/update/delete via Hermes lease. Healthz: SELECT 1. Migrate from STUB. ${CTX}` },
  { id: 'drive', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/drive.mjs with googleapis npm client. Auth: GOOGLE_DRIVE_REFRESH_TOKEN + client id/secret env. Read: list_files(folder_id), read_file(file_id). Write: create_file/update_file via Hermes lease. ${CTX}` },
  { id: 'gmail', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/gmail.mjs with googleapis. Auth: GMAIL_REFRESH_TOKEN. Read: list_threads(query), get_thread(id), search(q). Write: send(to, subject, body) via Hermes lease + operator-approval required. ${CTX}` },
  { id: 'slack', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/slack.mjs with @slack/web-api. Auth: SLACK_BOT_TOKEN. Read: list_channels, history(channel, since), search. Write: post_message via Hermes lease + approval. ${CTX}` },
  { id: 'github', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/github.mjs with octokit. Auth: GITHUB_TOKEN (or via gh CLI). Read: list_repos, get_file, list_prs, list_issues. Write: create_issue/comment/pr via Hermes lease. ${CTX}` },
  { id: 'redis', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/redis.mjs with ioredis. Auth: REDIS_URL env. Read: get, mget, keys (with caution), hgetall. Write: set/del via Hermes lease. ${CTX}` },
  { id: 'atoms', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/atoms.mjs (memory-family) — proxies to the AtomSmasher Commitment Atoms store at 12-ATOMSMASHER/commitment-atoms/store.mjs. Read: getAtom, listAtoms. Write: createAtom (via persist.mjs) + revokeAtom. ${CTX}` },
  { id: 'cache', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/cache.mjs (memory-family) — proxies to N150 shadow cache at 06-ORANGELLM/memory/cache/shadow-reader.mjs. Read: readShadowCache, shadow-state-brief. Write: refuse (cache is downstream-only). ${CTX}` },
]
const results = await parallel(adapters.map(a => () => agent(a.prompt, { phase: 'Author', label: `m:${a.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-mirage-eight-adapters-wired.md. Adapters: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Mom's Law. Honest gaps named (which env vars still need operator setup). Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', adapters: results.filter(Boolean), synth }
