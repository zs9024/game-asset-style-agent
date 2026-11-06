import "dotenv/config";
import { msg } from "../i18n.js";
import { chatGPTAuth } from "./chatgpt.js";
import { configureProxyFromEnv } from "../network/proxy.js";

// Run locally before copying the protected auth directory to a self-hosted instance.
try {
  configureProxyFromEnv();
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--new") && !(args.length === 2 && args[0] === "--account")) {
    throw new Error(msg("usage.chatgptLogin"));
  }
  const status = await chatGPTAuth.status();
  const accountId = args[0] === "--new" ? undefined : args[0] === "--account" ? args[1] : status.activeAccountId;
  const login = await chatGPTAuth.startLogin(accountId, false);
  console.log(msg("chatgpt.cliOpenUrl"));
  console.log(login.url); // No retained ID-token hint is included in the CLI URL.
  process.once("SIGINT", () => { chatGPTAuth.close(); process.exit(130); });
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await chatGPTAuth.status();
    if (current.attempt?.status === "pending") continue;
    if (current.attempt?.status !== "complete") throw new Error(current.attempt?.error ?? msg("err.chatgptLoginIncomplete"));
    if (!current.planEnabled) throw new Error(msg("err.chatgptPlanMissing"));
    console.log(msg("chatgpt.cliDone"));
    break;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : msg("err.chatgptCliFailed"));
  process.exitCode = 1;
} finally {
  chatGPTAuth.close();
}
