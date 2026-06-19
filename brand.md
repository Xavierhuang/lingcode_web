# LingCode brand kit (web)

Source-of-truth for tokens and rules used by `style.css`, `index.html`, `try.html`, and the rest of `website/`. Read this before making visual changes; update it when the brand rules change.

## Direction

Technical / utilitarian. Adjacent to JetBrains, Xcode, and early GitHub; opposite Lovable's glossy AI aesthetic. Visual sobriety reinforces the work-protection trust pillar.

## Palette

Defined as CSS custom properties on `:root` in `style.css`.

| Token              | Value                    | Usage                                   |
| ------------------ | ------------------------ | --------------------------------------- |
| `--bg`             | `#000000`                | Page background                         |
| `--bg-card`        | `#0c0c0c`                | Card / panel surfaces                   |
| `--bg-card-hover`  | `#141414`                | Card hover                              |
| `--bg-nav`         | `rgba(0,0,0,0.85)`       | Sticky nav (over content)               |
| `--text`           | `#ededed`                | Primary text                            |
| `--text-muted`     | `#888`                   | Secondary text                          |
| `--text-dim`       | `#555`                   | Tertiary, fine print                    |
| `--signal`         | `#00d084`                | Single accent. Eyebrows, links, dots, focus rings |
| `--signal-glow`    | `rgba(0,208,132,0.22)`   | Soft accent halo (use sparingly)        |
| `--green`          | `#00d084`                | Alias of `--signal`; semantic success   |
| `--red`            | `#f87171`                | Destructive only                        |
| `--border`         | `rgba(255,255,255,0.07)` | Default 1px borders                     |
| `--border-strong`  | `rgba(255,255,255,0.12)` | Stronger 1px borders (cards, buttons)   |

**Rule:** no periwinkle, no second accent. `#00d084` is the only signal color. Don't add new hues without changing this doc.

## Typography

```
--font:      "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
--font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace
```

| Where                          | Family    | Weight |
| ------------------------------ | --------- | ------ |
| Body, `h1`, `h2`, `h3`         | Geist     | 400 / 600 / 700 |
| `.nav-logo` (wordmark)         | Geist Mono| 600    |
| `.section-eyebrow`             | Geist Mono| 500    |
| `.hero-badge`                  | Geist Mono| 500    |
| Code, inline `<code>`          | Geist Mono| 400    |

**Rule:** no serif. No gradient text-fill on headings. No animated text shimmer.

Both Geist and Geist Mono must be loaded on every page that uses mono UI elements. Currently loaded on `index.html` and `try.html`; add to other pages as the mono surface expands.

## Geometry

```
--radius-sm: 8px   /* buttons, inputs, badges, icons, code chips */
--radius-lg: 14px  /* cards, panels, video frames */
--radius:    14px  /* legacy alias of --radius-lg */
```

Allowed: `8px`, `14px`, `100px` (pills only), `50%` (dots/avatars), `1px` (decorative lines).
Forbidden in marketing CSS: `4px`, `6px`, `10px`, `12px`, `16px`. (Present in `try.html` and a few auth pages — those are out of scope until the next pass.)

## Motion

Keep one signature, kill the rest.

**Allowed:**
- `.announcement-dot`, `.hero-badge-dot`, `.try-hero-eyebrow .dot` — pulse (status indicator)
- `.fade-section` — single intersection-observer fade-in (no stagger)
- `.stat-num[data-count]` — count-up on scroll (Stripe / GitHub / JetBrains all do this)
- Native `<video>` hover-to-preview on demo cards
- Nav scroll-shrink (`.site-header--scrolled`)

**Forbidden** (all removed in this brand pass):
- Animated mesh gradients (hero or card-hover)
- `text-shimmer` on `h1` / headings / eyebrows
- 3D card tilt on mousemove
- Parallax (hero or ambient orbs)
- Material-style button ripple
- Any decorative blur orbs (`.ambient-orb`)

## Logo & favicon

**Current state (interim):**
- `nav-logo` is the literal text "LingCode" in Geist Mono 600 — clean, defensible, JetBrains-adjacent.
- `favicon.svg` is a simplified `{}` glyph in `--signal` on pure black. Readable at 16×16. **Not** a real designed mark.
- `favicon.ico` and `apple-touch-icon.png` still hold the older multi-element design — they need to be regenerated from the new `.svg` (or replaced with designer deliverables).
- `og-image.png` is referenced in meta but does not exist on disk.

**Designer brief (Track A, external):**
1. Square logomark SVG that reads at 16×16. Three candidate metaphors: bracketed `L` (`[L]` / `{L}`), terminal-cursor block fused with `L`, or stacked IDE-window outlines (3 nested rectangles).
2. Custom wordmark with mark — horizontal lockup. Not "LingCode" typed in Geist Mono.
3. Favicon set: `.svg`, `.ico` (16/32), `apple-touch-icon.png` (180).
4. Custom 14-icon line set replacing Feather icons in `index.html:322–448`.
5. `og-image.png` (1200×630), monochrome black + `#00d084`.

Brief constraints to give designer: technical/utilitarian, JetBrains/Xcode-adjacent, monochrome black + `#00d084` signal only, no gradients, no glow effects, no rounded-friendly shapes.

## Out of scope of this brand pass

- `/try` playground UI (uses different radii, has its own inline styles — separate plan).
- Auth pages (`signin.html`, `signup.html`, `account.html`, etc.) — picked up the palette via cascade but not the radius/motion rules.
- macOS app in-product brand. Web ships first; desktop later.
