---
name: ui-ux-pro-max
description: Comprehensive design guide with 67 styles, 161 color palettes, 57 font pairings, 99 UX guidelines. Search and apply professional UI/UX patterns.
---

# ui-ux-pro-max

Comprehensive design intelligence for professional UI/UX. Search 67 styles, 161 color palettes, 57 font pairings, 99 UX guidelines, 25 chart types, and platform-specific best practices.

# Prerequisites

Check if Python is installed:

```bash
python3 --version || python --version
```

---

## How to Use This Skill

Use this skill when the user requests any of the following:

| Scenario | Trigger Examples | Start From |
|----------|-----------------|------------|
| **New project / page** | "Build a landing page", "Build a dashboard" | Step 1 → Step 2 (design system) |
| **New component** | "Create a pricing card", "Add a modal" | Step 3 (domain search: style, ux) |
| **Choose style / color / font** | "What style fits a fintech app?" | Step 2 (design system) |
| **Review existing UI** | "Review this page for UX issues" | Quick Reference checklist |
| **Fix a UI bug** | "Button hover is broken", "Layout shifts on load" | Quick Reference → relevant section |
| **Improve / optimize** | "Make this faster", "Improve mobile experience" | Step 3 (domain search: ux, react) |
| **Implement dark mode** | "Add dark mode support" | Step 3 (domain: style "dark mode") |
| **Add charts / data viz** | "Add an analytics dashboard chart" | Step 3 (domain: chart) |
| **Stack best practices** | "React performance tips" | Step 4 (stack search) |

Follow this workflow:

### Step 1: Analyze User Requirements

Extract key information from user request:
- **Product type**: Entertainment, Tool, Productivity, SaaS, or hybrid
- **Target audience**: Consider age group, usage context
- **Style keywords**: playful, vibrant, minimal, dark mode, content-first, immersive, etc.
- **Stack**: Identify the tech stack in use

### Step 2: Generate Design System (REQUIRED)

**Always start with `--design-system`** to get comprehensive recommendations with reasoning:

```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<product_type> <industry> <keywords>" --design-system [-p "Project Name"]
```

This command:
1. Searches domains in parallel (product, style, color, landing, typography)
2. Applies reasoning rules from `ui-reasoning.csv` to select best matches
3. Returns complete design system: pattern, style, colors, typography, effects
4. Includes anti-patterns to avoid

**Example:**
```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "beauty spa wellness service" --design-system -p "Serenity Spa"
```

### Step 2b: Persist Design System (Master + Overrides Pattern)

To save the design system for **hierarchical retrieval across sessions**, add `--persist`:

```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<query>" --design-system --persist -p "Project Name"
```

This creates:
- `design-system/MASTER.md` — Global Source of Truth with all design rules
- `design-system/pages/` — Folder for page-specific overrides

**With page-specific override:**
```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<query>" --design-system --persist -p "Project Name" --page "dashboard"
```

### Step 3: Supplement with Detailed Searches (as needed)

After getting the design system, use domain searches to get additional details:

```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<keyword>" --domain <domain> [-n <max_results>]
```

**Available domains:**

| Domain | Use For | Example Keywords |
|--------|---------|------------------|
| `product` | Product type recommendations | SaaS, e-commerce, portfolio, healthcare, beauty, service |
| `style` | UI styles, colors, effects | glassmorphism, minimalism, dark mode, brutalism |
| `typography` | Font pairings, Google Fonts | elegant, playful, professional, modern |
| `color` | Color palettes by product type | saas, ecommerce, healthcare, beauty, fintech, service |
| `landing` | Page structure, CTA strategies | hero, hero-centric, testimonial, pricing, social-proof |
| `chart` | Chart types, library recommendations | trend, comparison, timeline, funnel, pie |
| `ux` | Best practices, anti-patterns | animation, accessibility, z-index, loading |
| `react` | React/Next.js performance | waterfall, bundle, suspense, memo, rerender, cache |
| `web` | App interface guidelines | accessibilityLabel, touch targets, safe areas, Dynamic Type |
| `prompt` | AI prompts, CSS keywords | (style name) |

### Step 4: Stack Guidelines

Get stack-specific implementation best practices:

```bash
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<keyword>" --stack <stack_name>
```

Available stacks: react, nextjs, vue, svelte, astro, swiftui, react-native, flutter, nuxtjs, nuxt-ui, html-tailwind, shadcn, jetpack-compose, threejs

---

## Output Formats

The `--design-system` flag supports two output formats:

```bash
# ASCII box (default) - best for terminal display
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "fintech crypto" --design-system

# Markdown - best for documentation
python3 .skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "fintech crypto" --design-system -f markdown
```

---

## Tips for Better Results

### Query Strategy

- Use **multi-dimensional keywords** — combine product + industry + tone + density: `"entertainment social vibrant content-dense"` not just `"app"`
- Try different keywords for the same need: `"playful neon"` → `"vibrant dark"` → `"content-first minimal"`
- Use `--design-system` first for full recommendations, then `--domain` to deep-dive any dimension
- Always add `--stack <name>` for implementation-specific guidance

### Common Sticking Points

| Problem | What to Do |
|---------|------------|
| Can't decide on style/color | Re-run `--design-system` with different keywords |
| Dark mode contrast issues | Search `--domain ux "color-dark-mode color-accessible-pairs"` |
| Animations feel unnatural | Search `--domain ux "spring-physics easing exit-faster-than-enter"` |
| Form UX is poor | Search `--domain ux "inline-validation error-clarity focus-management"` |
| Navigation feels confusing | Search `--domain ux "nav-hierarchy bottom-nav-limit back-behavior"` |
| Layout breaks on small screens | Search `--domain ux "mobile-first breakpoint-consistency"` |
| Performance / jank | Search `--domain ux "virtualize-lists main-thread-budget debounce-throttle"` |

### Pre-Delivery Checklist

- Run `--domain ux "animation accessibility z-index loading"` as a UX validation pass
- Test on 375px (small phone) and landscape orientation
- Verify behavior with **reduced-motion** enabled
- Check dark mode contrast independently
- Confirm all touch targets ≥44pt

---

## Common Rules for Professional UI

### Icons & Visual Elements

| Rule | Standard | Avoid |
|------|----------|-------|
| **No Emoji as Icons** | Use vector-based icons (Phosphor, Heroicons, Lucide) | Using emojis for navigation or system controls |
| **Vector-Only Assets** | Use SVG or platform vector icons that scale cleanly | Raster PNG icons that blur or pixelate |
| **Consistent Icon Sizing** | Define icon sizes as design tokens (icon-sm, icon-md, icon-lg) | Mixing arbitrary values randomly |
| **Stroke Consistency** | Use consistent stroke width within same visual layer | Mixing thick and thin stroke styles |
| **Icon Contrast** | WCAG: 4.5:1 for small elements, 3:1 for larger UI glyphs | Low-contrast icons blending into background |

### Interaction

| Rule | Do | Don't |
|------|----|----- |
| **Tap feedback** | Clear pressed feedback within 80-150ms | No visual response on tap |
| **Animation timing** | 150-300ms with platform-native easing | Instant transitions or >500ms |
| **Touch target minimum** | >=44x44pt (iOS) or >=48x48dp (Android) | Tiny tap targets without padding |
| **Disabled state clarity** | Reduced emphasis + no tap action | Controls that look tappable but do nothing |

### Light/Dark Mode Contrast

| Rule | Do | Don't |
|------|----|----- |
| **Text contrast (light)** | Body text contrast >=4.5:1 | Low-contrast gray body text |
| **Text contrast (dark)** | Primary text >=4.5:1, secondary >=3:1 | Text blending into dark background |
| **Token-driven theming** | Semantic color tokens mapped per theme | Hardcoded per-screen hex values |
| **Scrim legibility** | Modal scrim 40-60% black | Weak scrim with background competing |

### Layout & Spacing

| Rule | Do | Don't |
|------|----|----- |
| **Safe-area compliance** | Respect top/bottom safe areas | UI under notch or gesture area |
| **8dp spacing rhythm** | Consistent 4/8dp spacing system | Random spacing increments |
| **Readable text measure** | Limit line length on larger devices | Edge-to-edge paragraphs on tablets |
| **Scroll coexistence** | Bottom/top insets for fixed bars | Content hidden behind sticky elements |
