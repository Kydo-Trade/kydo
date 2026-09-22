# Kydo: brand in the product

The mark is two greens on white: `#527b2f` for the solid shape, `#8da750` for
the rays. Everything below follows from those and from one constraint the logo
does not know about: **this is a trading interface, and green already means
profit.**

## The palette

| token | value | what it is |
|---|---|---|
| `--kydo-deep` | `#527b2f` | the mark's solid shape. Fills and rules: never a background for text |
| `--kydo-sage` | `#8da750` | the mark's rays. Also `--fig-main-600`, the accent's hover-down step |
| `--fig-main-500` / `--t-accent` | `#a9cd5e` | **primary action.** The sage, lifted |
| `--t-up` / `--fig-green-500` | `#00c46a` | profit, and the buy side |
| `--t-down` | `#ff5f2e` | loss, and the sell side |
| `--t-amber` | `#ffdd00` | warning |

### Why the accent is not the logo's green

Measured against the ink glyph that sits on a primary button:

| | ink on fill | on the page |
|---|---|---|
| `#527b2f` deep | **3.89** | 3.61 |
| `#8da750` sage | 7.15 | 6.64 |
| `#a9cd5e` lifted | **10.65** | 9.89 |
| `#b7ff00` old lime | 15.92 | 14.78 |

The deep green is below the 4.5 a button label needs. It cannot be the action
colour. The sage clears it but reads visibly flat next to the rest of the
interface. `#a9cd5e` is the same hue family lifted until it carries: it reads as
the logo's green and works as a button. The mark's own sage is `--fig-main-600`,
so the logo and the UI meet at one step of one ramp rather than being two
greens that merely coexist.

### Why profit moved

`--t-up` was `#00d05b`. Against a yellow-green accent that is two greens ~30°
apart. On a dark UI, a glance cannot separate "this is the brand" from "this is
up". Cooled to `#00c46a`, profit sits at 152° against the accent's 82°: they
read as different colours, not two shades of one.

The Figma green ramp moved with it. Three greens were on screen at once. Brand,
profit, and the buy button's mint `#6affab`. Profit and buy are the same idea,
so they are one ramp now, and the brand is the only other green in the product.

## The mark in code

`components/brand/Kydo.tsx`. `KydoMark` and `KydoWordmark`, drawn as vector
geometry on a 100×100 grid. **Not an `<img>`.** The wordmark it replaces pointed
at `/brand/prophood.svg`, an asset nobody ever exported, so it spent its whole
life rendering its own text fallback. Geometry in a component cannot be
forgotten at deploy time. The favicon is the same paths, inlined as a data URI
in `layout.tsx`, for the same reason.

> Rebuilt from the supplied raster. The `.svg` did not reach the session that
> did this work. If you have the original, replace the paths in `KydoMark`; the
> colours and the sizing contract are what the rest of the app depends on.

## Pool identity

`components/brand/PoolAvatar.tsx`. Every pool used to wear the same
`from-accent to-up` gradient circle with its first initial, which had two
problems: a grid of pools looked like a grid of one pool, and the brightest
thing on the invest page was a badge you cannot click. The primary action
colour spent on decoration.

Now: the mark's own wedges, rotated by an FNV-1a hash of the pool address, on a
tint stepped along the brand ramp. Five tints × four orientations, deterministic,
so a pool keeps its face across sessions and devices. Two pools look different;
the set looks like one family; none of it borrows the accent.

The Common Pool is the platform's own pool, so it wears the mark itself.

## Naming

User-facing strings, page metadata, the landing page and the READMEs say Kydo.
`@kydo/ui`, `@kydo/sdk`, the repo folder and the Anchor crate are unchanged. That
is 93 files and every import, and it belongs in its own mechanical commit rather
than mixed into a design change.
