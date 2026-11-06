import * as http from "node:http";
import { msg } from "../i18n.js";

type ProxySetter = typeof http.setGlobalProxyFromEnv;

/** dotenv runs after Node startup, so --use-env-proxy/NODE_USE_ENV_PROXY alone cannot read .env. */
export function configureProxyFromEnv(env: NodeJS.ProcessEnv = process.env, setter: ProxySetter | null | undefined = http.setGlobalProxyFromEnv) {
  const httpProxy = env.http_proxy?.trim() || env.HTTP_PROXY?.trim();
  const httpsProxy = env.https_proxy?.trim() || env.HTTPS_PROXY?.trim();
  if (!httpProxy && !httpsProxy) return () => {};
  for (const [name, value] of [["HTTP_PROXY", httpProxy], ["HTTPS_PROXY", httpsProxy]]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch { throw new Error(msg("err.proxyInvalid", { name: name! })); }
  }
  if (typeof setter !== "function") throw new Error(msg("err.proxyNodeVersion"));
  const noProxy = [...new Set([...(env.no_proxy || env.NO_PROXY || "").split(",").map((item) => item.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1"])].join(",");
  try {
    return setter({ HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy, NO_PROXY: noProxy });
  } catch {
    // Native errors can embed a proxy URL with a username/password. Keep them out of logs/UI.
    throw new Error(msg("err.proxySetupFailed"));
  }
}
