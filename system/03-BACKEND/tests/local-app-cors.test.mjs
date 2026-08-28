import { describe, expect, test } from "bun:test";
import { applyNodeLocalAppCors, localAppOrigin, withLocalAppCors } from "../local-app-cors.mjs";

describe("local app CORS", () => {
  test("allows loopback previews and native Tauri origins", () => {
    expect(localAppOrigin("http://127.0.0.1:4176")).toBe("http://127.0.0.1:4176");
    expect(localAppOrigin("http://localhost:1420")).toBe("http://localhost:1420");
    expect(localAppOrigin("https://tauri.localhost")).toBe("https://tauri.localhost");
    expect(localAppOrigin("tauri://localhost")).toBe("tauri://localhost");
  });

  test("rejects arbitrary browser origins", () => {
    expect(localAppOrigin("https://example.com")).toBeNull();
    expect(localAppOrigin("http://127.0.0.1.evil.test:4176")).toBeNull();
    expect(localAppOrigin("not-a-url")).toBeNull();
  });

  test("applies matching headers to Node and Fetch responses", () => {
    const headers = new Map();
    const origin = applyNodeLocalAppCors(
      { headers: { origin: "http://127.0.0.1:4176" } },
      { setHeader: (name, value) => headers.set(name, value) },
    );
    expect(origin).toBe("http://127.0.0.1:4176");
    expect(headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const response = withLocalAppCors(
      new Response("ok"),
      new Request("http://127.0.0.1:7430/healthz", { headers: { origin: "http://localhost:1420" } }),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:1420");
  });
});
