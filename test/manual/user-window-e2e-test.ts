// Live check of "agent tabs as background tabs in the user's window" against a throwaway headless Chrome with its own
// user-data-dir, port and daemon socket. A real Chrome and a real daemon on this machine are never touched.
//   node --conditions=import --import tsx test/manual/user-window-e2e-test.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserClient } from "../../src/client";
import { createDaemon } from "../../src/daemon/index";
import { createIpcServer } from "../../src/daemon/server";
import { createCdpBridge } from "../../src/daemon/bridge";
import { createDaemonTransport } from "../../src/daemon/transport";
import { openIsolatedTab, closeIsolatedTab } from "../../src/domains/isolated-tab";
import { ok } from "../../src/util/result";

const PORT = Number(process.env["USER_WINDOW_E2E_PORT"] ?? 9478);
const CHROME = process.env["CHROME_BIN"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.error(`  ✗ ${label}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Target = { targetId: string; type: string; url: string; browserContextId?: string };

async function main(): Promise<void> {
  Reflect.deleteProperty(process.env, "PI_BROWSER_TAB_GROUPS");
  Reflect.deleteProperty(process.env, "PI_BROWSER_DEDICATED_WINDOW");
  if (!existsSync(CHROME)) { console.log("SKIP: no Chrome at", CHROME); return; }
  const udd = mkdtempSync(join(tmpdir(), "pi-userwin-e2e-"));
  const socketPath = join(udd, "daemon.sock");
  const browser = spawn(CHROME, ["--headless=new", `--user-data-dir=${udd}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "data:text/html,<title>mine</title>user tab"], { detached: true, stdio: "ignore" });
  let daemon: ReturnType<typeof createDaemon> | undefined;
  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = ((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl; } catch { /* not up */ }
    }
    if (!wsUrl) { check(false, "headless Chrome exposed DevTools"); return; }
    const endpoint = wsUrl;
    // The throwaway browser's Local State: Default is the last-used profile, as on the real machine.
    await sleep(500);
    writeFileSync(join(udd, "Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Person 1" } } } }));

    daemon = createDaemon({
      ipcServer: createIpcServer({ socketPath }),
      cdpBridge: createCdpBridge({ discoverWsUrl: () => Promise.resolve(ok(endpoint)) }),
      exit: () => undefined,
      log: () => undefined,
    });
    await daemon.start();

    // /json/list reports each page as {id, url, type}.
    const list = async (): Promise<Target[]> =>
      ((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>)
        .filter((t) => t.type === "page").map((t) => ({ targetId: t.id, type: t.type, url: t.url }));
    const before = await list();
    check(before.length === 1, `one user tab before the harness connects (${before.length})`);
    const userTab = before[0];

    const pin = { userDataDir: udd, profileDir: "Default", label: "Person 1", savedAt: "" };
    const mk = (ns: string): ReturnType<typeof createBrowserClient> => createBrowserClient({
      namespace: ns,
      transport: createDaemonTransport(ns, socketPath),
      remote: { cdpUrl: endpoint, browserId: endpoint.split("/").pop() ?? "" },
      profilePin: pin,
    });

    const a = mk("uw-a");
    check(await a.placesTabsInUserWindow(), "pinned profile is last used, so tabs go to the user's window");
    const started = await a.start();
    check(started.success, `client A starts${started.success ? "" : `: ${started.error.message}`}`);
    if (!started.success) return;
    const iso = await openIsolatedTab(a);
    check(iso.success, "a search/read tab opens");
    const t2 = await a.newTab("data:text/html,<title>a2</title>a2");
    check(t2.success, "a second agent tab opens");
    const b = mk("uw-b");
    check((await b.start()).success, "a second session starts");
    check((await b.newTab()).success, "the second session opens a tab");

    // Window membership and visibility, read over a raw connection to the browser endpoint.
    const ws = new WebSocket(endpoint);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pend = new Map<number, (v: Record<string, unknown>) => void>();
    ws.onmessage = (m): void => { const d = JSON.parse(String(m.data)) as { id?: number }; if (d.id !== undefined) pend.get(d.id)?.(d as Record<string, unknown>); };
    const call = (method: string, params: object, sessionId?: string): Promise<Record<string, unknown>> =>
      new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const live = (((await call("Target.getTargets", {}))["result"] as { targetInfos: Target[] }).targetInfos).filter((t) => t.type === "page");
    const windows = new Map<number, number>();
    const visible: string[] = [];
    for (const p of live) {
      const w = (await call("Browser.getWindowForTarget", { targetId: p.targetId }))["result"] as { windowId: number } | undefined;
      if (w) windows.set(w.windowId, (windows.get(w.windowId) ?? 0) + 1);
      const att = (await call("Target.attachToTarget", { targetId: p.targetId, flatten: true }))["result"] as { sessionId: string } | undefined;
      if (!att) continue;
      const v = (await call("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, att.sessionId))["result"] as { result: { value: string } } | undefined;
      if (v?.result.value === "visible") visible.push(p.targetId);
      await call("Target.detachFromTarget", { sessionId: att.sessionId });
    }
    check(windows.size === 1, `every live tab is in one window, no new window (${[...windows.values()].join("+")} tabs over ${windows.size} window(s), ${live.length} live)`);
    check(visible.length === 1 && visible[0] === userTab?.targetId, `the user's tab is still the only visible one (${visible.length} visible)`);
    ws.close();

    if (iso.success) await closeIsolatedTab(a, iso.data);
    await a.closeOwnedTabs();
    await b.closeOwnedTabs();
    const after = await list();
    check(after.length === 1 && after[0]?.targetId === userTab?.targetId, `only the user's tab is left after both sessions clean up (${after.length})`);
    await a.stop();
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
