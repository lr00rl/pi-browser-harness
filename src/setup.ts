import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";
import { isBrowserRunning } from "./profile/browser-process";
import { promptForProfileIfUnset } from "./profile/command";
import { type Result, err, ok } from "./util/result";
import { tabGroupStatus } from "./cdp/tab-group";

// The machine probes setup runs before touching the client. Each defaults to the real implementation.
export type SetupDeps = {
  readonly isBrowserRunning?: () => Promise<boolean>;
  readonly ensureDaemon?: () => Promise<boolean>;
};

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient, deps: SetupDeps = {}): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      const result = await performSetup(client, ctx, deps);
      if (result.success) {
        ctx.ui.notify(result.data, "info");
      } else {
        ctx.ui.notify(result.error, "error");
      }
    },
  });
}

export type SetupResult = Result<string, string>;

export async function performSetup(
  client: BrowserClient,
  ctx?: ExtensionContext,
  deps: SetupDeps = {},
): Promise<SetupResult> {
  const chromeRunning = await (deps.isBrowserRunning ?? isBrowserRunning)();
  if (!chromeRunning) {
    return err("No browser instance running. Please open your browser and then run /browser-setup.");
  }

  const daemonReady = await (deps.ensureDaemon ?? ensureDaemon)();
  if (!daemonReady) {
    return err(`Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.`);
  }

  const profileNote = await promptForProfileIfUnset(client, ctx);

  const startResult = await client.start({ reconnectNow: true });
  if (!startResult.success) {
    const msg = startResult.error.message;
    const lower = msg.toLowerCase();

    if (
      lower.includes("devtoolsactiveport") ||
      lower.includes("remote debugging") ||
      lower.includes("econnrefused") ||
      lower.includes("cannot reach chrome devtools")
    ) {
      return err(
        "Browser remote debugging needs to be enabled.\n\n" +
          "Open chrome://inspect/#remote-debugging (or brave://inspect,\n" +
          "edge://inspect) in your browser, tick the\n" +
          '"Discover network targets" / Allow checkbox, then retry.\n\n' +
          "Agent: stop here and ask the user to do this. Do not launch or kill a browser yourself.\n\n" +
          "Or set BU_CDP_WS to a remote browser WebSocket URL.",
      );
    }

    return err(`Connection failed: ${msg}`);
  }

  // start() already attached to an agent tab (a fresh one when none survived), so no test page is opened.
  const lines = ["Browser connected ✓", `Agent tabs: ${tabGroupStatus(client)}`];
  if (profileNote) lines.push(profileNote);
  return ok(lines.join("\n"));
}

