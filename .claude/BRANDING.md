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

### Primary Symbol — The Butterfly (🦋)
The butterfly is the core brand symbol. It represents transformation, connection, and social movement. The butterfly mark is always rendered in **Monarch coloring** (warm amber/orange wings with black veining and white edge spots) on a purple field.

**Do:**
- Use the butterfly on all app icons, splash screens, and marketing surfaces
- Maintain the Monarch color palette on the butterfly itself
- Always place on the brand purple background for app icons

**Don't:**
- Replace the butterfly with abstract shapes or letters
- Render it in off-brand colors (no blue, red, or grey butterflies)
- Use generic emoji rendering — use the brand SVG asset for icons

### Icon Construction
App icons use a **purple rounded-square** background with the butterfly centered and scaled to ~65% of the container.

| Asset | Size | File |
|-------|------|------|
| App icon | 192×192 px | `web/public/icons/icon-192.png` |
| App icon | 512×512 px | `web/public/icons/icon-512.png` |
| Apple touch icon | 180×180 px | `web/public/icons/apple-touch-icon.png` |
| Favicon | 32×32 px | `web/public/favicon.ico` (or `favicon-32.png`) |
| SVG master | vector | `web/public/icons/butterfly.svg` |

---

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
