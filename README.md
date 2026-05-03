# pi-higgsfield-mcp

Connect [Higgsfield AI](https://higgsfield.ai) to [pi](https://github.com/mariozechner/pi-coding-agent) via MCP (Model Context Protocol).

Bring AI image/video generation, media uploads, marketing studio, Soul-ID character training, and workspace management directly into your pi coding sessions.

## Quick Start

```bash
pi install github:Changhochien/pi-higgsfield-mcp
```

Then in pi:

```
/higgsfield-auth
```

Authorize via the device flow link, and you're ready:

```
generate a cyberpunk cat at 4K with nano banana pro
check my higgsfield balance
upload an image and generate a marketing studio video
```

## Tools Provided

| Category | Tools |
|----------|-------|
| **Generation** | `mcp_generate_image`, `mcp_generate_video`, `mcp_models_explore` |
| **Marketing Studio** | `mcp_show_marketing_studio` |
| **Jobs** | `mcp_job_status`, `mcp_job_display`, `mcp_show_generations` |
| **Media** | `mcp_media_upload`, `mcp_media_confirm`, `mcp_show_medias` |
| **Soul-ID** | `mcp_soul_train`, `mcp_soul_train_wizard`, `mcp_soul_list`, `mcp_soul_status` |
| **Account** | `mcp_balance`, `mcp_transactions`, `mcp_list_workspaces`, `mcp_select_workspace` |

## Commands

| Command | Description |
|---------|-------------|
| `/higgsfield-auth` | Initiate OAuth device flow |
| `/higgsfield-status` | Show connection status and loaded tools |
| `/higgsfield-disconnect` | Clear tokens and disconnect |

## Authentication

Uses OAuth 2.0 device flow — no API key needed:
1. Run `/higgsfield-auth` in pi
2. Open the provided link in your browser
3. Authorize with your Higgsfield account
4. Token is cached in `.pi/state/higgsfield-tokens.json` and auto-refreshed on session start

## Requirements

- [pi](https://github.com/mariozechner/pi-coding-agent) (latest)
- A [Higgsfield AI](https://higgsfield.ai) account

## License

MIT
