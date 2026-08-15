# Voice mode — server configuration

`voice-routes.js` is a vendor-agnostic proxy. It names no provider in code; the
provider is chosen entirely by env. Set these on the droplet, then restart the
API. With them unset, `/api/voice/*` returns `503 voice_not_configured` and the
client disables the mic button — voice is off by default, which is what keeps the
"zero telemetry" claim on lingcode.dev honest.

## Speech-to-text

| Var | Meaning |
|---|---|
| `LINGCODE_VOICE_STT_URL` | Full transcription endpoint URL. Required. |
| `LINGCODE_VOICE_STT_HOSTS` | Comma-separated host allow-list for `safeFetch`. **Required** — egress is denied without it, by design. |
| `LINGCODE_VOICE_STT_KEY` | API key. Stays server-side; never sent to a client. |
| `LINGCODE_VOICE_STT_AUTH_SCHEME` | `Bearer` (default) or `Basic`. Use `Basic` when the key is already a base64 blob — it is **not** re-encoded. |
| `LINGCODE_VOICE_STT_MODEL` | Optional model name, passed through. |
| `LINGCODE_VOICE_STT_JSON_AUDIO_FIELD` | Set to a field name (e.g. `audio`) if the vendor wants base64-in-JSON instead of `multipart/form-data`. Leave unset for multipart. |

## Text-to-speech

| Var | Meaning |
|---|---|
| `LINGCODE_VOICE_TTS_URL` | Full synthesis endpoint URL. May contain `{voice}`, which is substituted. Required. |
| `LINGCODE_VOICE_TTS_HOSTS` | Comma-separated host allow-list. Required. |
| `LINGCODE_VOICE_TTS_KEY` | API key. |
| `LINGCODE_VOICE_TTS_AUTH_SCHEME` | `Bearer` (default) or `Basic`. |
| `LINGCODE_VOICE_TTS_VOICE` | Voice id. Pinned server-side so clients never choose one. |
| `LINGCODE_VOICE_TTS_MODEL` | Optional model id, sent as both `modelId` and `model_id`. |

The response may be **raw audio bytes or JSON carrying base64** — `extractAudio()`
handles both and sniffs the container from magic bytes, so a vendor that returns
`{"audioContent": "<base64>"}` works without a code change. That path is unit
tested in `test/voice-routes.test.js`.

## Prompt shaping

`/api/voice/shape` needs no new config — it reuses the existing LingModel wiring
(`lingmodelAnthropicMessagesUrl` + `lingmodelUpstreamApiKey`), the same helpers
`slack-inference.js` reuses. If LingModel isn't configured, shaping degrades to
passing the raw transcript through rather than failing the turn.

## Before you set these

1. **Confirm the request/response shapes against the vendor's current docs.** The
   proxy is written to tolerate the two common shapes, but the exact field names
   (`text` vs `transcript`, `audioContent` vs `audio`) were inferred, not read off
   a live response. Send one real request with `curl` first.
2. **Set the `_HOSTS` allow-list to the narrowest host that works.** `safeFetch`
   refuses IP literals and anything resolving to a private/link-local/metadata
   address, revalidates every redirect hop, and denies everything when the list is
   empty. That is the SSRF boundary — don't widen it to a wildcard.
3. **Keep the vendor out of user-visible strings.** `opaqueUpstreamError()` maps
   upstream failures to `voice_*` codes, and there are assertions in both
   `test/voice-routes.test.js` and `src-tauri/src/voice.rs` that fail if a vendor
   name can reach a client. Same rule as LingModel.

## Quick check

```bash
# Should be 503 before configuring, 200 after (with a signed-in token).
curl -s -H "Authorization: Bearer $LINGCODE_TOKEN" https://lingcode.dev/api/voice/status | jq

# Synthesis round-trip: expect audio/* and a non-trivial byte count.
curl -s -D- -o /tmp/say.mp3 -X POST https://lingcode.dev/api/voice/speak \
  -H "Authorization: Bearer $LINGCODE_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Voice mode is working."}' | grep -i content-type
ls -l /tmp/say.mp3 && afplay /tmp/say.mp3   # or any player
```
