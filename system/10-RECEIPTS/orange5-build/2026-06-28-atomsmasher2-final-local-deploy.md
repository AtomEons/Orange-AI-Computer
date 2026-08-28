# AtomSmasher 2 Final Deploy Receipt

Date: 2026-06-28
System: OrangeFive / AtomSmasher 2
Operator request: Find and deploy the new AtomSmasher 2 final system on Codexa and here.

## Package

Source package:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\atomsmasher2-2026-06-27.tar.gz
```

SHA-256:

```text
C5EFD2BF45EFCBB0A9143413121248C962CD22A0A31121D641F00861AE496780
```

Package docs:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\README.md
```

Windows installer added:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\install-windows.ps1
```

Reason: the existing `install.sh` and `preflight.sh` are Bash/WSL-oriented. WSL timed out on the N150/dev box, so a Windows-native installer was added and verified.

## Local Install

Installed target:

```text
C:\Users\a\OrangeBox-Data\atomsmasher2-final-local
```

Installed by:

```text
Windows tar extraction from atomsmasher2-2026-06-27.tar.gz
```

Verification command:

```text
bun tests/run-all.mjs
```

Verification result:

```text
aggregate: 35/35 pass  fail=0  suites=7
```

Installed test receipt:

```text
C:\Users\a\OrangeBox-Data\atomsmasher2-final-local\receipts\run-all-2026-06-28T07-47-07-506Z.json
```

## Local Daemon

Daemon path:

```text
C:\Users\a\OrangeBox-Data\atomsmasher2-final-local\start-daemon.mjs
```

Daemon command:

```text
bun start-daemon.mjs
```

Listening endpoint:

```text
http://127.0.0.1:8901
```

Health proof:

```json
{
  "ok": true,
  "service": "atomsmasher2",
  "version": "1.0.0",
  "port": 8901,
  "counts": {
    "features": 620,
    "receipts": 1427
  }
}
```

Daemon demo proof:

```text
POST /demo returned all_features.attempted=620, all_features.ok=620, all_features.errors=0.
```

Daemon receipt proof:

```text
POST /receipt returned id rcpt_7a0d4bdd1d08b0fb.
GET /receipts?action=local-deploy-proof returned the deployed receipt.
```

## Windows Installer Verification

Test install target:

```text
C:\Users\a\OrangeBox-Data\atomsmasher2-windows-installer-test
```

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\install-windows.ps1 -InstallPath C:\Users\a\OrangeBox-Data\atomsmasher2-windows-installer-test -NoBackup -NoStart
```

Result:

```text
aggregate: 35/35 pass  fail=0  suites=7
```

Installer test receipt:

```text
C:\Users\a\OrangeBox-Data\atomsmasher2-windows-installer-test\receipts\run-all-2026-06-28T07-54-09-801Z.json
```

## Codexa Deployment

Status:

```text
BLOCKED_BY_CONNECTIVITY
```

Evidence:

```text
ssh codexa timed out.
ping 10.0.99.1 timed out.
ping 10.0.0.4 returned Destination host unreachable from 10.0.0.114.
Test-NetConnection to Codexa SSH paths timed out.
```

Codexa package remains ready at:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install
```

Codexa intended command after connectivity returns:

```bash
scp atomsmasher2-2026-06-27.tar.gz install.sh preflight.sh codexa:/tmp/
ssh codexa "cd /tmp && bash preflight.sh && bash install.sh"
```

If Codexa uses Windows instead of WSL/Linux for this lane, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1
```

## Verdict

```text
LOCAL_DEV_BOX_DEPLOY_GREEN
CODEXA_DEPLOY_BLOCKED_BY_CONNECTIVITY
```

No fake green: AtomSmasher 2 Final is installed and running locally. Codexa is not deployed because the AI box is currently unreachable from the dev box.
