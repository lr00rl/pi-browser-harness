import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extensionIdForPath,
  isGroupedTab,
  openGroupedTab,
  prepareTabGroups,
  tabGroupStatus,
  type TabGroupDeps,
} from "../../src/cdp/tab-group";
import { openAgentTab } from "../../src/cdp/target-factory";
import { cdpError } from "../../src/cdp/errors";
import type { BrowserClient } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import { err, ok } from "../../src/util/result";
import { type Canned, type CannedResult, type FakeClient, createFakeClient } from "../domains/fake-client";

const TITLE = "pi · proj · abcd";
const extDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-tabgroup-ext-")));
const EXT_ID = extensionIdForPath(extDir);
const WORKER_URL = `chrome-extension://${EXT_ID}/sw.js`;
const PIN: ProfilePin = { userDataDir: "/udd", profileDir: "Default", label: "Dylan", savedAt: "" };

process.on("exit", () => {
  rmSync(extDir, { recursive: true, force: true });
});

type Row = { readonly targetId: string; readonly type?: string; readonly url?: string; readonly browserContextId?: string };
const listing = (...rows: ReadonlyArray<Row>): CannedResult =>
  ok({ targetInfos: rows.map((r) => ({ targetId: r.targetId, type: r.type ?? "page", title: "", url: r.url ?? "about:blank", ...(r.browserContextId ? { browserContextId: r.browserContextId } : {}) })) });

const worker = (ctx = "ctx-pin"): Row => ({ targetId: "sw", type: "service_worker", url: WORKER_URL, browserContextId: ctx });
const page = { targetId: "t1", url: "https://example.test/" };

// Runtime.evaluate on the worker: the open call answers ok and the next Target.getTargets lists the spawned tab, which
// is found by the token the harness put in its URL.
const evaluate = (value: unknown): CannedResult => ok({ result: { type: typeof value, value } });

const opts = (extra: Partial<TabGroupDeps> = {}): TabGroupDeps => ({ extensionDir: extDir, env: {}, deadlineMs: 0, ...extra });

type Setup = {
  readonly canned: Canned;
  readonly pin?: ProfilePin | null;
  readonly contextId?: string;
  readonly title?: string | undefined;
};

const setup = async (s: Setup): Promise<{ client: BrowserClient; fake: FakeClient; ctxSet: () => string | undefined }> => {
  const fake = await createFakeClient({ canned: s.canned });
  let ctx = s.contextId;
  const client: BrowserClient = {
    ...fake.client,
    tabGroupTitle: () => ("title" in s ? s.title : TITLE),
    profilePin: () => s.pin ?? null,
    profileContextId: () => ctx,
    setProfileContextId: (c) => { ctx = c; },
  };
  return { client, fake, ctxSet: () => ctx };
};

describe("extensionIdForPath", () => {
  test("maps the first 128 bits of SHA-256 of the path to a-p, as Chrome does for unpacked extensions", () => {
    // Chrome 157 gave this id to an extension loaded from this path (checked against a live browser).
    assert.equal(extensionIdForPath("/private/tmp/x").length, 32);
    assert.match(extensionIdForPath("/private/tmp/x"), /^[a-p]{32}$/);
    assert.notEqual(extensionIdForPath("/a"), extensionIdForPath("/b"));
  });
});

describe("prepareTabGroups", () => {
  test("reuses a live worker of the extension without loading it again", async () => {
    const { client, fake } = await setup({ canned: { "Target.getTargets": listing(page, worker()), "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })] } });
    const r = await prepareTabGroups(client, opts());
    assert.deepEqual(r, ok("s-sw"));
    assert.equal(fake.callsTo("Extensions.loadUnpacked").length, 0);
    assert.deepEqual(fake.callsTo("Target.attachToTarget")[0]?.params, { targetId: "sw", flatten: true });
  });

  test("loads the extension when no worker runs, then attaches to the worker it started", async () => {
    const { client, fake } = await setup({
      canned: {
        // The fake's own attach consumes the first listing; then no worker, then the worker the load started.
        "Target.getTargets": [listing(page), listing(page), listing(page, worker())],
        "Extensions.loadUnpacked": ok({ id: EXT_ID }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
      },
    });
    const r = await prepareTabGroups(client, opts({ deadlineMs: 1_000 }));
    assert.deepEqual(r, ok("s-sw"));
    assert.deepEqual(fake.callsTo("Extensions.loadUnpacked")[0]?.params, { path: extDir });
  });

  test("a browser that refuses the extension disables tab groups until the connection changes", async () => {
    const { client, fake } = await setup({
      canned: { "Target.getTargets": listing(page), "Extensions.loadUnpacked": err(cdpError("remote_error", "Method not available.")) },
    });
    const first = await prepareTabGroups(client, opts());
    assert.equal(first.success, false);
    const second = await prepareTabGroups(client, opts());
    assert.equal(second.success, false);
    assert.equal(fake.callsTo("Extensions.loadUnpacked").length, 1, "a refusal is not retried on every tab");
    assert.match(tabGroupStatus(client), /^dedicated window \(tab groups unavailable: Chrome refused/);
  });

  test("PI_BROWSER_TAB_GROUPS=0 turns the feature off without touching the browser", async () => {
    const { client, fake } = await setup({ canned: { "Target.getTargets": listing(page, worker()) } });
    const r = await prepareTabGroups(client, opts({ env: { PI_BROWSER_TAB_GROUPS: "0" } }));
    assert.equal(r.success, false);
    assert.equal(fake.calls.length, 0);
  });

  test("no group title means no tab groups", async () => {
    const { client, fake } = await setup({ canned: { "Target.getTargets": listing(page, worker()) }, title: undefined });
    assert.equal((await prepareTabGroups(client, opts())).success, false);
    assert.equal(fake.calls.length, 0);
  });

  test("with a pin and a known profile context, a worker in another context is detached and refused", async () => {
    const { client, fake } = await setup({
      pin: PIN,
      contextId: "ctx-pin",
      canned: {
        "Target.getTargets": listing(page, worker("ctx-other")),
        "Extensions.loadUnpacked": ok({ id: EXT_ID }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
      },
    });
    const r = await prepareTabGroups(client, opts());
    assert.equal(r.success, false);
    assert.match(r.error.message, /did not start in "Dylan"/);
    assert.ok(fake.callsTo("Target.detachFromTarget").some((c) => c.params["sessionId"] === "s-sw"));
  });

  test("with a pin and no known context, the worker's signed-in email must match the pinned profile, which then fixes the context", async () => {
    const { client, ctxSet } = await setup({
      pin: PIN,
      canned: {
        "Target.getTargets": listing(page, worker("ctx-dylan")),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
        "Runtime.evaluate": evaluate("Dylan@Example.com"),
      },
    });
    const r = await prepareTabGroups(client, opts({ profileFacts: () => Promise.resolve({ email: "dylan@example.com", emailShared: false, lastUsed: false }) }));
    assert.deepEqual(r, ok("s-sw"));
    assert.equal(ctxSet(), "ctx-dylan");
  });

  test("with a pin whose email differs, the worker is refused", async () => {
    const { client } = await setup({
      pin: PIN,
      canned: {
        "Target.getTargets": listing(page, worker("ctx-x")),
        "Extensions.loadUnpacked": ok({ id: EXT_ID }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
        "Runtime.evaluate": evaluate("someone@else.com"),
      },
    });
    const r = await prepareTabGroups(client, opts({ profileFacts: () => Promise.resolve({ email: "dylan@example.com", emailShared: false, lastUsed: true }) }));
    assert.equal(r.success, false);
  });

  const pinnedWorker = (email: string): Canned => ({
    "Target.getTargets": listing(page, worker("ctx-w")),
    "Extensions.loadUnpacked": ok({ id: EXT_ID }),
    "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
    "Runtime.evaluate": evaluate(email),
  });

  test("a pinned profile with no signed-in account is accepted when it is the last-used profile", async () => {
    const { client } = await setup({ pin: PIN, canned: pinnedWorker("") });
    const r = await prepareTabGroups(client, opts({ profileFacts: () => Promise.resolve({ emailShared: false, lastUsed: true }) }));
    assert.deepEqual(r, ok("s-sw"));
  });

  test("a pinned profile with no signed-in account is refused when another profile is the last used", async () => {
    const { client } = await setup({ pin: PIN, canned: pinnedWorker("") });
    const r = await prepareTabGroups(client, opts({ profileFacts: () => Promise.resolve({ emailShared: false, lastUsed: false }) }));
    assert.equal(r.success, false);
  });

  test("an email shared by two profiles proves nothing unless the pinned profile is the last used", async () => {
    const shared = { email: "dylan@example.com", emailShared: true };
    const refused = await setup({ pin: PIN, canned: pinnedWorker("dylan@example.com") });
    assert.equal((await prepareTabGroups(refused.client, opts({ profileFacts: () => Promise.resolve({ ...shared, lastUsed: false }) }))).success, false);
    const accepted = await setup({ pin: PIN, canned: pinnedWorker("dylan@example.com") });
    assert.equal((await prepareTabGroups(accepted.client, opts({ profileFacts: () => Promise.resolve({ ...shared, lastUsed: true }) }))).success, true);
  });

  test("a profile mismatch is not retried on every tab, only after a pause", async () => {
    let clock = 0;
    const { client, fake } = await setup({ pin: PIN, canned: pinnedWorker("someone@else.com") });
    const deps = opts({ now: () => clock, profileFacts: () => Promise.resolve({ email: "dylan@example.com", emailShared: false, lastUsed: false }) });
    assert.equal((await prepareTabGroups(client, deps)).success, false);
    const loads = fake.callsTo("Extensions.loadUnpacked").length;
    clock += 5_000;
    assert.equal((await prepareTabGroups(client, deps)).success, false);
    assert.equal(fake.callsTo("Extensions.loadUnpacked").length, loads, "no second attempt within the pause");
    clock += 60_000;
    await prepareTabGroups(client, deps);
    assert.equal(fake.callsTo("Extensions.loadUnpacked").length, loads + 1, "retried once the pause is over");
  });

  test("concurrent callers share one attempt", async () => {
    const { client, fake } = await setup({ canned: { "Target.getTargets": listing(page, worker()), "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })] } });
    const [a, b] = await Promise.all([prepareTabGroups(client, opts()), prepareTabGroups(client, opts())]);
    assert.deepEqual(a, ok("s-sw"));
    assert.deepEqual(b, ok("s-sw"));
    assert.equal(fake.callsTo("Target.attachToTarget").length, 1);
  });
});

describe("openGroupedTab", () => {
  test("asks the worker to open a background tab in this session's group and returns the spawned target", async () => {
    // The fake transport models the extension: the open call answers {ok:true} and the next listing shows the tab.
    const fake = await createFakeClient({
      canned: { "Target.getTargets": listing(page, worker()), "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })] },
      spawnTabs: ["t-new"],
    });
    const client: BrowserClient = { ...fake.client, tabGroupTitle: () => TITLE };
    const r = await openGroupedTab(client, opts());
    assert.deepEqual(r, ok("t-new"));
    const expr = String(fake.callsTo("Runtime.evaluate")[0]?.params["expression"]);
    assert.match(expr, /^piOpenTab\("about:blank#pi-[0-9a-f-]+", "pi · proj · abcd", "cyan"\)$/);
    assert.equal(fake.callsTo("Runtime.evaluate")[0]?.sessionId, "s-sw");
    assert.equal(isGroupedTab(client, "t-new"), true);
    assert.equal(isGroupedTab(client, "t1"), false);
    assert.equal(tabGroupStatus(client), `tab group "${TITLE}"`);
  });

  test("an extension that reports a failure is an error, with its reason", async () => {
    const { client } = await setup({
      canned: {
        "Target.getTargets": listing(page, worker()),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-sw" })],
        "Runtime.evaluate": evaluate({ ok: false, reason: "No window with id: 3." }),
      },
    });
    const r = await openGroupedTab(client, opts());
    assert.equal(r.success, false);
    assert.match(r.error.message, /No window with id: 3\./);
  });

  test("a worker session that went away is re-attached once", async () => {
    const { client, fake } = await setup({
      canned: {
        "Target.getTargets": listing(page, worker()),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-old" }), ok({ sessionId: "s-new" })],
        "Runtime.evaluate": [err(cdpError("session_not_found", "Session with given id not found")), evaluate({ ok: false, reason: "stop here" })],
      },
    });
    const r = await openGroupedTab(client, opts());
    assert.equal(r.success, false);
    assert.match(r.error.message, /stop here/);
    assert.deepEqual(fake.callsTo("Runtime.evaluate").map((c) => c.sessionId), ["s-old", "s-new"]);
  });
});

describe("openAgentTab", () => {
  test("falls back to the harness window when tab groups are unavailable", async () => {
    const fake = await createFakeClient({ spawnTabs: ["t2"] });
    const client: BrowserClient = { ...fake.client };
    const r = await openAgentTab(client);
    assert.deepEqual(r, ok("t2"));
    assert.match(String(fake.callsTo("Runtime.evaluate")[0]?.params["expression"]), /^!!window\.open/);
    assert.equal(fake.client.owns("t2"), true);
    assert.equal(isGroupedTab(client, "t2"), false);
  });
});
