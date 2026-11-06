import assert from "node:assert/strict";
import * as http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { configureProxyFromEnv } from "../src/network/proxy.js";

describe("outbound proxy after dotenv", () => {
  it("preserves explicit proxy settings and always bypasses OAuth/project loopback requests", () => {
    let received: Record<string, string | undefined> | undefined;
    let restored = false;
    const restore = configureProxyFromEnv({ http_proxy: "http://127.0.0.1:10808", HTTPS_PROXY: "http://127.0.0.1:10809", NO_PROXY: "intranet.example" }, (env) => {
      received = env;
      return () => { restored = true; };
    });
    assert.equal(received?.HTTP_PROXY, "http://127.0.0.1:10808");
    assert.equal(received?.HTTPS_PROXY, "http://127.0.0.1:10809");
    assert.equal(received?.NO_PROXY, "intranet.example,localhost,127.0.0.1,::1");
    restore(); assert.equal(restored, true);
    configureProxyFromEnv({}, () => { throw new Error("must not change global networking without configuration"); })();
  });

  it("rejects invalid/unsupported configuration without including passwords in errors", () => {
    assert.throws(() => configureProxyFromEnv({ HTTPS_PROXY: "socks://user:secret@127.0.0.1:10808" }), (error: Error) => /HTTPS_PROXY/.test(error.message) && !error.message.includes("secret"));
    assert.throws(() => configureProxyFromEnv({ HTTP_PROXY: "invalid secret proxy URL" }), /HTTP_PROXY/);
    assert.throws(() => configureProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:10808" }, null), /Node/);
    assert.throws(() => configureProxyFromEnv({ HTTPS_PROXY: "http://user:secret@127.0.0.1:10808" }, () => { throw new Error("secret"); }), (error: Error) => !error.message.includes("secret"));
  });

  it("routes actual fetch traffic through a CONNECT proxy while keeping localhost direct", { skip: typeof http.setGlobalProxyFromEnv !== "function" }, async () => {
    const sockets = new Set<Duplex>();
    const target = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); });
    const proxy = http.createServer();
    let connects = 0;
    proxy.on("connect", (req, client, head) => {
      connects++;
      const upstream = net.connect({ host: "127.0.0.1", port: Number(req.url!.split(":").at(-1)) });
      sockets.add(client); sockets.add(upstream);
      client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyURL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const targetPort = (target.address() as AddressInfo).port;
    const restore = configureProxyFromEnv({ HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL });
    try {
      assert.deepEqual(await (await fetch(`http://service.invalid:${targetPort}/config`, { signal: AbortSignal.timeout(3000) })).json(), { ok: true });
      assert.equal(connects, 1, "the deliberately unresolvable hostname must be handled by the configured proxy");
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${targetPort}/callback`, { signal: AbortSignal.timeout(3000) })).json(), { ok: true });
      assert.equal(connects, 1, "loopback must not be sent to v2rayN");
    } finally {
      restore(); for (const socket of sockets) socket.destroy(); target.closeAllConnections(); target.close(); proxy.closeAllConnections(); proxy.close();
    }
  });
});
