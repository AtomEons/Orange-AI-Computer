import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const parseYaml = (path) => Bun.YAML.parse(readFileSync(path, 'utf8'));
const profiles = ['navigator', 'builder', 'researcher', 'reviewer', 'visual', 'misfit'];
const delegationPosture = {
  navigator: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  researcher: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  builder: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  reviewer: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  visual: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  misfit: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
};

describe('OrangeFive Hermes product pack', () => {
  test('pins current stable Hermes exactly', () => {
    const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'));
    expect(lock.packageVersion).toBe('0.20.5');
    expect(lock.tag).toBe('v2026.8.19');
    expect(lock.tagObjectSha).toBe('b05e680e63d39d5a8e3ec0f5842a41d1c4209c03');
    expect(lock.commit).toBe('fcbd1076a93841fa88855acce810e342a5b78101');
  });

  test('has exactly one gateway and dispatcher owner', () => {
    const owner = parseYaml(join(root, 'config', 'gateway-owner', 'config.yaml'));
    expect(owner.gateway.multiplex_profiles).toBe(true);
    expect(owner.gateway.api_server.max_concurrent_runs).toBe(8);
    expect(owner.kanban.dispatch_in_gateway).toBe(true);
    expect(owner.kanban.max_in_progress).toBe(8);
    expect(owner.kanban.max_in_progress_per_profile).toBe(2);
    expect(owner.delegation).toEqual({ max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true });
    for (const profile of profiles) {
      const cfg = parseYaml(join(root, 'config', 'profiles', profile, 'config.yaml'));
      expect(cfg.gateway.multiplex_profiles).toBe(false);
      expect(cfg.platforms.api_server.enabled).toBe(false);
      expect(cfg.kanban.dispatch_in_gateway).toBe(false);
      expect(cfg.delegation).toEqual(delegationPosture[profile]);
    }
  });

  test('exposes only the governed Orange MCP surface', () => {
    const expected = ['orange5_delegate', 'orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'];
    expect(parseYaml(join(root, 'config', 'gateway-owner', 'config.yaml')).mcp_servers.orange5.tools.include.sort()).toEqual(expected);
    const scoped = {
      navigator: expected,
      builder: ['orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'],
      researcher: ['orange5_delegate', 'orange5_health', 'orange5_receipts'],
      reviewer: ['orange5_health', 'orange5_receipts'],
      visual: ['orange5_health', 'orange5_receipts'],
      misfit: ['orange5_health', 'orange5_receipts'],
    };
    for (const profile of profiles) {
      const tools = parseYaml(join(root, 'config', 'profiles', profile, 'config.yaml')).mcp_servers.orange5.tools.include.sort();
      expect(tools).toEqual([...scoped[profile]].sort());
    }
  });

  test('keeps all runtime endpoints on loopback', () => {
    const configs = [join(root, 'config', 'gateway-owner', 'config.yaml'), ...profiles.map((profile) => join(root, 'config', 'profiles', profile, 'config.yaml'))];
    for (const path of configs) {
      const cfg = parseYaml(path);
      expect(cfg.model.base_url).toBe('__ORANGE_MODEL_URL__');
      expect(cfg.model.default).toBe('__HERMES_AGENT_MODEL__');
      expect(cfg.model.context_length).toBe(65536);
      expect(cfg.model.ollama_num_ctx).toBe(65536);
      expect(cfg.model.provider).toBe('custom:orange5');
      expect(cfg.agent.disabled_toolsets).toEqual(['bfl']);
      expect(cfg.auxiliary.free_only).toBe(true);
      expect(cfg.auxiliary.title_generation.enabled).toBe(false);
      expect(cfg.providers.orange5.extra_body.think).toBe(false);
      expect(cfg.providers.orange5.extra_body.reasoning_effort).toBe('none');
      expect(cfg.agent.reasoning_effort).toBe('none');
    }
    const client = JSON.parse(readFileSync(join(root, 'config', 'clients', 'openai-compatible.json'), 'utf8'));
    expect(client.baseUrl).toBe('http://127.0.0.1:8642/v1');
  });

  test('stores no real credentials', () => {
    const example = readFileSync(join(root, 'config', 'env', 'default.env.example'), 'utf8');
    expect(example).toContain('GENERATED_AT_INSTALL');
    expect(example).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|KGAT_[A-Za-z0-9]{20,}/);
  });

  test('uses the production gateway command and supports overlay adoption', () => {
    const start = readFileSync(join(root, 'scripts', 'start-owner.ps1'), 'utf8');
    const installer = readFileSync(join(root, 'scripts', 'install-hermes-product.ps1'), 'utf8');
    expect(start).toContain("@('gateway', 'run', '--external-supervisor')");
    expect(installer).toContain('ExistingHermesExe');
    expect(installer).toContain("provenanceMode = 'adopted-executable'");
    expect(installer).toContain('sourceCommitVerified = $false');
  });

  test('defaults Hermes materialization and deployment to canonical Q4KM while preserving explicit overrides', () => {
    const canonical = 'orange-navigator:ornith-1.5-9b-q4km';
    for (const name of ['materialize-config.ps1', 'deploy-codexa-profiles.ps1']) {
      const script = readFileSync(join(root, 'scripts', name), 'utf8');
      expect(script).toContain(`[string]$HermesAgentModel = '${canonical}'`);
      expect(script).not.toContain("[string]$HermesAgentModel = 'orange-navigator:ornith-1.5-9b-q8'");
    }

    const materializer = join(root, 'scripts', 'materialize-config.ps1');
    const run = (extra = []) => Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', materializer, ...extra],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const defaultRun = run();
    expect(new TextDecoder().decode(defaultRun.stderr)).toBe('');
    expect(defaultRun.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(defaultRun.stdout)).hermesAgentModel).toBe(canonical);

    const override = 'orange-navigator:test-explicit-override';
    const overrideRun = run(['-HermesAgentModel', override]);
    expect(new TextDecoder().decode(overrideRun.stderr)).toBe('');
    expect(overrideRun.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(overrideRun.stdout)).hermesAgentModel).toBe(override);
  }, 60_000);

  test('preflight resolves the listener owner and preserves strict runtime gates', () => {
    const preflight = readFileSync(join(root, 'scripts', 'preflight.ps1'), 'utf8');
    const result = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests', 'preflight-runtime.ps1')],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('Preflight runtime ownership PASS');
    expect(preflight).toContain("$noAuth.status -in @(401, 403)");
    expect(preflight).toContain("$wrongAuth.status -in @(401, 403)");
    expect(preflight).toContain("/v1/toolsets' @{ Authorization = \"Bearer $apiKey\" } 15");
    expect(preflight).toContain('/v1/toolsets" @{ Authorization = "Bearer $profileKey" } 15');
    expect(preflight).toContain('navigator-agent-inference');
    expect(preflight).toContain('filtered-profile-surface-not-ready;inference-not-sent');
  }, 60_000);

  test('bounded live delegation uses durable MCP tasks instead of a synchronous model timeout', () => {
    const proof = readFileSync(join(root, 'scripts', 'bounded-live-delegation-proof.ps1'), 'utf8');
    expect(proof).toContain("'io.modelcontextprotocol/tasks'");
    expect(proof).toContain("method = 'tasks/get'");
    expect(proof).toContain("method = 'tasks/cancel'");
    expect(proof).toContain('durable delegation exceeded total bound');
    expect(proof).not.toContain('-TimeoutSec $TimeoutSec\n  $rpc');
  });
});
