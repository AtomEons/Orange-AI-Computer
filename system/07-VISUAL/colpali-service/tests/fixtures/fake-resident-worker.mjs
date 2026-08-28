import { createHash } from "node:crypto";

let buffer = Buffer.alloc(0);
let header = null;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function drain() {
  while (true) {
    if (!header) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      header = JSON.parse(line);
      if (header.type === "shutdown") process.exit(0);
    }
    if (buffer.length < header.bytes) return;
    const bytes = buffer.subarray(0, header.bytes);
    buffer = buffer.subarray(header.bytes);
    emit({
      id: header.id,
      ok: true,
      result: {
        page_count: 1,
        patches: [[[bytes.length, bytes[0] ?? 0]]],
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    header = null;
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

emit({ type: "ready", backend: "fake-resident" });
