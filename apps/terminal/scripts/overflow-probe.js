/**
 * Paste into the browser console on any page of the terminal.
 *
 * Lists every element painting wider than its own box. It ignores the ones that
 * are meant to. Anything with `text-overflow: ellipsis`, and anything with an
 * `overflow-x` of auto/scroll/hidden, which is a deliberate clip or a scroller.
 * What is left is text spilling out of a box that has nowhere to put it: the
 * shape behind the clipped Account table and the two half-eaten buttons in the
 * 272 px ticket column.
 *
 * Run it at a few window widths. The narrow columns are fixed at 272 px, so
 * they do not change, but the header, the bottom tabs and every page outside
 * the terminal do.
 */
(() => {
  const rows = [];
  document.querySelectorAll("body *").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) return;
    if (cs.textOverflow === "ellipsis") return;
    if (["auto", "scroll", "hidden"].includes(cs.overflowX)) return;
    rows.push({
      over,
      box: el.clientWidth,
      content: el.scrollWidth,
      tag: el.tagName.toLowerCase(),
      cls: (el.className.toString() || "").slice(0, 60),
      text: (el.textContent || "").trim().slice(0, 40),
      el,
    });
  });
  rows.sort((a, b) => b.over - a.over);
  if (!rows.length) console.log("%cno overflow", "color:#b6f36b");
  else console.table(rows.map(({ el, ...r }) => r));
  rows.forEach((r) => (r.el.style.outline = "1px solid magenta"));
  return rows;
})();
