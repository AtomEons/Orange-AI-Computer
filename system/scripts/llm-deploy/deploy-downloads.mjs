import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { stableJson, writeJsonAtomic } from './deploy-core.mjs';

function validateDownloadUrl(value, allowLoopbackHttp = false) {
  const parsed = new URL(String(value || ''));
  const loopback = allowLoopbackHttp && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if ((!loopback && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('Model download URL must be credential-free HTTPS.');
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|key|signature|credential|password|secret|auth)/i.test(key)) {
      throw new Error(`Model download URL contains forbidden credential-like query parameter: ${key}`);
    }
  }
  return parsed.href;
}

function normalizedSpec(spec, allowLoopbackHttp) {
  const requestedDestination = String(spec.destination || '');
  const destination = path.resolve(requestedDestination);
  const sha256 = String(spec.sha256 || '').toLowerCase();
  const bytes = Number(spec.bytes);
  if (!requestedDestination || !path.isAbsolute(requestedDestination) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('Model download requires an absolute destination, exact byte count, and SHA-256.');
  }
  return { destination, sha256, bytes, url: validateDownloadUrl(spec.url, allowLoopbackHttp) };
}

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function ownershipRecord(spec) {
  return {
    schema: 'orange.deploy.download-part.v1',
    destination: spec.destination,
    source: spec.url,
    bytes: spec.bytes,
    sha256: spec.sha256,
  };
}

async function validateOwnedPartial(partialPath, metadataPath, expected) {
  if (!existsSync(partialPath)) return 0;
  if (!existsSync(metadataPath)) throw new Error(`Refusing to adopt unowned partial download: ${partialPath}`);
  const actual = JSON.parse(await Bun.file(metadataPath).text());
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`Partial download ownership does not match approved model bytes: ${partialPath}`);
  const bytes = statSync(partialPath).size;
  if (bytes > expected.bytes) throw new Error(`Owned partial exceeds approved byte count: ${partialPath}`);
  return bytes;
}

async function writeResponseBody(response, target, append) {
  if (!response.body) throw new Error('Model download response has no body.');
  const descriptor = openSync(target, append ? 'a' : 'w');
  let written = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writeSync(descriptor, value);
      written += value.byteLength;
    }
  } finally {
    closeSync(descriptor);
  }
  return written;
}

export async function downloadApprovedFile(specInput, {
  fetchFn = globalThis.fetch,
  timeoutMs = 30 * 60_000,
  allowLoopbackHttp = false,
} = {}) {
  const spec = normalizedSpec(specInput, allowLoopbackHttp);
  mkdirSync(path.dirname(spec.destination), { recursive: true });
  if (existsSync(spec.destination)) {
    const bytes = statSync(spec.destination).size;
    const sha256 = await hashFile(spec.destination);
    if (bytes !== spec.bytes || sha256 !== spec.sha256) throw new Error(`Existing model destination is not the approved artifact and will not be overwritten: ${spec.destination}`);
    return { status: 'ADOPTED', ...spec };
  }

  const partialPath = `${spec.destination}.part`;
  const metadataPath = `${partialPath}.orangefive.json`;
  const ownership = ownershipRecord(spec);
  let existingBytes = await validateOwnedPartial(partialPath, metadataPath, ownership);
  const hadPartial = existingBytes > 0;
  let restarted = false;
  if (!existsSync(partialPath)) writeJsonAtomic(metadataPath, ownership);

  const request = async (resumeAt, mayRestart) => {
    const response = await fetchFn(spec.url, {
      headers: resumeAt ? { Range: `bytes=${resumeAt}-` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 416 && resumeAt) {
      if (resumeAt === spec.bytes && await hashFile(partialPath) === spec.sha256) return { completePartial: true };
      if (!mayRestart) throw new Error(`Model server rejected a clean restart with HTTP ${response.status}.`);
      rmSync(partialPath, { force: true });
      existingBytes = 0;
      restarted = true;
      return request(0, false);
    }
    if (response.status !== 200 && response.status !== 206) throw new Error(`Model download failed with HTTP ${response.status}.`);
    let append = resumeAt > 0;
    if (resumeAt > 0 && response.status === 206) {
      const contentRange = response.headers.get('content-range') || '';
      const match = contentRange.match(/^bytes\s+(\d+)-/i);
      if (!match || Number(match[1]) !== resumeAt) throw new Error(`Model server returned an invalid resume range: ${contentRange || 'missing'}`);
    } else if (resumeAt > 0 && response.status === 200) {
      append = false;
      existingBytes = 0;
      restarted = true;
    } else if (resumeAt === 0 && response.status === 206) {
      const contentRange = response.headers.get('content-range') || '';
      if (!/^bytes\s+0-/i.test(contentRange)) throw new Error(`Model server returned an invalid initial range: ${contentRange || 'missing'}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    const expectedRemaining = spec.bytes - (append ? existingBytes : 0);
    if (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength !== expectedRemaining) {
      throw new Error(`Model response length mismatch: expected ${expectedRemaining}, got ${contentLength}.`);
    }
    await writeResponseBody(response, partialPath, append);
    return { completePartial: true };
  };

  await request(existingBytes, true);
  const bytes = statSync(partialPath).size;
  if (bytes !== spec.bytes) throw new Error(`Model byte count mismatch: expected ${spec.bytes}, got ${bytes}. Partial retained for resume.`);
  const sha256 = await hashFile(partialPath);
  if (sha256 !== spec.sha256) throw new Error(`Model SHA-256 mismatch. Owned partial retained at ${partialPath}.`);
  if (existsSync(spec.destination)) throw new Error(`Model destination appeared during download and will not be overwritten: ${spec.destination}`);
  renameSync(partialPath, spec.destination);
  rmSync(metadataPath, { force: true });
  return { status: restarted ? 'RESTARTED_AND_VERIFIED' : (hadPartial ? 'RESUMED_AND_VERIFIED' : 'DOWNLOADED_AND_VERIFIED'), ...spec };
}

export async function downloadApprovedModel(action, options = {}) {
  const files = [];
  for (const spec of action.files || []) files.push(await downloadApprovedFile(spec, options));
  if (!files.length) throw new Error(`Model ${action.role} has no approved file downloads.`);
  return { schema: 'orange.deploy.model-download.v1', status: 'VERIFIED', role: action.role, revision: action.acquisition?.revision || null, files };
}

export function remoteDownloadScript(action) {
  const payload = Buffer.from(JSON.stringify({ role: action.role, revision: action.acquisition?.revision || null, files: action.files || [] }), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$document = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$results = @()
$client = [Net.Http.HttpClient]::new()
try {
  foreach ($file in @($document.files)) {
    $uri = [Uri][string]$file.url
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo) { throw 'Model download URL must be credential-free HTTPS.' }
    if ($uri.Query -match '(?i)(token|key|signature|credential|password|secret|auth)=') { throw 'Model download URL contains credential-like query data.' }
    $destination = [IO.Path]::GetFullPath([string]$file.destination)
    $expectedBytes = [long]$file.bytes
    $expectedHash = ([string]$file.sha256).ToLowerInvariant()
    $partial = $destination + '.part'
    $metadata = $partial + '.orangefive.json'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    if (Test-Path -LiteralPath $destination) {
      $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
      $length = (Get-Item -LiteralPath $destination).Length
      if ($actual -ne $expectedHash -or $length -ne $expectedBytes) { throw "Existing destination is not approved: $destination" }
      $results += [ordered]@{ status = 'ADOPTED'; destination = $destination; bytes = $length; sha256 = $actual }
      continue
    }
    $owner = [ordered]@{ schema = 'orange.deploy.download-part.v1'; destination = $destination; source = [string]$file.url; bytes = $expectedBytes; sha256 = $expectedHash }
    $existing = 0L
    if (Test-Path -LiteralPath $partial) {
      if (-not (Test-Path -LiteralPath $metadata)) { throw "Refusing unowned partial: $partial" }
      $record = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
      if ($record.destination -ne $owner.destination -or $record.source -ne $owner.source -or [long]$record.bytes -ne $owner.bytes -or $record.sha256 -ne $owner.sha256) { throw "Partial ownership mismatch: $partial" }
      $existing = [long](Get-Item -LiteralPath $partial).Length
      if ($existing -gt $expectedBytes) { throw "Partial exceeds approved bytes: $partial" }
    } else {
      $owner | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadata -Encoding utf8
    }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
    if ($existing -gt 0) { $request.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new($existing, $null) }
    $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if ([int]$response.StatusCode -eq 416 -and $existing -eq $expectedBytes) {
      $partialHash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($partialHash -ne $expectedHash) { throw "Completed partial hash mismatch: $partial" }
    } else {
      if ([int]$response.StatusCode -notin @(200, 206)) { throw "Model download failed with HTTP $([int]$response.StatusCode)" }
      $append = $existing -gt 0 -and [int]$response.StatusCode -eq 206
      if ($append) {
        $from = $response.Content.Headers.ContentRange.From
        if ($null -eq $from -or [long]$from -ne $existing) { throw 'Model server returned an invalid resume range.' }
      } elseif ([int]$response.StatusCode -eq 200) { $existing = 0L }
      $mode = if ($append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
      $output = [IO.File]::Open($partial, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $response.Content.CopyToAsync($output).GetAwaiter().GetResult() } finally { $output.Dispose() }
    }
    $length = [long](Get-Item -LiteralPath $partial).Length
    if ($length -ne $expectedBytes) { throw "Model byte count mismatch: expected $expectedBytes got $length" }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expectedHash) { throw "Model SHA-256 mismatch: $partial" }
    Move-Item -LiteralPath $partial -Destination $destination
    Remove-Item -LiteralPath $metadata -Force
    $results += [ordered]@{ status = 'DOWNLOADED_AND_VERIFIED'; destination = $destination; bytes = $length; sha256 = $actual }
  }
} finally { $client.Dispose() }
[ordered]@{ schema = 'orange.deploy.model-download.v1'; status = 'VERIFIED'; role = [string]$document.role; revision = [string]$document.revision; files = $results } | ConvertTo-Json -Depth 8 -Compress
`;
}
