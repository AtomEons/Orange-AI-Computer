# Codexa Pre-Flight — Æ Cobra Night-1

**For:** Operator (Atom McCree) — these are pre-flight items you (or Codex on Codexa) execute before I drop the Æ Cobra Night-1 spine files.
**Target host:** Codexa AI Box (Intel Core Ultra 9 285H, 96 GB RAM, ~90 TOPS aggregate)
**Source spec:** `00-CHARTER/AE_COBRA_FOUNDATION_SPEC.md` + Æ Cobra Build Manual sections 8-11

**Time estimate:** 60-120 minutes if everything cooperates. Most of it is downloads + builds.

**Output of this pre-flight:** Codexa WSL2 is ready to host the Æ Cobra daemon. Mamba GGUF is on disk. llama.cpp compiled. `/mnt/ae_flux` mounted. systemd active inside WSL2.

---

## Step 0 — Pick the Codexa WSL2 distro

From Windows PowerShell on Codexa:

```powershell
wsl --list --verbose
```

**If you see Ubuntu-24.04 already:** good. Use it. Skip Step 0.

**If you see no distro or only older Ubuntu:** install Ubuntu 24.04 LTS:

```powershell
wsl --install -d Ubuntu-24.04
# follow the username/password prompts
```

**After install:**
```powershell
wsl --set-default Ubuntu-24.04
wsl --shutdown
wsl   # opens default Ubuntu shell
```

**Pass:** `wsl --list --verbose` shows `* Ubuntu-24.04   Running   2`

---

## Step 1 — Enable systemd inside WSL2

Inside the Ubuntu shell:

```bash
sudo nano /etc/wsl.conf
```

Set the file to (preserve any existing `[automount]` section):

```ini
[boot]
systemd=true

[network]
generateHosts = true
generateResolvConf = true
```

Save + exit. Then from Windows:

```powershell
wsl --shutdown
```

Wait 8 seconds. Re-enter WSL:

```powershell
wsl
```

Verify:

```bash
systemctl --version
ps -p 1 -o comm=
```

**Pass:** `systemctl --version` prints a version AND `ps -p 1 -o comm=` returns `systemd` (not `init`).

---

## Step 2 — Base packages

```bash
sudo apt update
sudo apt install -y \
  build-essential cmake git curl jq htop iotop sysstat \
  pkg-config libssl-dev ca-certificates wget unzip \
  linux-tools-common linux-tools-generic
```

**Pass:** `cmake --version` ≥ 3.22, `gcc --version` ≥ 11.

---

## Step 3 — Bun + Rust installs

```bash
# Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source ~/.cargo/env
rustc --version
cargo --version
```

**Pass:** `bun --version` prints, `rustc --version` ≥ 1.70.

---

## Step 4 — Locate the dedicated Flux disk

The Æ Cobra Build Manual asks for a DEDICATED NVMe drive for Flux writes (TLC preferred, not the boot drive). On Codexa:

```bash
lsblk -o NAME,SIZE,MODEL,SERIAL,TYPE,MOUNTPOINTS,FSTYPE
```

**Three outcomes:**

### Outcome A — Codexa has a second NVMe, currently empty

You'll see something like `/dev/nvme1n1` with no filesystem. Use it:

```bash
# WARNING: this wipes the disk. Confirm it's truly empty/unused.
sudo parted /dev/nvme1n1 --script mklabel gpt
sudo parted /dev/nvme1n1 --script mkpart AE_FLUX ext4 0% 100%
sudo mkfs.ext4 -L AE_FLUX /dev/nvme1n1p1
sudo mkdir -p /mnt/ae_flux
sudo mount /dev/nvme1n1p1 /mnt/ae_flux
sudo blkid /dev/nvme1n1p1
# copy the UUID — you'll need it
```

Add to `/etc/fstab` (use the UUID from `blkid`):

```bash
sudo nano /etc/fstab
```

Append:
```text
UUID=YOUR_UUID_HERE /mnt/ae_flux ext4 defaults,noatime,nodiratime,commit=30 0 2
```

Save. Verify:
```bash
sudo mount -a
df -h /mnt/ae_flux
```

### Outcome B — Codexa has only one NVMe (boot disk)

Acceptable Night-1 compromise: use a subdirectory on the boot disk.

```bash
sudo mkdir -p /mnt/ae_flux
sudo chown -R $USER:$USER /mnt/ae_flux
```

**Operator note:** Flag this in the receipt. Phase 2 task: procure a second NVMe for dedicated Flux disk to reduce write pressure on the boot drive.

### Outcome C — WSL2 abstraction makes raw disk access hard

WSL2 disks are virtualized. The "second NVMe" may not be directly accessible from WSL2.

**Workaround:** Mount a Windows-side folder as `/mnt/ae_flux`. From Windows, create the folder; from WSL2, mount it:

```powershell
# Windows side
New-Item -ItemType Directory -Path "D:\ae_flux" -Force   # or C:\ if no D:
```

WSL2 already auto-mounts Windows drives at `/mnt/c`, `/mnt/d`, etc. So:

```bash
# In WSL2
ln -sf /mnt/d/ae_flux /mnt/ae_flux    # if D: used
# OR
ln -sf /mnt/c/ae_flux /mnt/ae_flux    # if C: only
```

**Flag in receipt:** Boot-drive Flux + WSL2 file-system overhead. Phase 2: native Linux on Codexa for true dedicated Flux NVMe.

---

## Step 5 — Create the Æ Cobra directory structure

```bash
sudo mkdir -p /opt/atomeons/ae-cobra
sudo mkdir -p /opt/atomeons/models
sudo mkdir -p /opt/atomeons/flow-direct
sudo mkdir -p /mnt/ae_flux/events/{reality,thought,merge}
sudo mkdir -p /mnt/ae_flux/index/{reality,thought,merge}
sudo mkdir -p /mnt/ae_flux/state/{reality,thought,merge}
sudo mkdir -p /mnt/ae_flux/receipts
sudo mkdir -p /mnt/ae_flux/logs
sudo mkdir -p /mnt/ae_flux/tmp
sudo chown -R $USER:$USER /opt/atomeons /mnt/ae_flux
```

**Pass:** All dirs exist and you own them.

---

## Step 6 — Build llama.cpp

```bash
cd /opt/atomeons
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp

# CPU build first (Night-1 baseline)
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc) --target llama-server llama-cli

# Sanity check
./build/bin/llama-server --help | head -40
```

**Pass:** `--help` output mentions `mlock`, `mmap`, `grammar-file`, `metrics`. Build directory `build/bin/` contains `llama-server` and `llama-cli`.

**Optional (later, post-Night-1):** Vulkan build for Arc iGPU offload:
```bash
cmake -B build-vulkan -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-vulkan -j$(nproc) --target llama-server
```

Decide via measurement: only keep Vulkan if it improves tokens/sec by ≥15% AND JSON validity holds.

---

## Step 7 — Download Mamba 2.8B Q5_K_M GGUF

```bash
mkdir -p /opt/atomeons/models
cd /opt/atomeons/models

# Install Hugging Face CLI if missing
pip install --user -U huggingface_hub
export PATH=$PATH:$HOME/.local/bin

# Download Q5_K_M (primary)
huggingface-cli download bartowski/mamba-2.8b-hf-GGUF \
  mamba-2.8b-hf-Q5_K_M.gguf \
  --local-dir /opt/atomeons/models \
  --local-dir-use-symlinks False

# Also grab Q4_K_M as fallback (no harm, ~2 GB)
huggingface-cli download bartowski/mamba-2.8b-hf-GGUF \
  mamba-2.8b-hf-Q4_K_M.gguf \
  --local-dir /opt/atomeons/models \
  --local-dir-use-symlinks False
```

Symlink to internal Orange5 name (so the rest of the system uses `ae-blackmamba` even before we train a custom one):

```bash
ln -sf /opt/atomeons/models/mamba-2.8b-hf-Q5_K_M.gguf \
       /opt/atomeons/models/ae-blackmamba-2.8b-Q5_K_M.gguf

ls -la /opt/atomeons/models/
```

**Pass:**
- `mamba-2.8b-hf-Q5_K_M.gguf` exists, size ≥ 2.5 GB
- `ae-blackmamba-2.8b-Q5_K_M.gguf` is a symlink pointing at it

---

## Step 8 — Smoke test the model

```bash
ulimit -l unlimited

/opt/atomeons/llama.cpp/build/bin/llama-server \
  --model /opt/atomeons/models/ae-blackmamba-2.8b-Q5_K_M.gguf \
  --host 127.0.0.1 \
  --port 7419 \
  --ctx-size 1200 \
  --predict 96 \
  --threads 8 \
  --threads-batch 8 \
  --mlock \
  --no-mmap \
  --parallel 1 \
  --cont-batching \
  --no-webui \
  --metrics &

SERVER_PID=$!
sleep 10
```

In a second terminal (or with `curl` from the same shell):

```bash
curl -s http://127.0.0.1:7419/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Hello in 3 words:",
    "max_tokens": 16,
    "temperature": 0.2
  }' | jq -r '.choices[0].text'
```

**Pass:** You get some text response — anything coherent. The model is loaded.

Memory check while it's running:

```bash
grep -E "VmRSS|VmHWM|VmLck|VmSwap" /proc/$SERVER_PID/status
```

**Pass:**
- `VmSwap: 0 kB`
- `VmLck` > 0 (mlock is working)
- `VmRSS` somewhere around 2.5-3.5 GB

Shut down the smoke test:

```bash
kill $SERVER_PID
sleep 3
```

---

## Step 9 — Codexa rail token to Atomic Orange env

(This is the Step 2 from the month plan — you do it on the Windows side, not WSL2.)

From Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("ORANGEBOX_RAIL_TOKEN", "<your-token>", "User")
```

Restart the OrangeLLM gateway so it picks up the new env:

```powershell
# Find and stop existing gateway (gracefully)
Get-Process -Name "node" | Where-Object { $_.MainWindowTitle -match "orangellm" -or $_.Path -match "06-ORANGELLM" } | Stop-Process

# Restart (assuming the operator's normal launch script handles it)
cd C:\AtomEons\Orange5\06-ORANGELLM
node server\index.mjs &
```

Then re-run the heavy probe:

```bash
node "C:/AtomEons/Orange5/06-ORANGELLM/tests/heavy-probe.mjs"
```

**Pass:** `preferred_route: "command_rail"` and `live: true`. (Currently it returns 401.)

---

## Step 10 — Receipt this pre-flight

When all 9 steps above pass, write the receipt at:

```
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\2026-06-2N-codexa-preflight-ae-cobra-closed.md
```

Use the receipt template at `00-CHARTER/CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md` §10 as a guide. Key fields:

- WSL2 distro name + version
- `/mnt/ae_flux` real or symlinked? Note Outcome A/B/C from Step 4
- llama.cpp commit hash
- Mamba GGUF SHA-256
- Smoke test response (paste actual model output)
- Memory metrics (VmRSS / VmLck / VmSwap)
- `ORANGEBOX_RAIL_TOKEN` set? Heavy probe state?

Hash-chain to the prior receipt.

---

## When this pre-flight closes

I drop the **Æ Cobra Night-1 spine files**: `agent_turn.gbnf`, `ae-cobra.service` systemd unit, `flow-direct/index.ts`, `flow-direct/flux.ts` (JSONL+idx writer with hash chain), `flow-direct/classifier.ts` (origin-based), `healthcheck.sh`. Plus the N150-side `mirage-client.mjs` that proxies StateBrief queries through the rail.

Once that lands and the service starts cleanly, **Æ Cobra is alive**.

---

## Decision call needed if Step 4 lands at Outcome B or C

If Codexa has no second NVMe (Outcome B) OR WSL2 abstracts disks away (Outcome C), Night-1 ships on boot-drive Flux. Flag in the receipt. Add to the Not-Green Ledger as a Phase-2 hardware procurement item: "Second NVMe for Codexa dedicated Flux disk."

Not a Night-1 blocker — just a known limitation that won't survive a sustained heavy-write workload past a few weeks.

---

**Mom is watching. Build the spine. The serpent waits.**
