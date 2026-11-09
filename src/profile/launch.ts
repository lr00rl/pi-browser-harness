// CDP cannot open a window in another profile, so this goes through the command line: ProcessSingleton hands the argv to the running browser.
// The sentinel must ride on a real `file://` URL — Chrome discards a bare `about:blank#token` argument and opens chrome://newtab instead.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Result, err, ok } from "../util/result";

export type ProfileWindowRequest = {
  readonly exePath: string;
  readonly profileDir: string;
  readonly explicitUserDataDir?: string;
};

export type ProfileWindowHandle = {
  readonly sentinelUrl: string;
  readonly cleanup: () => Promise<void>;
  readonly kill: () => void;
};

// The app bundle that holds a macOS browser executable (`/Applications/X.app/Contents/MacOS/X` gives `/Applications/X.app`).
const macAppBundle = (exePath: string): string | undefined => {
  const marker = ".app/Contents/MacOS/";
  const i = exePath.indexOf(marker);
  return i < 0 ? undefined : exePath.slice(0, i + ".app".length);
};

// The process that hands `browserArgs` to the running browser. On macOS, exec'ing the browser binary is a user-style
// launch and the browser takes focus from the user's app; `open -g -n` passes the same argv through LaunchServices
// without bringing the app forward (-n starts the short-lived forwarding process that ProcessSingleton needs, since
// `open` drops --args for an app that is already running).
export const launchCommand = (
  exePath: string,
  browserArgs: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const bundle = platform === "darwin" ? macAppBundle(exePath) : undefined;
  return bundle === undefined
    ? { command: exePath, args: browserArgs }
    : { command: "open", args: ["-g", "-n", "-a", bundle, "--args", ...browserArgs] };
};

// `open` hands the argv to LaunchServices and exits within a second; a non-zero exit means nothing was launched.
const OPEN_EXIT_WAIT_MS = 5_000;

const SENTINEL_HTML = (token: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${token}</title>` +
  `<body style="font:14px system-ui;padding:2rem;color:#555">pi browser harness — opening this profile…</body>`;

export const openProfileWindow = async (
  req: ProfileWindowRequest,
): Promise<Result<ProfileWindowHandle, string>> => {
  const token = `pi-harness-${randomUUID()}`;
  const file = join(tmpdir(), `${token}.html`);
  try {
    await writeFile(file, SENTINEL_HTML(token), "utf8");
  } catch (e) {
    return err(`could not write the profile handshake page: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sentinelUrl = pathToFileURL(file).href;
  const args: string[] = [];
  if (req.explicitUserDataDir) args.push(`--user-data-dir=${req.explicitUserDataDir}`);
  args.push(`--profile-directory=${req.profileDir}`, "--new-window", sentinelUrl);

  const discardSentinel = (): Promise<void> => rm(file, { force: true }).catch(() => undefined);

  const launch = launchCommand(req.exePath, args);
  let child: ChildProcess;
  try {
    child = spawn(launch.command, [...launch.args], { detached: true, stdio: "ignore" });
  } catch (e) {
    await discardSentinel();
    return err(`could not launch ${req.exePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Listened for before anything is awaited, so a fast `open` cannot exit unobserved.
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => { resolve(code); });
  });

  // spawn() reports a bad binary asynchronously as an 'error' event rather than throwing; unhandled, an ENOENT looked like the 15s sentinel timeout.
  const spawnFailure = await new Promise<string | undefined>((resolve) => {
    child.once("spawn", () => { resolve(undefined); });
    child.once("error", (e: Error) => { resolve(e.message); });
  });
  // A later 'error' event with no listener would throw, so keep one attached for the detached launcher's lifetime.
  child.on("error", () => undefined);
  child.unref();

  if (spawnFailure) {
    await discardSentinel();
    return err(`could not launch ${req.exePath}: ${spawnFailure}`);
  }

  // Through `open`, a missing bundle or a LaunchServices refusal shows up only as the exit code; without this check it
  // looked like the 15s sentinel timeout. A launcher still running at the deadline is left to the sentinel poll.
  if (launch.command === "open") {
    // The timer stays referenced: the launcher is unref'd, so this wait is what keeps the event loop alive for its exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      exited,
      new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, OPEN_EXIT_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (code !== null && code !== 0) {
      await discardSentinel();
      return err(`could not launch ${req.exePath}: \`open -g\` exited with code ${code}`);
    }
  }

  let live: ChildProcess | null = child;

  return ok({
    sentinelUrl,
    cleanup: discardSentinel,
    kill: () => {
      if (live) {
        try {
          live.kill("SIGTERM");
        } catch {
          // The process already exited; there is nothing left to kill.
        }
        live = null;
      }
    },
  });
};
