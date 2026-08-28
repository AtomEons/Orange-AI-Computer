import { BuildRunStore, DEFAULT_BUILD_RUN_PATH } from '../../../04-CONTROL-PLANE/build-runs/store.mjs';

export const BUILD_RUNS_PATH = '/v1/build-runs';
export const BUILD_RUN_PATH_RX = /^\/v1\/build-runs\/([^/]+)$/;

function store(options = {}) {
  return new BuildRunStore(options.filePath || DEFAULT_BUILD_RUN_PATH);
}

export function isBuildRunPath(pathname) {
  return pathname === BUILD_RUNS_PATH || BUILD_RUN_PATH_RX.test(pathname);
}

export function isBuildRunRouteAllowed(method, pathname) {
  if (pathname === BUILD_RUNS_PATH) return method === 'GET' || method === 'POST';
  return BUILD_RUN_PATH_RX.test(pathname) && (method === 'GET' || method === 'PATCH');
}

export async function handleBuildRuns(method, url, body, options = {}) {
  const repository = store(options);
  try {
    if (method === 'GET' && url.pathname === BUILD_RUNS_PATH) {
      return {
        status: 200,
        body: repository.list({
          threadId: url.searchParams.get('thread') || undefined,
          status: url.searchParams.get('status') || undefined,
          limit: url.searchParams.get('limit') || 100,
        }),
      };
    }
    if (method === 'POST' && url.pathname === BUILD_RUNS_PATH) {
      const result = await repository.create(body || {});
      return { status: 201, body: { schema: 'atomic-orange.build-run.write.v1', ...result } };
    }
    const match = url.pathname.match(BUILD_RUN_PATH_RX);
    if (!match) return { status: 404, body: { error: { code: 'build_run_not_found', message: 'build run route not found' } } };
    const runId = decodeURIComponent(match[1]);
    if (method === 'GET') {
      const run = repository.get(runId);
      return run
        ? { status: 200, body: run }
        : { status: 404, body: { error: { code: 'build_run_not_found', message: `build run not found: ${runId}` } } };
    }
    const result = await repository.update(runId, body || {}, 'operator_updated');
    return { status: 200, body: { schema: 'atomic-orange.build-run.write.v1', ...result } };
  } catch (error) {
    return { status: 400, body: { error: { code: 'build_run_invalid', message: error.message } } };
  }
}

