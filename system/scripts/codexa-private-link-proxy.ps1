$ErrorActionPreference = 'Stop'
$name = 'orangefive-private-link'
$existing = docker ps -a --filter "name=^/${name}$" --format '{{.Names}}'
if ($existing -eq $name) {
  docker start $name | Out-Null
  exit 0
}
throw "Required Docker sidecar is not installed: $name"
