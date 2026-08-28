# Security

Æ Orange AI Computer is a local-first control plane that can execute tools,
reach model servers, and coordinate more than one computer. Treat installation
and configuration as privileged operations.

## Report A Vulnerability

Do not publish exploitable details in an issue. Use GitHub's private security
advisory flow for this repository. Include the affected commit or release hash,
the exact path, reproduction steps, observed impact, and a minimal proof.

## Trust Boundary

- Model output is untrusted input.
- Mutating work requires a valid `orange.order.v1` and governed execution path.
- A model, process start, HTTP 200, screenshot, or file path cannot certify its
  own success.
- Secrets and machine-local state must remain outside public payloads.
- Remote compute uses authenticated, bounded routes; broad network binding is
  not the default.
- Receipts prove named observations, not universal safety.

## Supported Preview Surface

Windows is the currently proven primary platform. The public preview package is
intended for operator-supervised evaluation. Review `PREVIEW_STATUS.md`, verify
the release SHA-256, and inspect the generated plan before approving mutation.

**Daybreak Blue × Atom Eons**

