# OrangeFive CI Activation

`verify.windows.yml` is the reviewed Windows/Bun clean-checkout gate.

It is not active until copied to `.github/workflows/verify.yml`. The current
GitHub OAuth credential has `repo` scope but not `workflow` scope, so GitHub
correctly rejected direct workflow creation on 2026-07-29.

Activate after granting the CLI `workflow` scope:

```powershell
gh auth refresh -h github.com -s workflow
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Copy-Item 00-CHARTER\ci\verify.windows.yml .github\workflows\verify.yml
git add .github\workflows\verify.yml
git commit -m "Activate OrangeFive verification workflow"
git push origin main
```

Until then, local and clean-clone verification remain authoritative. Do not
describe GitHub CI as active.
