# site-mirror

A CLI tool to mirror websites into **clean, zero-server HTML/CSS/JS**, **React (Vite + React Router)**, or **Next.js (App Router)** projects using Playwright.

## Installation

```bash
# Install globally
npm install -g site-mirror

# Or use directly via npx
npx site-mirror --help
```

## Export Formats (`--format`)

### 1. `--format html` (Default — Zero-Server Ready)
Outputs clean, indented HTML, consolidated & formatted CSS (`css/styles.css`), lightweight interactive JS (`js/main.js`), and neatly categorized assets (`assets/images`, `assets/fonts`, `assets/svg`).
- **Works via double-click (`file://`)** with relative paths—no `python -m http.server` or `http-server` required!
- Strips minified framework runtime chunks (`_next/static/chunks/*.js`) so pages never crash or blank out offline.

### 2. `--format react` (Vite + React + React Router SPA)
Directly compiles the captured DOM into valid, cleanly formatted **React JSX** components (`className`, `htmlFor`, `style={{ ... }}` objects, camelCased SVG attributes) and scaffolds a ready-to-run **Vite + React** project:
- Extracts shared `<header>` and `<footer>` into `src/components/Header.jsx` and `src/components/Footer.jsx`.
- Converts each crawled page into `src/pages/<PageName>.jsx` and wires all routes into `src/App.jsx` with `react-router-dom`.

### 3. `--format nextjs` (Next.js App Router Project)
Scaffolds a complete **Next.js App Router** project (`src/app/layout.jsx`, `src/app/globals.css`, `src/app/<route>/page.jsx`) with `next/link` routing and `public/assets/*`.

## Quick Start

```bash
# 1. Clean Vanilla HTML/CSS/JS (open index.html directly in browser!)
site-mirror run --start https://www.anthropic.com/research --singlePage --format html --out ./anthropic-html

# 2. Vite + React SPA
site-mirror run --start https://www.anthropic.com/research --singlePage --format react --out ./anthropic-react

# 3. Next.js App Router Project
site-mirror run --start https://www.anthropic.com/research --singlePage --format nextjs --out ./anthropic-nextjs

# Serve any output folder (automatically runs `npm run dev` for React/Next.js or static server for HTML)
site-mirror serve ./anthropic-react 3000
```

## Commands

| Command                         | Description                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `site-mirror init`              | Interactive setup - creates `site-mirror.config.json`                   |
| `site-mirror run [options]`     | Run the mirror (reads config + CLI overrides)                           |
| `site-mirror serve [dir] [port]`| Serve output folder locally (auto-detects HTML, React, or Next.js)      |

## CLI Options (for `run`)

| Option              | Description                                      | Default     |
| ------------------- | ------------------------------------------------ | ----------- |
| `--start <url>`     | Start URL (required if not in config)            | -           |
| `--out <dir>`       | Output directory                                 | `./offline` |
| `--format <type>`   | Export format: `html` \| `react` \| `nextjs`     | `html`      |
| `--html`            | Shorthand for `--format html`                    | -           |
| `--react`           | Shorthand for `--format react`                   | -           |
| `--nextjs`          | Shorthand for `--format nextjs`                  | -           |
| `--maxPages <n>`    | Max pages to crawl (`0` = unlimited)             | `0`         |
| `--maxDepth <n>`    | Max link depth (`0` = unlimited)                 | `0`         |
| `--sameOriginOnly`  | Only crawl same-origin pages                     | `true`      |
| `--seedSitemaps`    | Seed URLs from `sitemap.xml` / `robots.txt`      | `false`     |
| `--singlePage`      | Download only this page + all its assets         | `false`     |

## Output Structures

### HTML Mode (`--format html`)
```text
./output/
├── index.html                    # Formatted HTML (works directly via file:// double-click!)
├── css/
│   ├── globals.css               # Shared tokens (:root), @font-face & base resets
│   └── components/               # Purged, per-component stylesheets
│       ├── Navbar.css
│       ├── HeroTwoColumn.css
│       └── Footer.css
├── js/
│   └── main.js                   # Clean UI helper script
└── assets/
    ├── images/                   # Deduplicated images (unwraps /_next/image URLs)
    ├── fonts/                    # .woff2 / .woff / .ttf / .otf
    └── svg/                      # .svg icons & illustrations
```

### React Mode (`--format react`)
```text
./output/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── public/
│   └── assets/                   # images/, fonts/, svg/, media/
└── src/
    ├── main.tsx
    ├── App.tsx                   # React Router with all mirrored routes
    ├── styles/
    │   └── globals.css           # Lean global variables & @font-face rules
    ├── components/               # Auto-extracted components with co-located CSS!
    │   ├── Navbar/
    │   │   ├── Navbar.tsx
    │   │   └── Navbar.css
    │   ├── HeroTwoColumn/
    │   │   ├── HeroTwoColumn.tsx
    │   │   └── HeroTwoColumn.css
    │   ├── FeaturedGrid/
    │   │   ├── FeaturedGrid.tsx
    │   │   └── FeaturedGrid.css
    │   └── Footer/
    │       ├── Footer.tsx
    │       └── Footer.css
    └── pages/
        └── ResearchPage.tsx      # Composes <HeroTwoColumn />, <FeaturedGrid />, etc.
```

### Next.js Mode (`--format nextjs`)
```text
./output/
├── package.json
├── tsconfig.json
├── next.config.mjs
├── public/
│   └── assets/                   # images/, fonts/, svg/, media/
└── src/
    ├── components/               # Auto-extracted components with co-located CSS!
    │   ├── Navbar/
    │   │   ├── Navbar.tsx
    │   │   └── Navbar.css
    │   └── Footer/
    │       ├── Footer.tsx
    │       └── Footer.css
    └── app/
        ├── layout.tsx
        ├── globals.css
        ├── page.tsx
        └── research/
            └── page.tsx
```

## License

MIT
