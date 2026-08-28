import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResidentImageWorker } from "../resident-image-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-resident-worker.mjs");

describe("resident image worker", () => {
  test("loads once and processes framed binary requests serially", async () => {
    const worker = new ResidentImageWorker({
      command: process.execPath,
      script: fixture,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    try {
      await worker.start();
      const [first, second] = await Promise.all([
        worker.request(Buffer.from([7, 8, 9])),
        worker.request(Buffer.from([11, 12])),
      ]);
      expect(first.patches[0][0]).toEqual([3, 7]);
      expect(second.patches[0][0]).toEqual([2, 11]);
      expect(worker.status().completed).toBe(2);
      expect(worker.status().failures).toBe(0);
      expect(worker.status().state).toBe("ready");
      expect(worker.status().pid).toBeNumber();
    } finally {
      await worker.stop();
    }
  });

  test("rejects missing launch configuration", () => {
    expect(() => new ResidentImageWorker()).toThrow("requires command and script");
  });
});
