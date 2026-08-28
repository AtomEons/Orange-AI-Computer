# Orange5 N150 Docker Runtime

This package runs the local Orange5 OpenAI-compatible gateway in Docker.

It does not package model weights. It connects to:

- local host Ollama through `host.docker.internal:11434`
- Codexa Ollama through the host proxy on `host.docker.internal:11435`

Default host port is `1338` so it can run beside the native Orange5 gateway on
`127.0.0.1:1337`.

Run:

```powershell
cd C:\AtomEons\Orange5\docker\n150-runtime
.\start-n150-docker-runtime.ps1
Invoke-RestMethod http://127.0.0.1:1338/healthz
```

To replace the native gateway later, stop the native service first and run:

```powershell
$env:ORANGE5_DOCKER_GATEWAY_PORT="1337"
.\start-n150-docker-runtime.ps1 -GatewayPort 1337
```

The compose service intentionally bind-mounts the local Orange5 tree instead of
copying model data or training datasets into an image. That keeps the N150
runtime light and makes Docker restartable without duplicating the project.
