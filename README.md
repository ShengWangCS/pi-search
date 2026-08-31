# pi-search

Minimal Exa search + URL fetch for the [Pi coding agent](https://pi.dev). Stripped-down fork of [pi-web-access](https://github.com/nicobailon/pi-web-access) (~5,000 lines removed).

- `web_search` — Exa direct API or MCP
- `fetch_content` — HTTP + Readability → markdown (3MB parse cap, same-session dedupe)
- `get_search_content` — retrieve stored results by responseId

## Install

```bash
pi install git:github.com/<user>/pi-search
```

## Config

Optional `EXA_API_KEY` env var, or `~/.pi/web-search.json`:

```json
{ "exaApiKey": "exa-..." }
```

Without a key, uses Exa MCP (zero-config).
