---
name: widget
description: Generate an interactive single-page web widget (Arrow JS + Tailwind) from JT's prompt and ship it to Cloudflare Pages behind CF Access, returning a tappable Telegram link. Invoke on the explicit `/widget <prompt>` command, and conservatively when JT clearly wants to *interactively touch* something — "let me play with X", "let me tweak Y", "compare these N options" with sliders/inputs/drag. Produces ad-hoc widgets only (Daystrom-generated, one-shot). Do NOT invoke for plain "show me" / "summarize" / "list" requests — those are normal chat replies. ALSO consult this skill when an inbound message contains a widget-feedback envelope (the sentinel line `===WIDGET-FEEDBACK-ENVELOPE-v1===`) — that is a widget sending its state back for you to discuss; see "Handling widget feedback".
---

# /widget — interactive web widgets (ad-hoc)

You generate a small, self-contained interactive web page (an **Arrow JS widget**), record it in the vault, and drop it into a host queue. A host worker (outside your container) compiles its styling, deploys it to Cloudflare Pages behind a Cloudflare Access PIN, and sends JT a tappable link on Telegram. **You generate and queue; you never deploy.** Your container has no internet and no deploy credentials by design — that is correct and must stay that way.

Canonical system explainer (read only if you need the why): `general/` is the vault; the full design lives in the repo's `widgets-system.md`. This skill is the runtime playbook.

## When to invoke

- **Explicit:** JT types `/widget <prompt>`.
- **Conservative implicit:** JT clearly wants to *interactively manipulate* something — "let me play with these numbers", "let me reprioritise and you process it", "compare these 3 quotes side by side and let me weight them", anything that wants sliders / inputs / toggles / drag-reorder.
- **Do NOT invoke** for plain display asks — "show me my projects", "summarise this", "list X". Those are ordinary chat replies. When unsure, ask JT "want an interactive widget for this, or just the answer here?" rather than silently building one.

This skill builds **ad-hoc** widgets only — generated fresh, treated as throwaway (the URL stays live forever, but you don't maintain it; you regenerate). Standing widgets (the Projects Board) are hand-authored and pinned by the Three Man Team, not generated here.

## The flow (async — you ack once, the host ships the link)

1. **Parse intent** — what is JT manipulating? Identify the state variables and the actions (the buttons / inputs / drag the widget needs).
2. **Choose the `<id>`** (slug rule below).
3. **Generate the widget HTML** (generation playbook below).
4. **Write the vault stub** (schema below).
5. **Drop the bundle into the queue** atomically (procedure below).
6. **Always emit ONE building ack first, then stay silent.** The moment you've decided to build a widget — **regardless of how JT asked** (the literal `/widget` command OR a natural-language request like "make me a widget…", "let me play with X", "let me tweak Y") — your **first** output is exactly one short building line, sent *before* you start generating: e.g. `🛠️ Building your widget — I'll ping back when it's live.` The host no longer acks widgets, so **this agent ack is the only "working on it" signal** and it must fire in *every* case (it works whether your session is warm or cold; a host ack would not). After the ack, stay silent: the host worker deploys asynchronously and sends the `🪟 Widget shipped: <link>` (or `⚠️ failed`) message itself. JT does **not** want a "queued" / "link incoming" / summary message from you between your ack and the host's shipped line — it's pure noise. **If you want to note completion, wrap your ENTIRE final message in `<internal>…</internal>` tags** — the system strips those before anything is sent, so JT sees nothing (output exactly, e.g.: `<internal>bundle queued; host will ship</internal>`). Do not poll, wait, or read a status file. **Exception:** if the bundle drop itself fails (e.g. the `mv` errors), report THAT as a normal (non-`<internal>`) message — a failure is the one thing JT must hear about.

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
<body class="bg-slate-900 text-slate-100 p-4 sm:p-6">
  <div id="app"></div>
  <script type="module">
    import { reactive, html } from 'https://esm.sh/@arrow-js/core@1.0.6'

    const state = reactive({ count: 0 })

    // Build your reactive UI here. HARD RULE: NO HTML comments (<!-- … -->) anywhere
    // inside an html`` template — Arrow reads every comment node as an interpolation
    // slot, miscounts, and throws "Invalid HTML position" → the widget renders BLANK.
    // Annotate with JS comments (like this one) OUTSIDE the template only.
    const view = html`
      <div class="flex flex-col gap-4 items-center">
        <p class="text-2xl font-semibold">${() => state.count}</p>
        <button @click="${() => state.count++}" class="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white">+1</button>
      </div>
    `

    view(document.getElementById('app'))
  </script>
  <footer class="mt-10 text-center text-xs text-slate-100">
    Updated <CREATED> · <a class="underline hover:text-slate-300" href="https://daystrom-link.daystrom.workers.dev/?u=obsidian%3A%2F%2Fopen%3Fvault%3DObsidianDaystromVault%26file%3Dgeneral%2Fwidgets%2F<id>">📝 vault note</a>
  </footer>
</body>
</html>
```

Non-negotiables:

- **`<link rel="stylesheet" href="./styles.css">` in `<head>`, and NO Tailwind `<script>`.** The host compiles a tree-shaken `styles.css` and serves it as a sibling of your `index.html` at `/<id>/styles.css`; the relative href resolves. A `cdn.tailwindcss.com` script would be redundant weight and is forbidden.
- **Keep the footer** (last-updated timestamp + vault-note link), with two substitutions. **(1) `<CREATED>`** — the time this widget's content was generated (on a fresh build, that's now; if you ever regenerate/tweak an existing widget, recompute it). Compute it with Bash, **never in your head** (LLMs get day-of-week wrong): run `TZ=America/New_York date '+%a %-m/%-d/%y %-I:%M%P'` and append ` ET` → e.g. `Tue 6/16/26 2:03pm ET`. Embed the literal output. **Reuse this exact `<CREATED>` value in the vault stub** (below) so the footer and note agree (the stub's `*Updated …*` line; frontmatter `created:` stays the original birth date). **(2) `<id>`** into the vault-note href — URL-safe kebab, drop in verbatim, and **do not re-encode the rest of the href** (it's already percent-encoded). The link deep-links back to this widget's stub (`general/widgets/<id>.md`) via the Obsidian CF-worker redirect — the reverse of the stub's "Open widget" link. **Footer text color = `text-slate-100` (white), NOT a muted gray** (`text-slate-400/500/600`) — JT wants the footer legible, not faded. Keep the link's `underline` + `hover:text-slate-300`.
- **Mobile-first.** JT opens these from a phone (Telegram tap → CF Access). Default to single-column, large tap targets; layer desktop with `sm:` / `md:` breakpoints.
- **Dark mode only (HARD).** Every widget renders dark — one fixed dark palette, no light option, no `dark:` variants, no toggle. Base: `bg-slate-900` (or `bg-slate-950`) + `text-slate-100`; surfaces a step lighter (`bg-slate-800`); borders `border-slate-700`; muted text `text-slate-400`/`text-slate-500`; bright accents that pop on dark (`emerald`, `sky`, `amber`, `rose`…). **Never use a light background** (`bg-white`, `bg-stone-50`, `bg-gray-100`, etc.) or dark-on-light text — it'll glare against the dark shell. Pick legible accent + text contrasts for a dark surface.
- **Pin every dependency** (next section) — no floating CDN URLs.
- **NO HTML comments inside an `html\`\`` template (HARD).** Arrow reads every `<!-- … -->` comment node as an interpolation slot, miscounts against the real `${}` count, and throws `Invalid HTML position` — the widget renders **completely blank**. (This bit a live widget 2026-06-16.) Don't annotate templates with `<!-- … -->`; use JS comments *outside* the `html\`\`` block, or no comments.
- **A dynamic attribute must be ONE complete `${}` expression — never mix `${}` with static text in the same attribute value (HARD).** `class="${() => colorFn()} text-9xl font-bold"` (expression **+** trailing static text) throws `Invalid HTML position` and renders the widget **completely blank** — reproduced against Arrow 1.0.6 on 2026-06-16 (`class="${() => 'x'} y"` throws; `class="${() => 'x y'}"` and `class="x y"` both work). Fix: pull the whole value into the expression — `class="${() => colorFn() + ' text-9xl font-bold'}"` — or make it fully static, or swap complete literals `class="${() => ok ? 'a b' : 'c d'}"`. The appended/literal class strings are still literal substrings in the source, so Tailwind tree-shaking (below) keeps them. Same rule for `style`, `href`, any attribute: **100% static OR 100% one `${}` expression, never spliced.**

### Tailwind classes MUST be complete literal strings (HARD)

The host compiles CSS with `--content index.html`, which tree-shakes to **only the utility classes that appear as literal substrings** in the HTML. Any class your Arrow JS builds at runtime by concatenation — `` `text-${color}-500` ``, `'bg-' + shade` — is **tree-shaken out and renders unstyled.**

- Write every class as a complete literal: `class="text-red-500"`, not assembled from pieces.
- To switch styling reactively, **swap between complete literal strings**, e.g. `${() => state.ok ? 'text-green-600' : 'text-red-600'}` — both full class strings are literally present, so both survive.
- If you genuinely must build a class dynamically, add an HTML comment listing every possible full class as a safelist so the compiler sees them: `<!-- tw-safelist: bg-red-500 bg-green-500 bg-amber-500 -->`. **Put this comment in the static HTML (e.g. just inside `<body>`), NEVER inside an `html\`\`` template** — a comment inside the template blanks the widget (see the HTML-comments HARD rule above).

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

## "Send to Daystrom" feedback button (only when JT wants to send state back)

Some widgets are **conversational** — JT manipulates state, then wants *you* to receive that state and discuss/analyse it (not just compute locally). Add a **"Send to Daystrom" button** only when the prompt clearly implies a round-trip: interactive inputs **plus** "analyse this", "let me tweak it and you process it", "send me your read on these numbers", etc. A widget that's purely a local calculator/comparator needs **no** Send button — don't add one speculatively.

When you do add it: a button POSTs the current widget state cross-origin to the Bridge, which routes it back to you as a normal Telegram message (you reply in JT's chat). The POST is to a **different host** than the widget (`widgets.…` → `daystrom.…`), so it's cross-origin — the endpoint's CORS allows exactly the widgets origin.

Recipe — drop this into the widget's `<script type="module">`, wired to your state:

```js
const FEEDBACK_URL = 'https://daystrom.crystaldatalabs.com/widget/feedback'
const FEEDBACK_TOKEN = 'WIDGET_FEEDBACK_TOKEN_VALUE'  // see note below
const WIDGET_ID = '<id>'                               // this widget's id, verbatim

const ui = reactive({ sending: false, sent: false, error: '' })

async function sendToDaystrom() {
  if (ui.sending || ui.sent) return            // soft-lock: one send in flight, and don't re-send after success
  ui.sending = true; ui.error = ''
  try {
    const res = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FEEDBACK_TOKEN}` },
      body: JSON.stringify({ type: 'conversational', widgetId: WIDGET_ID, state: state }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    ui.sent = true                              // instant client ack — covers the ~10-30s round-trip; zero backend wait
  } catch (e) {
    ui.error = 'Couldn’t send — try again'
  } finally {
    ui.sending = false
  }
}

const sendButton = html`
  <button
    @click="${sendToDaystrom}"
    ?disabled="${() => ui.sending || ui.sent}"
    class="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white font-medium">
    ${() => ui.sent ? '✅ Sent — Daystrom’s reviewing, check Telegram' : ui.sending ? 'Sending…' : 'Send to Daystrom'}
  </button>
  ${() => ui.error ? html`<p class="text-rose-400 text-sm mt-1">⚠️ ${() => ui.error}</p>` : ''}
`
```

Wiring rules:

- **`state` is whatever your widget's reactive state object is** — pass the slice JT cares about (don't dump UI-only flags). Keep it JSON-serialisable (numbers, strings, arrays, plain objects).
- **Soft-lock the button**: disabled while `ui.sending` and after `ui.sent` (bind `disabled` to `${() => ui.sending || ui.sent}` via an attribute — e.g. `<button ... ?disabled="${() => ui.sending || ui.sent}">`, or set `el.disabled` in an effect). One send per interaction; JT re-opens / re-runs to send again.
- **Instant ack only** — flip to "✅ Sent…" on a 2xx and stop. **Do NOT** wait for, poll, or display Daystrom's analysis in the widget; that lands in Telegram. The widget's job ends at "Sent".
- **`type: 'conversational'`** always for ad-hoc Send. (`write-back` / `refresh` are the standing Projects Board's types — not for ad-hoc widgets.)
- **Dark palette still applies** — the Send button is `bg-sky-500`/`bg-emerald-500`-class on the dark surface, never a light button.

**The token (`WIDGET_FEEDBACK_TOKEN_VALUE`).** The Send button authenticates with the shared `WIDGET_FEEDBACK_TOKEN`, embedded directly in the widget HTML (single-user, behind CF Access — JT-confirmed acceptable for v1). **You do not know the token value inside your container** (it's host-side, never injected here). So emit the literal placeholder string **`WIDGET_FEEDBACK_TOKEN_VALUE`** in the HTML exactly as written above — the host deploy worker substitutes the real token at deploy time. Do not invent, guess, or omit it; emit the placeholder verbatim and the host fills it in.

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

*Updated <CREATED>*

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
- **Do NOT add a "Send to Daystrom" button speculatively.** Add it **only** when the prompt implies a round-trip (see "Send to Daystrom feedback button"); a purely-local widget gets none.
- **Do NOT poll or wait for the deploy.** Your only up-front message is the single `🛠️ Building your widget…` ack from step 6 (always, however JT asked) — then stop.

## Handling widget feedback (inbound — a widget sent you its state)

When a widget's "Send to Daystrom" button fires, its state arrives back to you as an ordinary message in JT's chat, carrying a **feedback envelope**: a human line, the sentinel `===WIDGET-FEEDBACK-ENVELOPE-v1===`, then a fenced ` ```json ` block of `{ widgetId, type, state }`. Example:

```
🪟 Widget feedback — compare-hvac-quotes-2026-06-16

===WIDGET-FEEDBACK-ENVELOPE-v1===
```json
{"widgetId":"compare-hvac-quotes-2026-06-16","type":"conversational","state":{...}}
```
```

When you see that sentinel:

1. **Parse the JSON** in the fenced block — that's the widget's current `state`. Robustness: if the fence is malformed (rare — e.g. the state itself contained a literal ` ``` `), fall back to taking everything from the first `{` to the last `}` after the sentinel and parsing that.
2. **The state may arrive HTML-escaped** — the message pipeline XML-escapes inbound content, so `<`/`>`/`&`/`"` inside string values may appear as `&lt;`/`&gt;`/`&amp;`/`&quot;`. Decode those entities before reasoning about the values. *(v1 limitation, alongside the literal-` ``` ` note above; ad-hoc widgets are mostly numbers/short strings, so this rarely bites.)*
3. **`type: "conversational"`** (the only type this skill sends) → present the state to JT in plain English — what he set, what it implies — and discuss/analyse per the widget's intent (e.g. "you weighted quote B highest on warranty; here's my read…"). This is a **conversation**: nothing is written to the vault, no files change. Just receive, interpret, and reply.
4. Do **not** echo the raw envelope/JSON back to JT, and don't treat it as a `/widget` generation request — it's feedback *from* an existing widget, not a request to build a new one.

*(Standing widgets such as the Projects Board send `type: "write-back"` / `"refresh"` — those are handled by the board's own playbook, not here. This skill only handles the ad-hoc `conversational` flavour.)*
