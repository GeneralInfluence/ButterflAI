# ButterflAI — Brand Standards

> Last updated: 2026-07-16

---

## 1. Brand Identity

**Name:** ButterflAI  
**Pronunciation:** "Butterfly AI" (the AI merges into the word)  
**Tagline:** *Your social assistant*  
**Mission:** The agent does the logistical labor of friendship so the human can do the emotional labor of friendship.

---

## 2. Logo & Symbol

> **Updated 2026-10-21 (owner):** the butterfly is a **cyborg butterfly in rust, purple and bright cyan** — "every
> butterfly in the app should be consistent", and every option we try is kept.

### The butterfly
- **In use:** `web/public/icons/butterflies/cyborg-steampunk-purple-cyan-edge.png` — a steampunk cyborg butterfly recolored
  to ButterflAI purple (#6C47FF) with rust (#B4532A) details, its wing edges glowing bright cyan (#3CF2FF, the antenna-tip
  color) for contrast from edge to center (owner, 2026-10-21).
- **One butterfly everywhere:** every screen shows `web/public/icons/butterfly-128.png` (tab icons, the ButterflAI tab,
  logos, empty states, install prompt); favicons are `icons/favicon-32.png` / `favicon.ico`; the home-screen icons
  (`icon-192/512.png`, `apple-touch-icon.png`) are the butterfly on **Purple Pale (#EDE9FE)** — a purple butterfly
  doesn't show on brand purple. No 🦋 emoji on any screen (a test checks); text messages (SMS, push titles) keep words.
- **All options kept:** `web/public/icons/butterflies/` — the original orange monarch, the monarch in the new colors,
  a simple flat cyborg, and the steampunk cyborg (as sent + three recolors). See them side by side in the app:
  **Settings → Butterfly designs** (`/app/butterflies`).
- **To switch:** `node tools/butterfly-icons.js public/icons/butterflies/<file>` (run in `web/`, needs Playwright —
  `npx -y -p playwright node tools/butterfly-icons.js …`), then deploy. It rewrites the current butterfly, the 128px
  in-app image, app icons and favicons.
- **Licensing:** the steampunk designs come from an image found on the web — fine for friends testing; license it or
  commission an original before public launch. The monarch and the flat cyborg are ours.
- The Android notification badge (`icons/badge.svg`) stays a plain white silhouette (Android tints it).

### Previous (until 2026-10-21)
The orange Monarch (`icons/butterfly.svg`) on a purple rounded square — kept as `butterflies/monarch-original.svg`.

## 3. Color Palette

### Primary
| Name | Hex | Usage |
|------|-----|-------|
| **Brand Purple** | `#6c47ff` | Primary actions, links, active states, icon background |
| **Purple Dark** | `#5a38d9` | Hover states, pressed buttons |
| **Purple Light** | `#a78bfa` | Gradients, secondary accents, avatars |
| **Purple Pale** | `#ede9fe` | Backgrounds, pill badges, selected states |

### Neutral
| Name | Hex | Usage |
|------|-----|-------|
| **Ink** | `#1c1c1e` | Primary text |
| **Slate** | `#3a3a3c` | Secondary text, labels |
| **Mist** | `#8e8e93` | Placeholder, metadata, tertiary text |
| **Fog** | `#e5e5e5` | Borders, dividers |
| **Cloud** | `#f2f2f7` | Page backgrounds, cards |
| **White** | `#ffffff` | Surfaces, chat bubbles |

### Semantic
| Name | Hex | Usage |
|------|-----|-------|
| **Success Green** | `#34c759` | Accepted RSVPs, confirmed states |
| **Danger Red** | `#ef4444` | Declined RSVPs, destructive actions |
| **Warning Amber** | `#f59e0b` | Pending states, caution |

---

## 4. Typography

**Primary Font:** System UI stack (no external font dependency for performance)  
```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

### Scale
| Role | Size | Weight | Usage |
|------|------|--------|-------|
| Page title | 20px | 700 | App headers, modals |
| Section header | 16px | 700 | Card titles, nav headers |
| Body | 15px | 400 | Chat messages, descriptions |
| Label | 13px | 500 | Badges, metadata, captions |
| Micro | 11px | 500 | Timestamps, tab labels |

---

## 5. UI Components

### Buttons
- **Primary:** `background: #6c47ff`, white text, `border-radius: 12px`, `font-weight: 600`
- **Secondary:** `background: #f2f2f7`, ink text, same radius/weight
- **Destructive:** `background: #ef4444`, white text

### Cards
- `background: #fff`, `border-radius: 16px`, subtle shadow (`0 1px 3px rgba(0,0,0,.08)`)
- Active/selected state: `border: 2px solid #6c47ff`

### Input fields
- `border: 1.5px solid #e5e5e5`, `border-radius: 22px` (for chat), `12px` (for forms)
- Focus: `border-color: #6c47ff`, `background: #fff`

### Navigation (mobile bottom nav)
- Height: `58px`, `background: #fff`, `border-top: 1px solid #e5e5e5`
- Active tab color: `#6c47ff`
- Inactive tab color: `#8e8e93`
- Icon size: `22px`, label `10px`

---

## 6. App Shell

### Theme Color
- `<meta name="theme-color" content="#6c47ff">` (browser chrome tint on Android)
- PWA `background_color`: `#f2f2f7`
- PWA `theme_color`: `#6c47ff`

### Status Bar (iOS)
- `<meta name="apple-mobile-web-app-status-bar-style" content="default">`

### Splash / Loading
- Purple background (`#6c47ff`) with centered white butterfly SVG

---

## 7. Voice & Tone

- **Warm, not corporate.** The agent feels like a thoughtful friend, not a CRM.
- **Action-oriented.** Short sentences. No filler words ("Great question!").
- **Honest about being an AI.** Never pretends to be human.
- **Capability language for FLAI.** Never mention balances, scores, or points. Talk about what the user *can do*, not what they've *earned*.

---

## 8. Icon Generation

To regenerate icons from the master SVG:

```sh
cd web/public/icons
# Requires ImageMagick
convert -background "#6c47ff" -gravity center butterfly.svg \
  -resize 192x192 icon-192.png
convert -background "#6c47ff" -gravity center butterfly.svg \
  -resize 512x512 icon-512.png
convert -background "#6c47ff" -gravity center butterfly.svg \
  -resize 180x180 apple-touch-icon.png
```

---

## 9. File Inventory

```
web/public/
  manifest.json          — PWA manifest
  icons/
    butterfly.svg        — Master vector (source of truth)
    icon-192.png         — Android PWA icon
    icon-512.png         — Android PWA icon (splash/install)
    apple-touch-icon.png — iOS home screen icon
  favicon.png            — Browser tab icon
```
