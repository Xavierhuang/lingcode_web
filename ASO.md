# App Store listing — LingCode for iPhone & iPad

Recommended copy for App Store Connect (app id `6757243830`, category
Developer Tools). **These have to be applied by hand in App Store Connect** —
nothing in this repo pushes them.

## Why change anything

The App Store indexes three fields for search: the **app name**, the
**subtitle**, and the **100-character keyword field**. Nothing else in the
listing carries ranking weight — not the description, not the promotional
text. Today two of those three are spent on nothing:

| Field | Current | Problem |
|---|---|---|
| Name | `LingCode` (8 / 30) | 22 indexed characters unused. The brand alone matches only people who already know it. |
| Subtitle | `Your Best AI-assistant Tool` (27 / 30) | The second-most-weighted field, and it contains no term anyone searches. "Best" and "Tool" are noise; "AI-assistant" is far too generic to rank. |
| Promotional text | `Your Best AI-assistant Tool` | Duplicates the subtitle. Carries no ranking weight at all, so this is purely a wasted conversion slot. |
| Keyword field | unknown — check ASC | Must be audited; see the rules below. |

## Recommended

**App name** (27/30)

```
LingCode: AI Code Assistant
```

Keeps the brand first, then spends the remaining characters on terms the
brand alone cannot match.

**Subtitle** (26/30)

```
Xcode & Swift AI Assistant
```

`Xcode` and `Swift` are the two highest-intent terms this app can honestly
claim, and neither appears in the name, so nothing is wasted on repetition.

**Keyword field** (98/100)

```
swift,xcode,ios,coding,programmer,developer,claude,gpt,gemini,github,ide,editor,repo,debug,snippet
```

Rules this obeys, all of which are easy to get wrong:

- **Comma-separated, no spaces.** A space after a comma costs an indexed
  character for nothing.
- **No repetition of the name or subtitle.** Apple already indexes those, so
  `ai` and `assistant` are deliberately absent — they would be dead weight.
- **Singular only.** Apple stems automatically; `snippet` also matches
  `snippets`.
- **No competitor names and no "app"/"free".** Competitor terms risk rejection;
  `app` is ignored.

**Promotional text** — not indexed, so use it for conversion rather than
keywords, and stop duplicating the subtitle. It can be changed without a new
build, so it is the right place for whatever is newest:

```
Chat with Claude, GPT, Gemini or DeepSeek over your real project. Import from
GitHub or iCloud Drive and keep your own API keys.
```

## Verify after publishing

- Search the App Store for `xcode ai`, `swift assistant` and `ai code editor`
  and record where LingCode lands, so the next iteration has a baseline.
- Type each candidate term into App Store search and read the autocomplete —
  it reflects real query volume and is the cheapest research available.
- Re-check about a week after the change; App Store ranking moves slower than
  web search.

## Related

Web-side SEO for lingcode.dev lives in [`scripts/seo/`](scripts/seo/README.md).
The two are separate ranking systems and share nothing but the product.
