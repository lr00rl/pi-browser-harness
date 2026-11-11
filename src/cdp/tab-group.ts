// Agent tabs as background tabs in the user's own window, filed under one tab group per pi session, the way the
// Claude and Codex browser extensions do it. CDP has no tab-group API, so this loads a small helper extension
// (assets/agent-tabs-extension) with Extensions.loadUnpacked, attaches to its service worker and asks it to open each
// tab. The extension lives only until Chrome exits; every connection loads it again (a load of the same path is a
// no-op that also wakes a sleeping worker).
//
// Extensions.loadUnpacked installs into the browser's last-used profile, which need not be the pinned one, so the
// worker's profile is checked against the pin (by its browser context, else by the signed-in email) before use.
// Anything that keeps the group path from working leaves the caller on the dedicated-window path instead.

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserClient } from "../client";
import { listProfiles } from "../profile/list";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import { sleep } from "../util/sleep";
import { type CdpError, cdpError } from "./errors";

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "agent-tabs-extension");
const GROUP_COLOR = "cyan";
const WORKER_DEADLINE_MS = 3_000;
const SPAWN_DEADLINE_MS = 8_000;
const POLL_MS = 100;
const EVAL_TIMEOUT_MS = 10_000;

// Chrome derives an unpacked extension's id from its absolute path: the first 128 bits of SHA-256, hex digits mapped
// to a-p. Knowing it up front lets an already-loaded worker be found without loading again.
export const extensionIdForPath = (path: string): string =>
  createHash("sha256").update(path).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// What Chrome's Local State says about the pinned profile: its signed-in email, whether another profile is signed in
// with the same email, and whether it is the last-used profile (the one Extensions.loadUnpacked installs into).
export type PinnedProfileFacts = {
  readonly email?: string;
  readonly emailShared: boolean;
  readonly lastUsed: boolean;
};

export type TabGroupDeps = {
  readonly extensionDir?: string;
  readonly profileFacts?: (userDataDir: string, profileDir: string) => Promise<PinnedProfileFacts>;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly deadlineMs?: number;
};

type State = {
  key: string;
  sessionId: string | undefined;
  // Set when the browser cannot load the extension at all (a remote browser, a policy). Cleared by a new connection.
  disabled: string | undefined;
  // Why the last attempt failed, for /browser-status.
  lastError: string | undefined;
  // When the extension last came up in a profile other than the pinned one. Chrome installs it into whichever profile
  // was used last, which changes when the user focuses another profile's window, so the check is retried, but not on
  // every tab: until MISMATCH_RETRY_MS has passed, tabs go straight to the dedicated window.
  mismatchAt: number | undefined;
  pending: Promise<Result<string, CdpError>> | undefined;
  readonly grouped: Set<string>;
};

const states = new WeakMap<BrowserClient, State>();

// A new browser connection or a new profile pin invalidates everything learned about the worker.
const stateFor = (client: BrowserClient): State => {
  const pin = client.profilePin();
  const key = `${client.status().remoteBrowserId ?? ""}|${pin ? `${pin.userDataDir}|${pin.profileDir}` : ""}`;
  const prior = states.get(client);
  if (prior?.key === key) return prior;
  const fresh: State = {
    key,
    sessionId: undefined,
    disabled: undefined,
    lastError: undefined,
    mismatchAt: undefined,
    pending: undefined,
    grouped: prior?.grouped ?? new Set(),
  };
  states.set(client, fresh);
  return fresh;
};

const MISMATCH_RETRY_MS = 60_000;

const defaultProfileFacts = async (userDataDir: string, profileDir: string): Promise<PinnedProfileFacts> => {
  const profiles = await listProfiles(userDataDir);
  const pinned = profiles.find((p) => p.dir === profileDir);
  const email = pinned?.email?.toLowerCase();
  return {
    ...(email !== undefined ? { email } : {}),
    emailShared: email !== undefined && profiles.filter((p) => p.email?.toLowerCase() === email).length > 1,
    lastUsed: pinned?.lastUsed ?? false,
  };
};

const evaluateOnWorker = async (
  client: BrowserClient,
  sessionId: string,
  expression: string,
): Promise<Result<unknown, CdpError>> => {
  const r = await client.session().callOnTarget(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    { timeoutMs: EVAL_TIMEOUT_MS },
  );
  if (!r.success) return r;
  if (r.data.exceptionDetails !== undefined) {
    return err(cdpError("remote_error", `agent-tabs extension threw: ${r.data.exceptionDetails.text}`, "Runtime.evaluate"));
  }
  return ok(r.data.result.value);
};

// True when the worker runs in the pinned profile; with no pin any profile will do.
// With the pinned profile's browser context known, the worker's context decides. Otherwise the worker's signed-in
// email must match the pin's, and the match only counts when no other profile shares that email; a profile with no
// signed-in account, or a shared email, is accepted only when Local State names the pinned profile as last used.
// Accepting a worker fixes the pinned context for the rest of the connection.
const inPinnedProfile = async (
  client: BrowserClient,
  sessionId: string,
  workerContextId: string | undefined,
  deps: TabGroupDeps,
): Promise<boolean> => {
  const pin = client.profilePin();
  if (!pin) return true;
  const known = client.profileContextId();
  if (known !== undefined) return workerContextId === known;
  const facts = await (deps.profileFacts ?? defaultProfileFacts)(pin.userDataDir, pin.profileDir);
  const actual = await evaluateOnWorker(client, sessionId, "piProfileEmail()");
  const workerEmail = actual.success && typeof actual.data === "string" ? actual.data.toLowerCase() : "";
  const accepted = facts.email !== undefined && !facts.emailShared
    ? workerEmail === facts.email
    : facts.lastUsed && workerEmail === (facts.email ?? "");
  if (accepted && workerContextId !== undefined) client.setProfileContextId(workerContextId);
  return accepted;
};

// Attaches to every live worker of the extension and keeps the one in the pinned profile; the others are detached.
const attachMatchingWorker = async (
  client: BrowserClient,
  extensionId: string,
  deps: TabGroupDeps,
): Promise<Result<string | undefined, CdpError>> => {
  const listed = await client.session().callBrowser("Target.getTargets");
  if (!listed.success) return listed;
  const prefix = `chrome-extension://${extensionId}/`;
  const workers = listed.data.targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith(prefix));
  for (const w of workers) {
    const attached = await client.session().attach(w.targetId);
    if (!attached.success) continue;
    if (await inPinnedProfile(client, attached.data, w.browserContextId, deps)) return ok(attached.data);
    await client.session().detach(attached.data);
  }
  return ok(undefined);
};

const connectWorker = async (client: BrowserClient, state: State, deps: TabGroupDeps): Promise<Result<string, CdpError>> => {
  let path: string;
  try {
    path = realpathSync(deps.extensionDir ?? EXTENSION_DIR);
  } catch (e) {
    state.disabled = `agent-tabs extension is missing (${e instanceof Error ? e.message : String(e)})`;
    return err(cdpError("discovery_failed", state.disabled));
  }
  const extensionId = extensionIdForPath(path);

  const now = deps.now ?? Date.now;
  if (state.mismatchAt !== undefined && now() - state.mismatchAt < MISMATCH_RETRY_MS) {
    return err(cdpError("discovery_failed", state.lastError ?? "the agent-tabs extension runs in another profile"));
  }

  const existing = await attachMatchingWorker(client, extensionId, deps);
  if (!existing.success) return existing;
  if (existing.data !== undefined) return ok(existing.data);

  const loaded = await client.session().callBrowser("Extensions.loadUnpacked", { path });
  if (!loaded.success) {
    // The browser answered and said no: retrying on every tab would only repeat it.
    if (loaded.error.kind === "remote_error") state.disabled = `Chrome refused the agent-tabs extension: ${loaded.error.message}`;
    return loaded;
  }

  const deadline = Date.now() + (deps.deadlineMs ?? WORKER_DEADLINE_MS);
  for (;;) {
    const found = await attachMatchingWorker(client, loaded.data.id, deps);
    if (!found.success) return found;
    if (found.data !== undefined) return ok(found.data);
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  const pin = client.profilePin();
  if (pin) state.mismatchAt = now();
  return err(cdpError(
    "discovery_failed",
    pin
      ? `the agent-tabs extension did not start in "${pin.label}" (Chrome loads it into the last-used profile; focus a window of that profile once)`
      : "the agent-tabs extension did not start",
  ));
};

// Resolves to the attached worker session. Concurrent callers share one attempt.
export const prepareTabGroups = (client: BrowserClient, deps: TabGroupDeps = {}): Promise<Result<string, CdpError>> => {
  const env = deps.env ?? process.env;
  if (env["PI_BROWSER_TAB_GROUPS"] === "0") return Promise.resolve(err(cdpError("discovery_failed", "tab groups are turned off (PI_BROWSER_TAB_GROUPS=0)")));
  if (client.tabGroupTitle() === undefined) return Promise.resolve(err(cdpError("discovery_failed", "no tab group title")));
  const state = stateFor(client);
  if (state.disabled !== undefined) return Promise.resolve(err(cdpError("discovery_failed", state.disabled)));
  if (state.sessionId !== undefined) return Promise.resolve(ok(state.sessionId));
  if (state.pending) return state.pending;
  const attempt = connectWorker(client, state, deps).then((r) => {
    if (r.success) {
      state.sessionId = r.data;
      state.lastError = undefined;
      state.mismatchAt = undefined;
    } else {
      state.lastError = r.error.message;
    }
    return r;
  }).finally(() => {
    state.pending = undefined;
  });
  state.pending = attempt;
  return attempt;
};

const findSpawned = async (client: BrowserClient, token: string, deadlineMs: number): Promise<Result<string, CdpError>> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const listed = await client.session().callBrowser("Target.getTargets");
    if (listed.success) {
      const tab = listed.data.targetInfos.find((t) => t.type === "page" && t.url.includes(token));
      if (tab) return ok(tab.targetId);
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  return err(cdpError("timeout", `the grouped tab did not report back within ${deadlineMs}ms`));
};

const isOpenResult = (v: unknown): v is { readonly ok: boolean; readonly reason?: unknown; readonly tabId?: unknown } =>
  typeof v === "object" && v !== null && "ok" in v && typeof v.ok === "boolean";

// Opens an about:blank tab in this session's tab group without activating it, and returns its target id. The caller
// owns the tab; nothing here records ownership.
export const openGroupedTab = async (client: BrowserClient, deps: TabGroupDeps = {}): Promise<Result<string, CdpError>> => {
  const title = client.tabGroupTitle();
  const token = `pi-${randomUUID()}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const worker = await prepareTabGroups(client, deps);
    if (!worker.success) return worker;
    const opened = await evaluateOnWorker(client, worker.data, safeJs`piOpenTab(${`about:blank#${token}`}, ${title}, ${GROUP_COLOR})`);
    if (!opened.success) {
      // The worker restarted or the connection was replaced: attach again, once.
      const state = stateFor(client);
      state.sessionId = undefined;
      state.lastError = opened.error.message;
      if (opened.error.kind === "session_not_found" && attempt === 1) continue;
      return opened;
    }
    if (!isOpenResult(opened.data) || !opened.data.ok) {
      const reason = isOpenResult(opened.data) ? String(opened.data.reason) : "unexpected reply";
      stateFor(client).lastError = reason;
      return err(cdpError("remote_error", `the agent-tabs extension could not open a tab: ${reason}`, "Runtime.evaluate"));
    }
    const spawned = await findSpawned(client, token, SPAWN_DEADLINE_MS);
    if (!spawned.success) {
      // The extension made the tab but CDP never showed it: close it so it is not left behind, unowned, in the group.
      const tabId = opened.data.tabId;
      if (typeof tabId === "number") await evaluateOnWorker(client, worker.data, safeJs`piCloseTab(${tabId})`);
      return spawned;
    }
    stateFor(client).grouped.add(spawned.data);
    return spawned;
  }
  return err(cdpError("session_not_found", "the agent-tabs extension worker kept going away"));
};

// A grouped tab sits in the user's window, so selecting it would change the tab the user is looking at.
export const isGroupedTab = (client: BrowserClient, targetId: string): boolean =>
  states.get(client)?.grouped.has(targetId) ?? false;

// Whether selecting `targetId` inside its window is safe: only a tab in the harness's own window qualifies. With tab
// groups active, an owned tab outside that window (one grouped before a pi restart, whose record is gone) is treated
// as grouped. A tab need not be selected to be driven: input, screenshots and JS work on a background tab.
export const maySelectTab = async (client: BrowserClient, targetId: string): Promise<boolean> => {
  if (isGroupedTab(client, targetId)) return false;
  // The recorded window id only ever names a window the harness created (see adoptHarnessWindowTabs).
  const harnessWindowId = client.ownership().harnessWindowId();
  if (harnessWindowId === undefined) return false;
  const win = await client.session().windowId(targetId);
  return win.success && win.data === harnessWindowId;
};

export const tabGroupStatus = (client: BrowserClient): string => {
  const state = states.get(client);
  const title = client.tabGroupTitle();
  if (state?.sessionId !== undefined && title !== undefined) return `tab group "${title}"`;
  const reason = state?.disabled ?? state?.lastError;
  return reason !== undefined ? `dedicated window (tab groups unavailable: ${reason})` : "not started";
};
