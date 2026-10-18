# Web chat Host probe

This diagnostic reuses the shipped six provider parsers. OpenCLI obtains the
browser account identity and credentials once; subsequent list/detail requests
use Node fetch directly. Credentials and conversation contents stay in memory.
Only stage results, HTTP statuses and counts are printed. Nothing is written to
the production conversation store or credential store.

Run with the installed OpenCLI package directory (not the executable). Browser
Bridge must be connected and the selected providers must already be signed in:

```powershell
node --max-http-header-size=65536 scripts/probe-web-chat-host.mjs C:\Users\27923\AppData\Roaming\npm\node_modules\@jackwener\opencli deepseek kimi chatgpt grok gemini
node --test scripts/probe-web-chat-host.test.mjs
```

Omitting provider names probes all six, including Claude. The explicit example
above excludes Claude at the user's request. The probe opens temporary background
tabs and closes them afterward. Host requests reject cross-origin destinations and
redirects, filter cookie domain/path/expiry, have a 15-second request timeout and a
12-request budget per mode, and stop listing after one page. Each successful list
is followed by reading its first conversation. Identity must match the browser
before any list/detail request. An empty list cannot verify message retrieval.

## Local results — 2026-10-16

Baseline local checkpoint: `b42bb73`. OpenCLI 1.8.8, Browser Bridge 1.0.24,
Node 25.6.0. These are bounded samples, not complete history synchronization tests.

| Provider | Host authentication tested | Identity | List sample | First conversation |
| --- | --- | --- | --- | --- |
| DeepSeek | Token only; cookies + token also passed | Match | 100 records | 2 turns |
| Kimi | Token only; cookies + token also passed | Match | 70 records | 2 turns |
| ChatGPT | Cookies → session access token | Match | 100 records | 6 turns |
| Grok | Cookies | Match | 60 records | 10 turns |
| Gemini | Cookies → fresh HTML bootstrap parameters | Match | 100 records | 2 turns |
| Claude | Not tested in Host | Browser identity unavailable; user requested skip | — | — |

All requests in the five successful probes returned HTTP 200. Gemini initially
failed with `UND_ERR_HEADERS_OVERFLOW`; restarting the probe with
`--max-http-header-size=65536` resolved that failure. Gemini's account identity and
RPC parameters were parsed from the Host-fetched HTML, not copied from browser
page globals. Navigation rejection during browser bootstrap required the same
new-tab retry pattern already used by the production OpenCLI adapter.

## Remaining production work

- Integrate a Host credential store and explicit connection/reconnection actions.
- Add transport selection to the existing runner/sync service and preserve account
  isolation, cancellation, rate-limit handling, pagination and attachment behavior.
- Arrange a scoped HTTP client with sufficient response-header capacity for Gemini.
- Validate credential lifetime/renewal and browser fallback behavior over time.
- Test Claude when requested; do not infer its support from other providers.

This experiment does not persist credentials, test token refresh, exercise all
pages/attachments, or switch the installed plugin away from OpenCLI. Captured
cookies are a point-in-time snapshot; response cookie rotation is not implemented
in this diagnostic. Keep production synchronization on the existing path until
those lifecycle behaviors are implemented and tested.
