import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall, evalJs, fromClient } from "./cdp-call";
import { pageCallExpression } from "./page/inject";
import { scrollAtPoint } from "./page/scroll.page";

// A delivered wheel answers in milliseconds; one that hangs is going to a tab that is not being rendered.
const WHEEL_TIMEOUT_MS = 2_000;

const isScrollResult = (v: unknown): v is { readonly scrolled: string; readonly scrollX: number; readonly scrollY: number } =>
  typeof v === "object" && v !== null && "scrolled" in v && "scrollX" in v && "scrollY" in v;

const ScrollArgs = Type.Object({
  x: Type.Optional(Type.Number({ description: "X coordinate where to scroll. Default: viewport center" })),
  y: Type.Optional(Type.Number({ description: "Y coordinate where to scroll. Default: viewport center" })),
  deltaX: Type.Optional(Type.Number({ default: 0, description: "Horizontal scroll delta (CSS pixels). Positive = right." })),
  deltaY: Type.Optional(Type.Number({
    default: 300,
    description: "Vertical scroll delta (CSS pixels). Positive = down, negative = up (W3C wheel-event convention). Default: 300 (scroll down).",
  })),
});

export const scrollTool = defineBrowserTool({
  name: "browser_scroll",
  label: "Browser Scroll",
  description:
    "Scroll the page at given coordinates. deltaY follows W3C wheel-event convention: positive = scroll down, negative = scroll up. Default scrolls down (deltaY = 300).",
  promptSnippet: "Scroll the page (deltaY positive=down, negative=up)",
  promptGuidelines: [
    "Pass x/y to target a specific scrollable region (e.g., a div with overflow); otherwise scrolls the page at viewport center.",
  ],
  parameters: ScrollArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const info = fromClient(await client.pageInfo(), "pageInfo");
    if (!info.success) return info;
    if (info.data.kind === "dialog") {
      return err({
        kind: "invalid_state",
        message: `Dialog open: ${info.data.dialog.type} — ${info.data.dialog.message}`,
      });
    }
    const cx = args.x ?? Math.round(info.data.width / 2);
    const cy = args.y ?? Math.round(info.data.height / 2);
    const dx = args.deltaX ?? 0;
    const dy = args.deltaY ?? 300;
    // Wheel input only reaches a page that is being rendered. The tab is never brought to the front for it (that
    // would take macOS focus from the user); a hidden tab is scrolled from inside the page instead.
    const visibility = await evalJs(client, "document.visibilityState");
    const hidden = visibility.success && visibility.data === "hidden";
    if (!hidden) {
      // Establish compositor mouse position first, or CDP sometimes drops the wheel event with a timeout.
      const moved = await cdpCall(client, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: cx, y: cy, button: "none", buttons: 0,
      });
      if (!moved.success) return moved;
      const wheel = await cdpCall(client, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: cx, y: cy, deltaX: dx, deltaY: dy,
        button: "none", buttons: 0, pointerType: "mouse",
      }, { timeoutMs: WHEEL_TIMEOUT_MS });
      if (wheel.success) {
        return ok({
          text: `Scrolled at (${cx}, ${cy}) by (${dx}, ${dy})`,
          details: { x: cx, y: cy, deltaX: dx, deltaY: dy },
        });
      }
      if (wheel.error.kind !== "timeout") return wheel;
    }
    const scripted = await evalJs(client, pageCallExpression(scrollAtPoint, { x: cx, y: cy, dx, dy }));
    if (!scripted.success) return scripted;
    if (!isScrollResult(scripted.data)) {
      return err({ kind: "internal", message: "page scroll returned an unexpected shape" });
    }
    // A timed-out wheel is not cancelled: if Chrome delivers it late, the page moves once more.
    const why = hidden ? "the tab is not visible" : "the wheel event was not delivered in time and may still land";
    return ok({
      text: `Scrolled at (${cx}, ${cy}) by (${dx}, ${dy}) from inside the page (${why}); page is now at (${scripted.data.scrollX}, ${scripted.data.scrollY})`,
      details: { x: cx, y: cy, deltaX: dx, deltaY: dy, via: "script", scrolled: scripted.data.scrolled },
    });
  },
});
