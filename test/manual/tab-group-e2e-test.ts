// Live check of agent tab groups against a throwaway headless Chrome: its own user-data-dir, its own port and its own
// daemon socket, so a real Chrome and a real daemon on this machine are never touched.
//   node --conditions=import --import tsx test/manual/tab-group-e2e-test.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserClient } from "../../src/client";
import { createDaemon } from "../../src/daemon/index";
import { createIpcServer } from "../../src/daemon/server";
import { createCdpBridge } from "../../src/daemon/bridge";
import { createDaemonTransport } from "../../src/daemon/transport";
import { isGroupedTab, tabGroupStatus } from "../../src/cdp/tab-group";
import { openIsolatedTab, closeIsolatedTab } from "../../src/domains/isolated-tab";
import { ok } from "../../src/util/result";

const PORT = Number(process.env["TAB_GROUP_E2E_PORT"] ?? 9477);
const CHROME = process.env["CHROME_BIN"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.error(`  ✗ ${label}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A raw CDP connection of its own, for reading the browser's tab strip through the helper extension's worker.
const rawCdp = async (wsUrl: string): Promise<{ call: (m: string, p?: object, s?: string) => Promise<Record<string, unknown>>; close: () => void }> => {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  ws.onmessage = (m): void => {
    const d = JSON.parse(String(m.data)) as { id?: number } & Record<string, unknown>;
    if (d.id !== undefined) pending.get(d.id)?.(d);
  };
  return {
    call: (method, params = {}, sessionId) => new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    close: () => { ws.close(); },
  };
};

async function main(): Promise<void> {
  process.env["PI_BROWSER_TAB_GROUPS"] = "1";
  if (!existsSync(CHROME)) { console.log("SKIP: no Chrome at", CHROME); return; }
  const udd = mkdtempSync(join(tmpdir(), "pi-tabgroup-e2e-"));
  const socketPath = join(udd, "daemon.sock");
  const browser = spawn(CHROME, ["--headless=new", `--user-data-dir=${udd}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "about:blank"], { detached: true, stdio: "ignore" });
  let daemon: ReturnType<typeof createDaemon> | undefined;
  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = ((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl; } catch { /* not up yet */ }
    }
    if (!wsUrl) { check(false, "headless Chrome exposed DevTools"); return; }
    const endpoint = wsUrl;

    daemon = createDaemon({
      ipcServer: createIpcServer({ socketPath }),
      cdpBridge: createCdpBridge({ discoverWsUrl: () => Promise.resolve(ok(endpoint)) }),
      exit: () => undefined,
      log: () => undefined,
    });
    await daemon.start();

    const raw = await rawCdp(endpoint);
    const pages = async (): Promise<Array<{ targetId: string; url: string }>> =>
      ((await raw.call("Target.getTargets"))["result"] as { targetInfos: Array<{ targetId: string; url: string; type: string }> }).targetInfos.filter((t) => t.type === "page");
    // The user's own tab: an ordinary page, active in the only window, opened before the harness connects.
    const userTab = (await pages())[0];
    check(userTab !== undefined, "the user's tab exists before the harness connects");

    const makeClient = (ns: string, title: string): ReturnType<typeof createBrowserClient> =>
      createBrowserClient({ namespace: ns, transport: createDaemonTransport(ns, socketPath), remote: { cdpUrl: endpoint, browserId: endpoint.split("/").pop() ?? "" }, tabGroupTitle: title });

    const a = makeClient("e2e-a", "pi · alpha · aaaa");
    const started = await a.start();
    check(started.success, `client A starts${started.success ? "" : `: ${started.error.message}`}`);
    if (!started.success) return;
    check(tabGroupStatus(a) === 'tab group "pi · alpha · aaaa"', `client A uses its tab group (${tabGroupStatus(a)})`);
    const first = a.current()?.targetId;
    check(first !== undefined && first !== userTab?.targetId, "client A attached to a tab of its own, not the user's");
    check(first !== undefined && isGroupedTab(a, first), "that tab is a grouped tab");

    const t2 = await a.newTab("data:text/html,<title>a2</title>a2");
    check(t2.success, "client A opens a second tab");
    const iso = await openIsolatedTab(a);
    check(iso.success, "an isolated (read/search) tab opens in the group too");
    if (iso.success) await closeIsolatedTab(a, iso.data);

    const b = makeClient("e2e-b", "pi · beta · bbbb");
    const bStarted = await b.start();
    check(bStarted.success, "client B (a second pi session) starts against the same Chrome");
    const bt = await b.newTab();
    check(bt.success, "client B opens a tab");

    // Read the tab strip through the extension's worker.
    const workers = ((await raw.call("Target.getTargets"))["result"] as { targetInfos: Array<{ targetId: string; url: string; type: string }> }).targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
    const sw = workers.find((w) => w.url.startsWith("chrome-extension://"));
    check(sw !== undefined, "the agent-tabs extension worker is running");
    if (sw) {
      const s = ((await raw.call("Target.attachToTarget", { targetId: sw.targetId, flatten: true }))["result"] as { sessionId: string }).sessionId;
      const evald = await raw.call("Runtime.evaluate", {
        expression: "(async()=>JSON.stringify({groups:(await chrome.tabGroups.query({})).map(g=>({t:g.title,c:g.color,w:g.windowId})),tabs:(await chrome.tabs.query({})).map(t=>({g:t.groupId,a:t.active,w:t.windowId}))}))()",
        awaitPromise: true, returnByValue: true,
      }, s);
      const strip = JSON.parse(String(((evald["result"] as { result: { value: unknown } }).result.value))) as { groups: Array<{ t: string; c: string; w: number }>; tabs: Array<{ g: number; a: boolean; w: number }> };
      const titles = strip.groups.map((g) => g.t).sort();
      check(JSON.stringify(titles) === JSON.stringify(["pi · alpha · aaaa", "pi · beta · bbbb"]), `one group per session (${titles.join(", ")})`);
      check(strip.groups.every((g) => g.c === "cyan"), "groups are cyan");
      const user = strip.tabs.find((t) => t.g === -1);
      check(strip.tabs.filter((t) => t.g === -1).length === 1, "exactly one tab sits outside the agent groups (the user's)");
      check(user?.a === true, "the user's tab is still the active tab");
      check(user?.g === -1, "the user's tab is not put in any group");
      check(strip.groups.every((g) => g.w === user?.w), "agent groups sit in the user's window, not in a new one");
      const windows = new Set(strip.tabs.map((t) => t.w));
      check(windows.size === 1, `no extra window was opened (${windows.size})`);
    }

    // The user opens a link from one of A's grouped tabs (window.open from the page = an opener chain to an owned tab).
    const aTab = a.current()?.targetId;
    let userPopup: string | undefined;
    if (aTab) {
      const s = ((await raw.call("Target.attachToTarget", { targetId: aTab, flatten: true }))["result"] as { sessionId: string }).sessionId;
      await raw.call("Runtime.evaluate", { expression: "window.open('about:blank#user-link','_blank')", userGesture: true }, s);
      await sleep(500);
      userPopup = (await pages()).find((p) => p.url.endsWith("#user-link"))?.targetId;
    }

    // pi restarts: a new client with A's persisted ownership reattaches to the same browser.
    const restoredOwned = a.ownership().list();
    const restoredWindowId = a.ownership().harnessWindowId();
    const a2 = createBrowserClient({
      namespace: "e2e-a2",
      transport: createDaemonTransport("e2e-a2", socketPath),
      remote: { cdpUrl: endpoint, browserId: endpoint.split("/").pop() ?? "" },
      tabGroupTitle: "pi · alpha · aaaa",
      initialOwnership: { ownedTargetIds: restoredOwned, ...(restoredWindowId !== undefined ? { harnessWindowId: restoredWindowId } : {}) },
    });
    check(restoredWindowId === undefined, "a tab-group session records no harness window (the user's window is not claimed)");
    const a2Started = await a2.start();
    check(a2Started.success, "the restarted session reattaches");
    check(a2.ownership().harnessWindowId() === undefined, "after the restart the user's window is still not the harness window");
    const switched = aTab ? await a2.switchTab(aTab) : undefined;
    check(switched?.success === true, "the restarted session can drive its old grouped tab");
    await a.stop();

    // A page opened from an agent tab joins the agent's group in Chrome, and the harness owns it like any popup of its
    // own tabs, so it closes with the session.
    check(userPopup !== undefined && a2.ownership().has(userPopup), "a tab opened from an agent tab belongs to that session");
    await a2.closeOwnedTabs();
    const after = await pages();
    check(after.some((p) => p.targetId === userTab?.targetId), "closing A's tabs leaves the user's tab open");
    check(after.some((p) => bt.success && p.targetId === bt.data), "closing A's tabs leaves B's tab open");
    raw.close();
    await a2.stop();
    await b.stop();
  } finally {
    await daemon?.stop();
    try { process.kill(-(browser.pid ?? 0), "SIGKILL"); } catch { try { browser.kill("SIGKILL"); } catch { /* gone */ } }
    await sleep(500);
    rmSync(udd, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
