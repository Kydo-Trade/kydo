# Asset marks

Drop token icons here as `<symbol>.svg`, lower-case, matching the market's base
symbol: `sol.svg`, `btc.svg`, `eth.svg`, `bnb.svg`, `doge.svg`.

`components/TokenIcon.tsx` looks them up by that name and falls back to the
lettered gradient circle when a file is missing or fails to load, so listing a
market without its icon degrades quietly instead of showing a broken image.

Local files rather than a CDN on purpose: a logo that 404s or gets rate-limited
is a broken row in a trading screen, and the terminal should not need a
third-party host to render its own market list.

## Getting a set

These are third-party brand marks, so none are committed here. Pick a set
whose licence you are happy shipping. The usual choice is
[cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) (CC0),
which covers every market currently listed:

```bash
cd apps/terminal/public/brand/tokens
for s in sol btc eth bnb doge; do
  curl -fsSL "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color/$s.svg" -o "$s.svg"
done
```

Add a line per market as the registry grows. If a symbol has no icon in the set,
leave it out. The fallback handles it.

Square SVGs work best: the component rounds them with `rounded-full`, so a mark
that already sits on its own circular field looks right without a border.
