# Orange5 verifier — thin wrapper.
#
# The legacy version of this script ran only 7 hand-listed test files via `node`,
# while the repo holds ~58 `*.test.mjs` across every pillar. That gap let real reds
# hide behind a green 7/7. This now delegates to the Bun-native FULL verifier, which
# discovers EVERY test file and runs each with the correct invocation.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:/AtomEons/Orange5/00-CHARTER/run-all-tests.ps1
#   (or, Bun-native:)  bun run verify

$verifier = "C:\AtomEons\Orange5\00-CHARTER\orange5-full-verifier.mjs"

if (-not (Test-Path $verifier)) {
    Write-Host "ERROR: full verifier not found at $verifier" -ForegroundColor Red
    exit 2
}

& bun $verifier
exit $LASTEXITCODE
