# pi-exa

Minimal Exa search + URL fetch extension for the [Pi coding agent](https://pi.dev).

Stripped-down fork of [pi-web-access](https://github.com/nicobailon/pi-web-access) with only:
- `web_search` — Exa only (direct API or MCP)
- `fetch_content` — HTTP + Readability → markdown
- `get_search_content` — stored content retrieval

No YouTube, GitHub, video, PDF, Perplexity, Gemini, curator UI, activity monitor, or any of the other ~5000 lines of stuff.

## Install

```bash
pi install git:github.com/<user>/pi-exa
```

## Config

Optional: set `EXA_API_KEY` env var or add to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-..."
}
```

Without a key, uses Exa MCP (zero-config).
