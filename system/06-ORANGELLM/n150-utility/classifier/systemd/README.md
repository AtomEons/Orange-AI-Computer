# n150-classifier systemd install

Target host: N150 (Beelink, 4c/16GB), Ubuntu 22.04+ assumed.

## One-time install

```bash
# 1. Create service user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin orange5

# 2. Lay down the code (rsync from operator workstation, or git pull on N150)
sudo mkdir -p /opt/orange5/06-ORANGELLM/n150-utility/classifier
sudo rsync -a --delete \
  C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/classifier/ \
  orange5-n150:/opt/orange5/06-ORANGELLM/n150-utility/classifier/
sudo chown -R orange5:orange5 /opt/orange5/06-ORANGELLM/n150-utility/classifier

# 3. Pre-create writable state dir (ReadWritePaths requires existence)
sudo -u orange5 mkdir -p /opt/orange5/06-ORANGELLM/n150-utility/classifier/state

# 4. Install unit
sudo cp /opt/orange5/06-ORANGELLM/n150-utility/classifier/systemd/n150-classifier.service \
        /etc/systemd/system/n150-classifier.service
sudo systemctl daemon-reload
sudo systemctl enable --now n150-classifier.service

# 5. Verify
curl -fsS http://127.0.0.1:7480/healthz | jq .
```

## Hot-swap stock model (no restart)

```bash
# Pin the new stock tag
echo 'qwen3:1.7b' | sudo -u orange5 tee \
  /opt/orange5/06-ORANGELLM/n150-utility/classifier/state/model.pin

# Reload (sends SIGHUP)
sudo systemctl reload n150-classifier.service

# Confirm
curl -fsS http://127.0.0.1:7480/model | jq .
```

Or via the HTTP API (equivalent):

```bash
curl -fsS -X POST http://127.0.0.1:7480/model \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:1.7b"}'
```

## Smoke

```bash
cd /opt/orange5/06-ORANGELLM/n150-utility/classifier
node tests/classifier.smoke.mjs       # unit tests, no live daemon
node tests/classifier.live.smoke.mjs  # live HTTP test against the running unit
```

## Logs

```bash
journalctl -u n150-classifier.service -f
```

## Receipt trail

Every `/classify` decision lands in
`/opt/orange5/06-ORANGELLM/n150-utility/classifier/state/decisions.jsonl`,
JSON-lines, append-only. Operator-owned rotation cron is out of scope here
(documented at `01-DOCTRINE/27-guardrails/` retention policy).
