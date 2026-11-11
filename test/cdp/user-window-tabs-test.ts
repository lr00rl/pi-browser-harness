import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserClient } from "../../src/client";
import { pinIsLastUsedProfile } from "../../src/cdp/target-factory";
import type { ProfilePin } from "../../src/profile/store";
import { createStubTransport, type Canned } from "../domains/fake-client";
import { ok } from "../../src/util/result";

// A user-data-dir whose Local State names `lastUsed` as the last-used profile.
const userDataDir = (lastUsed: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-uwt-"));
  writeFileSync(join(dir, "Local State"), JSON.stringify({
    profile: {
      last_used: lastUsed,
      info_cache: { Default: { name: "Dylan", user_name: "d@example.com" }, "Profile 2": { name: "Talcum", user_name: "t@example.com" } },
    },
  }));
  return dir;
};

const pinFor = (dir: string, profileDir: string): ProfilePin => ({ userDataDir: dir, profileDir, label: profileDir, savedAt: "" });

const canned = (): Canned => ({
  "Target.setDiscoverTargets": ok({}),
  // The user's own tab is the only page: nothing is owned yet.
  "Target.getTargets": ok({ targetInfos: [{ targetId: "user-tab", type: "page", title: "Mine", url: "https://mine.test/" }] }),
  "Target.createTarget": ok({ targetId: "agent-tab" }),
  "Target.attachToTarget": ok({ sessionId: "s-agent" }),
  "Browser.getWindowForTarget": ok({ windowId: 1 }),
});

const dirs: string[] = [];
let savedEnv: string | undefined;
before(() => {
  savedEnv = process.env["PI_BROWSER_DEDICATED_WINDOW"];
  Reflect.deleteProperty(process.env, "PI_BROWSER_DEDICATED_WINDOW");
  Reflect.deleteProperty(process.env, "PI_BROWSER_TAB_GROUPS");
});
after(() => {
  if (savedEnv !== undefined) process.env["PI_BROWSER_DEDICATED_WINDOW"] = savedEnv;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const start = async (pin: ProfilePin | null) => {
  const stub = createStubTransport(canned());
  const client = createBrowserClient({
    namespace: "uwt",
    transport: stub.transport,
    remote: { cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc", browserId: "abc" },
    profilePin: pin,
  });
  const r = await client.start();
  return { stub, client, r };
};

// Without starting: the decision alone, so no fallback window seeding (and its timeout) runs.
const clientFor = (pin: ProfilePin | null) =>
  createBrowserClient({ namespace: "uwt", transport: createStubTransport(canned()).transport, profilePin: pin });

describe("agent tabs in the user's window", () => {
  test("pinIsLastUsedProfile follows Local State", async () => {
    const dir = userDataDir("Default");
    dirs.push(dir);
    assert.equal(await pinIsLastUsedProfile(pinFor(dir, "Default")), true);
    assert.equal(await pinIsLastUsedProfile(pinFor(dir, "Profile 2")), false);
  });

  test("with the pinned profile last used, start opens one background tab in the user's window and no new window", async () => {
    const dir = userDataDir("Default");
    dirs.push(dir);
    const { stub, client, r } = await start(pinFor(dir, "Default"));
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    const creates = stub.calls.filter((c) => c.method === "Target.createTarget").map((c) => c.params);
    assert.deepEqual(creates, [{ url: "about:blank", background: true }], "one background tab, never newWindow");
    assert.equal(stub.calls.some((c) => c.method === "Target.activateTarget"), false, "the user's active tab is not changed");
    assert.equal(client.owns("agent-tab"), true);
    assert.equal(client.owns("user-tab"), false);
    assert.equal(client.ownership().harnessWindowId(), undefined, "the user's window is not recorded as the harness window");
  });

  test("a later new tab is another background tab, and switching to it does not select it", async () => {
    const dir = userDataDir("Default");
    dirs.push(dir);
    const { stub, client } = await start(pinFor(dir, "Default"));
    stub.calls.length = 0;
    const t = await client.newTab();
    assert.equal(t.success, true);
    assert.deepEqual(stub.calls.filter((c) => c.method === "Target.createTarget").map((c) => c.params), [{ url: "about:blank", background: true }]);
    assert.equal(stub.calls.some((c) => c.method === "Target.activateTarget"), false);
  });

  test("with nothing pinned the same path is used", async () => {
    const { stub, r } = await start(null);
    assert.equal(r.success, true);
    assert.deepEqual(stub.calls.filter((c) => c.method === "Target.createTarget").map((c) => c.params), [{ url: "about:blank", background: true }]);
  });

  test("with another profile last used, the user's window is not used (createTarget would land in the wrong account)", async () => {
    const dir = userDataDir("Profile 2");
    dirs.push(dir);
    assert.equal(await clientFor(pinFor(dir, "Default")).placesTabsInUserWindow(), false);
  });

  test("PI_BROWSER_DEDICATED_WINDOW=1 keeps the old dedicated window", async () => {
    const dir = userDataDir("Default");
    dirs.push(dir);
    process.env["PI_BROWSER_DEDICATED_WINDOW"] = "1";
    try {
      assert.equal(await clientFor(pinFor(dir, "Default")).placesTabsInUserWindow(), false);
    } finally {
      Reflect.deleteProperty(process.env, "PI_BROWSER_DEDICATED_WINDOW");
    }
  });
});
