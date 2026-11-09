import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchCommand, openProfileWindow } from "../../src/profile/launch";

describe("openProfileWindow's failure reporting", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-launch-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("L1", () => {
    const missing = (): string => join(root, "chrome (deleted)");

    test("L1: a missing executable fails the launch", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L1: the error names the path that could not be launched", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes(missing()));
    });

    test("L1: the error carries spawn's own cause", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes("ENOENT"));
    });
  });

  test(
    "L2: a non-executable file fails the launch",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
      const notExec = join(root, "not-executable");
      writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
      const r = await openProfileWindow({ exePath: notExec, profileDir: "Default" });
      assert.ok(!r.success);
    },
  );

  describe("L3", () => {
    let before_: string | undefined;

    before(() => {
      before_ = process.env["TMPDIR"];
      process.env["TMPDIR"] = root;
    });

    after(() => {
      if (before_ === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = before_;
    });

    test("L3: launch failed as set up", async () => {
      const r = await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L3: no handshake page is left on disk after a failed launch", async () => {
      await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      const leftovers = readdirSync(root).filter((n) => n.startsWith("pi-harness-"));
      assert.equal(leftovers.length, 0);
    });
  });

  describe("L4", () => {
    let r: Awaited<ReturnType<typeof openProfileWindow>>;

    before(async () => {
      const stub = join(root, "stub-browser");
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      r = await openProfileWindow({ exePath: stub, profileDir: "Default" });
    });

    test("L4: a startable binary yields a handle", () => {
      assert.ok(r.success);
    });

    test("L4: the sentinel page exists before the browser is polled", () => {
      assert.ok(r.success);
      const sentinel = fileURLToPath(r.data.sentinelUrl);
      assert.ok(existsSync(sentinel));
    });

    test("L4: cleanup removes the sentinel page", async () => {
      assert.ok(r.success);
      const sentinel = fileURLToPath(r.data.sentinelUrl);
      await r.data.cleanup();
      assert.ok(!existsSync(sentinel));
    });

    test("L4: kill is safe to call twice", () => {
      assert.ok(r.success);
      r.data.kill();
      r.data.kill();
    });
  });
});

describe("launchCommand", () => {
  const ARGS = ["--profile-directory=Profile 2", "--new-window", "file:///tmp/sentinel.html"];

  test("on macOS a bundled browser is handed the argv through `open -g -n`, so it does not take focus", () => {
    assert.deepEqual(
      launchCommand("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ARGS, "darwin"),
      { command: "open", args: ["-g", "-n", "-a", "/Applications/Google Chrome.app", "--args", ...ARGS] },
    );
  });

  test("on macOS an executable outside an app bundle is spawned directly", () => {
    assert.deepEqual(launchCommand("/opt/chromium/chrome", ARGS, "darwin"), { command: "/opt/chromium/chrome", args: ARGS });
  });

  test(
    "on macOS a bundle `open` cannot launch fails fast with the exit code instead of waiting for the sentinel",
    { skip: process.platform !== "darwin" },
    async () => {
      const r = await openProfileWindow({ exePath: "/nonexistent/Missing Browser.app/Contents/MacOS/Missing Browser", profileDir: "Default" });
      assert.equal(r.success, false);
      assert.match(r.error, /`open -g` exited with code [1-9]/);
    },
  );

  test("elsewhere the executable is spawned directly", () => {
    assert.deepEqual(launchCommand("/usr/bin/google-chrome", ARGS, "linux"), { command: "/usr/bin/google-chrome", args: ARGS });
  });
});
