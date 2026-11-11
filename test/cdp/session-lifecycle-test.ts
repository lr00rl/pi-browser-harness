import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCdpSession } from "../../src/cdp/session";
import { createOwnershipRegistry, type OwnershipRegistry } from "../../src/cdp/ownership";
import { createStubTransport, flush, type Canned } from "../domains/fake-client";
import { err, ok } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";

const TWO_PAGES: Canned = {
  "Target.setDiscoverTargets": ok({}),
  "Target.getTargets": ok({
    targetInfos: [
      { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
      { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
    ],
  }),
  "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" }), ok({ sessionId: "s3" })],
  "Browser.getWindowForTarget": ok({ windowId: 7 }),
  "Target.activateTarget": ok({}),
};

const attached = async (
  canned: Canned = TWO_PAGES,
  ownership: OwnershipRegistry | "none" = createOwnershipRegistry({ ownedTargetIds: ["t1"] }),
) => {
  const stub = createStubTransport(canned);
  const session = ownership === "none" ? createCdpSession(stub.transport) : createCdpSession(stub.transport, ownership);
  const first = await session.attachFirstPage();
  assert.equal(first.success, true);
  return { stub, session };
};

const consoleEvent = (sessionId: string, text: string) => ({
  method: "Runtime.consoleAPICalled",
  sessionId,
  params: { type: "log", args: [{ type: "string", value: text }] },
});

const detachesFor = (stub: { calls: ReadonlyArray<{ method: string; params: Record<string, unknown> }> }): unknown[] =>
  stub.calls.filter((c) => c.method === "Target.detachFromTarget").map((c) => c.params["sessionId"]);

describe("CdpSession harness-window adoption", () => {
  const WINDOW_MATES: Canned = {
    ...TWO_PAGES,
    "Target.getTargets": ok({
      targetInfos: [
        { targetId: "t1", type: "page", title: "Harness", url: "about:blank" },
        { targetId: "popup", type: "page", title: "Popup", url: "https://popup.test/", openerId: "t1" },
        { targetId: "grandchild", type: "page", title: "Child", url: "https://child.test/", openerId: "popup" },
        { targetId: "stranger", type: "page", title: "Agent tab", url: "https://agent.test/" },
        { targetId: "foreign-child", type: "page", title: "Agent child", url: "https://agent.test/2", openerId: "stranger" },
      ],
    }),
  };

  test("adopts window-mates opened by an owned tab, transitively, and leaves strangers alone", async () => {
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1"], harnessWindowTargetId: "t1" });
    await attached(WINDOW_MATES, ownership);
    assert.deepEqual([...ownership.list()].sort(), ["grandchild", "popup", "t1"]);
    assert.equal(ownership.has("stranger"), false, "a tab another agent or the user put in the window is not adopted");
    assert.equal(ownership.has("foreign-child"), false, "a stranger's own popups are not adopted either");
  });

  test("a tab already owned stays owned across a reattach even when Chrome reports no opener for it", async () => {
    // A harness tab that navigated to a COOP page (or was opened noopener) loses its openerId; ownership was recorded
    // when the harness opened it, so it is neither dropped nor left behind at shutdown.
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1", "stranger"] });
    const { session } = await attached(WINDOW_MATES, ownership);
    await session.attachFirstPage();
    assert.equal(ownership.has("stranger"), true);
  });

  test("owned tabs in the user's window (a tab group) never make that window the harness window", async () => {
    // "grouped" is an owned agent tab in the user's window 1; the user opens a link from it ("user-popup"). With no
    // recorded harness window, nothing is adopted: closing owned tabs at shutdown must not close the user's tab.
    const canned: Canned = {
      ...TWO_PAGES,
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "grouped", type: "page", title: "Agent", url: "https://agent.test/" },
          { targetId: "user-tab", type: "page", title: "Mine", url: "https://mine.test/" },
          { targetId: "user-popup", type: "page", title: "Link", url: "https://link.test/", openerId: "grouped" },
        ],
      }),
      "Browser.getWindowForTarget": ok({ windowId: 1 }),
    };
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["grouped"] });
    await attached(canned, ownership);
    assert.deepEqual(ownership.list(), ["grouped"]);
    assert.equal(ownership.harnessWindowId(), undefined, "the user's window is not recorded as the harness window");
    assert.equal(ownership.harnessWindow(), undefined);
  });

  test("a recorded harness window that no longer exists is forgotten", async () => {
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1"], harnessWindowId: 99 });
    await attached(TWO_PAGES, ownership);
    assert.equal(ownership.harnessWindowId(), undefined);
  });

  test("with nothing owned alive, a fresh harness window is created in the background", async () => {
    const stub = createStubTransport({ ...TWO_PAGES, "Target.createTarget": ok({ targetId: "fresh" }) });
    const session = createCdpSession(stub.transport, createOwnershipRegistry({ ownedTargetIds: ["gone"] }));
    const first = await session.attachFirstPage();
    assert.equal(first.success, true);
    assert.deepEqual(
      stub.calls.filter((c) => c.method === "Target.createTarget").map((c) => c.params),
      [{ url: "about:blank", newWindow: true, background: true }],
    );
  });
});

describe("CdpSession re-attach", () => {
  test("borrowed tabs are not adopted when reconnecting the harness window", async () => {
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1"] });
    ownership.borrow("t2");
    const { session } = await attached(TWO_PAGES, ownership);

    assert.equal(ownership.has("t2"), false);
    await session.attachFirstPage();
    assert.equal(ownership.has("t2"), false);
  });

  test("re-attaching the same target detaches the old session only after the new one is live", async () => {
    const { stub, session } = await attached(TWO_PAGES, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    const again = await session.attachFirstPage();
    assert.equal(again.success, true);
    assert.equal(session.current()?.sessionId, "s2");
    assert.deepEqual(detachesFor(stub), ["s1"]);
    const order = stub.calls.map((c) => c.method);
    assert.ok(order.lastIndexOf("Target.attachToTarget") < order.indexOf("Target.detachFromTarget"));
    assert.ok(order.lastIndexOf("Log.enable") < order.indexOf("Target.detachFromTarget"));
  });

  test("events for the replaced session id are dropped; the new id routes to the same tab", async () => {
    const { stub, session } = await attached(TWO_PAGES, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    await session.attachFirstPage();
    stub.emit(consoleEvent("s1", "stale"));
    stub.emit(consoleEvent("s2", "fresh"));
    await flush();
    const drained = session.drainConsoleBuffer({});
    assert.deepEqual(drained.records.map((r) => r.text), ["fresh"]);
  });

  test("the survivor keeps its buffers, refs and dialog across a re-attach", async () => {
    const { stub, session } = await attached(TWO_PAGES, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    stub.emit(consoleEvent("s1", "before"));
    stub.emit({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type: "alert", message: "hi" } });
    await flush();
    session.setRefMap(new Map([["e1", 11]]), new Map([["e1", { role: "button", name: "e1", value: "", state: "" }]]));
    await session.attachFirstPage();
    assert.equal(session.resolveRef("e1"), 11);
    assert.equal(session.takeDialog()?.message, "hi");
    assert.deepEqual(session.drainConsoleBuffer({}).records.map((r) => r.text), ["before"]);
  });
});

describe("CdpSession target and session teardown", () => {
  test("destroying the current target clears current() even without an ownership registry", async () => {
    const { stub, session } = await attached(
      { ...TWO_PAGES, "Target.createTarget": ok({ targetId: "t1" }) },
      "none",
    );
    assert.equal(session.current()?.targetId, "t1");
    stub.emit({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
    await flush();
    assert.equal(session.current(), null);
    assert.equal(session.sessionFor("t1"), undefined);
  });

  test("destroying a background target leaves the current one alone", async () => {
    const { stub, session } = await attached();
    await session.switchTo("t2");
    stub.emit({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
    await flush();
    assert.equal(session.current()?.targetId, "t2");
    assert.equal(session.sessionFor("t1"), undefined);
  });

  test("Inspector.detached on the current session clears current()", async () => {
    const { stub, session } = await attached();
    stub.emit({ method: "Inspector.detached", sessionId: "s1", params: { reason: "target_closed" } });
    await flush();
    assert.equal(session.current(), null);
  });

  test("Target.detachedFromTarget drops the tab bound to that session", async () => {
    const { stub, session } = await attached();
    await session.switchTo("t2");
    stub.emit({ method: "Target.detachedFromTarget", params: { sessionId: "s1", targetId: "t1" } });
    await flush();
    assert.equal(session.sessionFor("t1"), undefined);
    assert.equal(session.current()?.targetId, "t2");
  });

  test("a detach notice for an already-replaced session id does not drop the tab", async () => {
    const { stub, session } = await attached(TWO_PAGES, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    await session.attachFirstPage();
    stub.emit({ method: "Target.detachedFromTarget", params: { sessionId: "s1", targetId: "t1" } });
    await flush();
    assert.equal(session.current()?.sessionId, "s2");
  });

  test("switchTo after the tab's session was detached attaches afresh", async () => {
    const { stub, session } = await attached();
    stub.emit({ method: "Inspector.detached", sessionId: "s1", params: {} });
    await flush();
    const switched = await session.switchTo("t1");
    assert.equal(switched.success, true);
    assert.equal(session.current()?.sessionId, "s2");
  });

  test("detachAll detaches every tracked session and forgets them", async () => {
    const { stub, session } = await attached();
    await session.switchTo("t2");
    await session.detachAll();
    assert.deepEqual(detachesFor(stub).sort(), ["s1", "s2"]);
    assert.equal(session.current(), null);
    assert.equal(session.sessionFor("t1"), undefined);
    assert.equal(session.sessionFor("t2"), undefined);
  });

  test("detach(sessionId) sends the detach and forgets a tracked session", async () => {
    const { stub, session } = await attached();
    await session.switchTo("t2");
    const r = await session.detach("s1");
    assert.equal(r.success, true);
    assert.deepEqual(detachesFor(stub), ["s1"]);
    assert.equal(session.sessionFor("t1"), undefined);
    assert.equal(session.current()?.sessionId, "s2");
  });
});

describe("CdpSession enable failures", () => {
  test("a failing domain enable fails attachFirstPage and releases the half-set-up session", async () => {
    const stub = createStubTransport({
      ...TWO_PAGES,
      "DOM.enable": err(cdpError("remote_error", "DOM agent unavailable")),
    });
    const session = createCdpSession(stub.transport, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    const first = await session.attachFirstPage();
    assert.equal(first.success, false);
    assert.equal(first.error.message, "DOM agent unavailable");
    assert.equal(session.current(), null);
    assert.deepEqual(detachesFor(stub), ["s1"]);
  });

  test("a failing domain enable fails switchTo and leaves the previous tab current", async () => {
    const stub = createStubTransport({
      ...TWO_PAGES,
      "Network.enable": [ok({}), err(cdpError("remote_error", "nope"))],
    });
    const session = createCdpSession(stub.transport, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    await session.attachFirstPage();
    const switched = await session.switchTo("t2");
    assert.equal(switched.success, false);
    assert.equal(session.current()?.targetId, "t1");
    assert.equal(session.sessionFor("t2"), undefined);
  });

  test("a failing Target.setDiscoverTargets is reported", async () => {
    const stub = createStubTransport({
      ...TWO_PAGES,
      "Target.setDiscoverTargets": err(cdpError("transport_closed", "socket closed")),
    });
    const session = createCdpSession(stub.transport, createOwnershipRegistry({ ownedTargetIds: ["t1"] }));
    const first = await session.attachFirstPage();
    assert.equal(first.success, false);
    assert.equal(first.error.kind, "transport_closed");
  });
});

describe("CdpSession event consumer resilience", () => {
  test("a throwing handler is logged and the consumer keeps processing later events", async () => {
    const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1"] });
    const exploding: OwnershipRegistry = {
      ...ownership,
      has: (id) => {
        if (id === "boom") throw new Error("handler exploded");
        return ownership.has(id);
      },
    };
    const { stub, session } = await attached(TWO_PAGES, exploding);
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      stub.emit({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: "t9", type: "page", title: "", url: "", openerId: "boom" } },
      });
      stub.emit(consoleEvent("s1", "still alive"));
      await flush();
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.deepEqual(session.drainConsoleBuffer({}).records.map((r) => r.text), ["still alive"]);
  });
});

describe("CdpSession ref maps", () => {
  test("setRefMap copies the caller's maps", async () => {
    const { session } = await attached();
    const refMap = new Map([["e1", 1]]);
    const sig = { role: "link", name: "Home", value: "", state: "" };
    const refSig = new Map([["e1", sig]]);
    session.setRefMap(refMap, refSig);
    refMap.set("e2", 2);
    refSig.delete("e1");
    assert.equal(session.resolveRef("e2"), undefined);
    assert.deepEqual(session.refSignatures().get("e1"), sig);
    assert.equal(session.refMappings().size, 1);
  });
});
