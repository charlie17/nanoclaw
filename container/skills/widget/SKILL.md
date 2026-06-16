---
name: widget
description: Generate an interactive single-page web widget (Arrow JS + Tailwind) from JT's prompt and ship it to Cloudflare Pages behind CF Access, returning a tappable Telegram link. Invoke on the explicit `/widget <prompt>` command, and conservatively when JT clearly wants to *interactively touch* something — "let me play with X", "let me tweak Y", "compare these N options" with sliders/inputs/drag. Produces ad-hoc widgets only (Daystrom-generated, one-shot). Do NOT invoke for plain "show me" / "summarize" / "list" requests — those are normal chat replies.
---

# /widget — interactive web widgets (ad-hoc)

You generate a small, self-contained interactive web page (an **Arrow JS widget**), record it in the vault, and drop it into a host queue. A host worker (outside your container) compiles its styling, deploys it to Cloudflare Pages behind a Cloudflare Access PIN, and sends JT a tappable link on Telegram. **You generate and queue; you never deploy.** Your container has no internet and no deploy credentials by design — that is correct and must stay that way.

Canonical system explainer (read only if you need the why): `general/` is the vault; the full design lives in the repo's `widgets-system.md`. This skill is the runtime playbook.

## When to invoke

- **Explicit:** JT types `/widget <prompt>`.
- **Conservative implicit:** JT clearly wants to *interactively manipulate* something — "let me play with these numbers", "let me reprioritise and you process it", "compare these 3 quotes side by side and let me weight them", anything that wants sliders / inputs / toggles / drag-reorder.
- **Do NOT invoke** for plain display asks — "show me my projects", "summarise this", "list X". Those are ordinary chat replies. When unsure, ask JT "want an interactive widget for this, or just the answer here?" rather than silently building one.

This skill builds **ad-hoc** widgets only — generated fresh, treated as throwaway (the URL stays live forever, but you don't maintain it; you regenerate). Standing widgets (the Projects Board) are hand-authored and pinned by the Three Man Team, not generated here.

## The flow (async — the system acks; you stay silent)

1. **Parse intent** — what is JT manipulating? Identify the state variables and the actions (the buttons / inputs / drag the widget needs).
2. **Choose the `<id>`** (slug rule below).
3. **Generate the widget HTML** (generation playbook below).
4. **Write the vault stub** (schema below).
5. **Drop the bundle into the queue** atomically (procedure below).
6. **Stay silent — send NO message on the success path.** The system already fired an instant "Got it — working on it…" ack the moment JT sent `/widget`, and the host worker deploys asynchronously and sends the `🪟 Widget shipped: <link>` (or `⚠️ failed`) message itself. So once the bundle is dropped, **end your turn with no user-facing text** — do not say "building", do not summarize what you built, do not poll/wait/read a status file. A completion summary here only duplicates the host's shipped notice. **Exception:** if the bundle drop itself fails (e.g. the `mv` errors), DO report that — silence is for the success path only.

## The `<id>` / slug rule (HARD)

Pick **one** identifier, `<id>`, and use it **verbatim** in four places: the bundle filename stem, the JSON `.id` field, the vault stub filename, and (deterministically) the public URL `https://widgets.crystaldatalabs.com/<id>/`.

- Charset: **lowercase kebab, ASCII `[a-z0-9._-]` only**, ≤ **64** chars. No spaces, slashes, accents, or other punctuation.
- Derive it from the prompt; append today's date for uniqueness, e.g. `compare-hvac-quotes-2026-06-16`. Keep it readable — it's the URL.
- **It must already be clean** — the host re-sanitises the id and names the deploy artefacts off the sanitised value. If your filename stem and your `.id` ever differ (e.g. because a stray character got stripped), the deploy silently never reconciles. Generate the id clean once and reuse the exact same string everywhere.

## Generation playbook

Produce **one** self-contained HTML file. Stack: **Arrow JS** (tiny reactive UI lib, no build step) + **Tailwind** utility classes (compiled on the host — you do NOT include any Tailwind script).

### Single-file template

Start from this exact skeleton (fill the title, state, and view):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WIDGET TITLE</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body class="bg-stone-50 text-stone-900 p-4 sm:p-6">
  <div id="app"></div>
  <script type="module">
    import { reactive, html } from 'https://esm.sh/@arrow-js/core@1.0.6'

    const state = reactive({ /* initial state */ })

    const view = html`<!-- template bound to state -->`

    view(document.getElementById('app'))
  </script>
</body>
</html>
```

Non-negotiables:

- **`<link rel="stylesheet" href="./styles.css">` in `<head>`, and NO Tailwind `<script>`.** The host compiles a tree-shaken `styles.css` and serves it as a sibling of your `index.html` at `/<id>/styles.css`; the relative href resolves. A `cdn.tailwindcss.com` script would be redundant weight and is forbidden.
- **Mobile-first.** JT opens these from a phone (Telegram tap → CF Access). Default to single-column, large tap targets; layer desktop with `sm:` / `md:` breakpoints.
- **Pin every dependency** (next section) — no floating CDN URLs.

### Tailwind classes MUST be complete literal strings (HARD)

The host compiles CSS with `--content index.html`, which tree-shakes to **only the utility classes that appear as literal substrings** in the HTML. Any class your Arrow JS builds at runtime by concatenation — `` `text-${color}-500` ``, `'bg-' + shade` — is **tree-shaken out and renders unstyled.**

- Write every class as a complete literal: `class="text-red-500"`, not assembled from pieces.
- To switch styling reactively, **swap between complete literal strings**, e.g. `${() => state.ok ? 'text-green-600' : 'text-red-600'}` — both full class strings are literally present, so both survive.
- If you genuinely must build a class dynamically, add an HTML comment listing every possible full class as a safelist so the compiler sees them: `<!-- tw-safelist: bg-red-500 bg-green-500 bg-amber-500 -->`.

### Pinned dependencies (esm.sh, fixed versions)

Always import these exact pinned URLs (the browser fetches them at open-time — that's the browser's network, not your container's):

- Arrow JS: `https://esm.sh/@arrow-js/core@1.0.6`
- SortableJS (only on widgets with drag-reorder): `https://esm.sh/sortablejs@1.15.7`
- Mermaid (only on widgets that render diagrams): `https://esm.sh/mermaid@11.15.0`

## Arrow JS quick reference

The whole API surface is small. Canonical docs: https://www.arrow-js.com/ (you can't browse — this is the minimum).

**Reactive state** — mutate directly; bound views re-render:
```js
const state = reactive({ count: 0, items: ['a', 'b'], selected: null })
state.count++          // bound views update
state.items.push('c')
```

**Templates** — reactive interpolations MUST be functions; event bindings are function references:
```js
const view = html`
  <div>
    <p>Count: ${() => state.count}</p>
    <button @click="${() => state.count++}" class="px-3 py-1 rounded bg-stone-800 text-white">+</button>
  </div>
`
view(document.getElementById('app'))
```
- `${() => state.x}` — **a function**. `${state.x}` bakes the value in once and never updates. This is the single most common mistake — always wrap reactive reads in `() =>`.
- `@event="${handler}"` — `handler` is a function reference, not a function returning a function.

**Conditionals** — nested templates are first-class:
```js
html`${() => state.selected
  ? html`<div>${() => state.selected}</div>`
  : html`<em class="text-stone-400">Pick one</em>`
}`
```

**Loops** — return an array of templates from a function-interpolation. For any list that will be **reordered or patched**, give each row a stable key with `.key(id)` so Arrow patches the row in place instead of replacing it:
```js
html`<ul>${() => state.items.map(item =>
  html`<li class="py-1">${() => item.name}</li>`.key(item.id)
)}</ul>`
```

**Two-way input** — one-way bind + an input handler (no `v-model`):
```js
html`<input
  class="border rounded px-2 py-1 w-full"
  value="${() => state.name}"
  @input="${(e) => state.name = e.target.value}"
>`
```

## Drag-and-drop — SortableJS (only when the widget needs reorder)

Arrow has no drag-and-drop. Use pinned SortableJS, wired into reactive state on drop, over a **keyed** list so Arrow's in-place patching keeps Sortable's DOM attachment alive:

```js
import { reactive, html } from 'https://esm.sh/@arrow-js/core@1.0.6'
import Sortable from 'https://esm.sh/sortablejs@1.15.7'

const state = reactive({ rows: [/* {id, name} */] })

const view = html`
  <ul id="rows">
    ${() => state.rows.map(r => html`<li class="py-1 px-2 bg-white rounded border mb-1">${() => r.name}</li>`.key(r.id))}
  </ul>
`
view(document.getElementById('app'))

Sortable.create(document.getElementById('rows'), {
  animation: 150,
  onEnd: (e) => {
    if (e.oldIndex === e.newIndex) return
    const moved = state.rows.splice(e.oldIndex, 1)[0]
    state.rows.splice(e.newIndex, 0, moved)   // reactive state is the source of truth
  },
})
```
Keep the list keyed (`.key(r.id)`). If you ever see Sortable lose its grip after a render, the list isn't keyed.

## Mermaid — diagrams (only when the widget renders one)

Lazy-load pinned Mermaid; only diagram widgets pay its weight:
```js
import mermaid from 'https://esm.sh/mermaid@11.15.0'
mermaid.initialize({ startOnLoad: false })
const { svg } = await mermaid.render('diagram', state.graphDefinition)
document.getElementById('diagram').innerHTML = svg
```

## Vault stub

Write a searchable record to **`/workspace/extra/vault/widgets/<id>.md`** (this is vault `general/widgets/<id>.md` — your vault mount is `/workspace/extra/vault/`, so **never prepend `general/`** to the container path). The `widgets/` folder **already exists** — just write the file into it. Do **not** create vault directories (that's a hard `CLAUDE.md` rule).

```markdown
---
type: widget
kind: ad-hoc
created: <YYYY-MM-DD>
slug: <id>
url: https://widgets.crystaldatalabs.com/<id>/
prompt: |
  <JT's original prompt, verbatim>
---
# Widget — <short human description>

<1–2 sentences: what it shows + how to interact with it.>

[Open widget](https://widgets.crystaldatalabs.com/<id>/)
```

`url` is deterministic (it's `…/<id>/`), so it's correct to write before the deploy finishes. Do **not** add a deploy-status field — you ack async and the host's Telegram notify is the deploy outcome, not the stub.

## Drop the bundle into the queue (atomic)

The host worker watches `/workspace/extra/widget-queue/` for a **single self-contained** trigger `<id>.bundle.json` = `{ id, title, kind, html }`, where `html` is the **entire** widget HTML as a JSON string. `kind` is `"ad-hoc"` for everything this skill makes.

**Write it atomically** — write to a temp name that does NOT end in `.bundle.json`, then rename. The watcher only acts on `*.bundle.json`, so the temp file is ignored and the rename exposes a complete file (never a half-written one). **Do not hand-escape the HTML into JSON** — let `node` build the JSON so escaping is exact:

```bash
# 0. Set the identifier ONCE — the single source of truth. Everything below derives
#    from "$id", so "bundle filename stem == JSON .id" is guaranteed by construction
#    (a mismatch fails LOUDLY at the node read in step 2, never silently at deploy).
id="<id>"        # the slug you generated, e.g. compare-hvac-quotes-2026-06-16
title="<title>"

# 1. Create the build dir (so a fresh container doesn't fail on a missing dir), then
#    Write the complete widget HTML (raw, no escaping) with the Write tool to EXACTLY
#    /tmp/widget-build/$id.html — same id, or the node read in step 2 errors out:
mkdir -p /tmp/widget-build

# 2. Assemble the bundle JSON with node (bulletproof escaping) into a dot-prefixed
#    temp INSIDE the queue dir (dot-prefix + .tmp keeps it out of the *.bundle.json watch):
node -e '
  const fs = require("fs");
  const [htmlPath, id, title, out] = process.argv.slice(1);
  const html = fs.readFileSync(htmlPath, "utf8");
  fs.writeFileSync(out, JSON.stringify({ id, title, kind: "ad-hoc", html }));
' "/tmp/widget-build/$id.html" "$id" "$title" "/workspace/extra/widget-queue/.$id.bundle.json.tmp"

# 3. Atomic rename into place (same filesystem → atomic):
mv "/workspace/extra/widget-queue/.$id.bundle.json.tmp" "/workspace/extra/widget-queue/$id.bundle.json"
```

The filename stem and the JSON `.id` are the same `"$id"` string by construction — see the slug rule.

## Hard constraints — do NOT

- **Do NOT deploy, run `wrangler`, or touch Cloudflare** — deploy is host-side; you have no credentials and no internet, and that isolation must stay intact.
- **Do NOT ask your container to fetch the internet** (no `curl`/`fetch`/`npm install` of widget deps). The widget's own `esm.sh` imports run in JT's *browser* at open-time — that's fine; your container fetching anything is not.
- **Do NOT write the HTML and a manifest as two files** — one self-contained `<id>.bundle.json` only.
- **Do NOT add a "Send to Daystrom" / feedback button or any POST-back in a generated widget.** Local interactivity (sliders, inputs, toggles, drag, local computation) is fully in scope; the round-trip-to-Daystrom feedback channel ships in a later step with its endpoint. A button posting to an endpoint that doesn't exist yet would be a broken affordance.
- **Do NOT poll or wait for the deploy.** Ack `🛠️ Building your widget…` and stop.
