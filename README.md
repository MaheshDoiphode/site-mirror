# site-mirror

A CLI tool to mirror websites for offline browsing using Playwright.

## Installation

```bash
# Install globally
npm install -g site-mirror

# Or use directly via npx
npx site-mirror --help
```

## Quick Start

```bash
# Download a single page with all its assets (no config needed!)
site-mirror run --start https://www.apple.com/iphone/ --singlePage

# Crawl an entire site
site-mirror run --start https://example.com/

# Or use interactive config-based workflow:
site-mirror init          # Interactive prompts to create site-mirror.config.json
site-mirror run           # Runs the mirror using config
site-mirror serve         # Serve locally on port 8080
```

## Commands

| Command                  | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `site-mirror init`       | Interactive setup - creates `site-mirror.config.json` |
| `site-mirror run`        | Run the mirror (reads config + CLI overrides)         |
| `site-mirror serve`      | Serve the `./offline` folder locally                  |
| `site-mirror serve 3000` | Serve on a custom port                                |

## CLI Options (for `run`)

| Option              | Description                              | Default         |
| ------------------- | ---------------------------------------- | --------------- |
| `--start <url>`     | Start URL (required if not in config)    | -               |
| `--out <dir>`       | Output directory                         | `./offline`     |
| `--maxPages <n>`    | Max pages to crawl (0 = unlimited)       | `0`             |
| `--maxDepth <n>`    | Max link depth (0 = unlimited)           | `0`             |
| `--sameOriginOnly`  | Only crawl same-origin pages             | `true`          |
| `--seedSitemaps`    | Seed URLs from sitemap.xml/robots.txt    | `false`         |
| `--singlePage`      | Download only this page + all its assets | `false`         |

## Config File (`site-mirror.config.json`)

Created via `site-mirror init` (interactive) or manually:

```json
{
  "start": "https://example.com/",
  "out": "./offline",
  "singlePage": false,
  "maxPages": 200,
  "maxDepth": 6,
  "sameOriginOnly": true,
  "seedSitemaps": false
}
```

CLI options override config file settings.

## Output Structure

```
./offline/
├── index.html              # Homepage
├── about/
│   └── index.html          # /about/ page
├── _next/                   # Same-origin assets
│   └── static/
├── _external/               # Cross-origin assets
│   └── cdn.example.com/
│       └── script.js
```

## How It Works

1. Launches headless Chromium via Playwright
2. Navigates to each page, waits for network idle
3. Captures all static assets (CSS, JS, images, fonts, videos)
4. Rewrites absolute same-origin URLs to relative paths
5. Injects a script to handle SPA-style navigation offline
6. Discovers new pages via `<a href>` links
7. Saves everything to the output directory

## Notes

- XHR/fetch API responses are not saved (only rendered HTML + static assets)
- Some interactive features requiring live APIs won't work offline
- Be mindful of target site's Terms of Service and robots.txt

## License

MIT
