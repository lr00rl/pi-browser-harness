// Page-side scroll for browser_scroll, used when wheel input cannot reach the page: a hidden tab (another tab is
// selected in its window, or the window is minimized) never answers Input.dispatchMouseEvent's mouseWheel.
// See fill.page.ts for the rules every page function follows.

export type ScrollRequest = { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number };

export type ScrollResult = {
  readonly scrolled: "element" | "page";
  readonly scrollX: number;
  readonly scrollY: number;
};

// Scrolls what a wheel at (x, y) would: the nearest scrollable ancestor of the element under the point, else the page.
export function scrollAtPoint(req: ScrollRequest): ScrollResult {
  let el: Element | null = document.elementFromPoint(req.x, req.y);
  while (el !== null && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el);
    const canY = req.dy !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const canX = req.dx !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (canY || canX) {
      el.scrollBy({ left: req.dx, top: req.dy, behavior: "instant" });
      return { scrolled: "element", scrollX: window.scrollX, scrollY: window.scrollY };
    }
    el = el.parentElement;
  }
  (document.scrollingElement ?? document.documentElement).scrollBy({ left: req.dx, top: req.dy, behavior: "instant" });
  return { scrolled: "page", scrollX: window.scrollX, scrollY: window.scrollY };
}
