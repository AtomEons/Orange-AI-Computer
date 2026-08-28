#!/usr/bin/env node
import { createDefaultRegistry, get, list } from "../src/registry.mjs";

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`));

createDefaultRegistry();
const adapters = list();

assert(adapters.length === 4, `4 default adapters registered (got ${adapters.length})`);
assert(get("mock-local-deterministic")?.status === "READY", "mock is READY");
assert(get("local-llama-cpp-listener")?.lane === "local_endpoint", "llama.cpp lane is local_endpoint");
assert(get("ai-box-triad-readonly")?.status === "PLANNED", "triad-readonly is PLANNED until token wired");
assert(get("ai-box-allowlisted-command")?.allowlist?.length >= 10, "allowlist has ≥10 commands");

const mock = get("mock-local-deterministic");
const result = await mock.invoke({ ping: 1 });
assert(result.ok === true, "mock invoke returns ok=true");
assert(result.echo?.ping === 1, "mock echoes input");

const cmd = get("ai-box-allowlisted-command");
const denied = await cmd.invoke({ command: "delete-everything" });
assert(denied.ok === false && denied.error === "command_not_allowlisted", "non-allowlisted command rejected");

console.log(`\n[registry-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
