# NanoClaw — daystrom fork

Customized fork of NanoClaw (branch `custom/daystrom`) running JT's assistant **Daystrom** on a VPS. Upstream docs describe a generic multi-channel install; this file describes what is actually here. Where the two disagree, this file wins.

## Quick Context

Single Node.js process. Messages route to the Claude Agent SDK running in Docker containers; each group gets an isolated filesystem and memory.

**Two channels exist and both are live:** `telegram` (grammy) and `web` — the native **Bridge** web channel (`src/channels/web.ts`, ~3160 lines, authored per D-91). Bridge also serves `/widget/*` (Projects Board v2) and reverse-proxies `/dash/*` to claude-usage and Open WebUI. `src/channels/index.ts` lists WhatsApp, Slack, Discord, and Gmail as commented placeholders — **no files, no imports, not available.**

Groups: `daystrom` (main, elevated), `global`, `worf`.

## Key Files

| File                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation            |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)                |
| `src/channels/telegram.ts` | Telegram channel                                               |
| `src/channels/web.ts`      | **Bridge** web channel + `/widget/*` + `/dash/*` proxy         |
| `src/credential-proxy.ts`  | Header-rewriting Anthropic credential proxy (see Secrets)      |
| `src/env.ts`               | `readEnvFile()` — reads `.env` without touching `process.env`  |
| `src/ipc.ts`               | IPC watcher and task processing                                |
| `src/router.ts`            | Message formatting and outbound routing                        |
| `src/config.ts`            | Trigger pattern, paths, intervals, proxy port                  |
| `src/container-runner.ts`  | Spawns agent containers with mounts                            |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                           |
| `src/db.ts`                | SQLite operations                                              |
| `src/widget/board-v2/`     | Projects Board v2 data plane (parser, tokenize, snapshot)      |
| `groups/{name}/CLAUDE.md`  | Per-group memory (isolated)                                    |
| `container/skills/`        | Skills loaded inside agent containers (24 dirs)                |

## Secrets / Credentials / Proxy

Container Anthropic auth flows through the fork's own **native credential proxy**, `src/credential-proxy.ts` — `startCredentialProxy(port, host)`, listening on `CREDENTIAL_PROXY_PORT` (default **3001**).

Containers receive `ANTHROPIC_BASE_URL` pointed at the proxy plus a **literal placeholder token** (`ANTHROPIC_API_KEY=placeholder` in api-key mode, `CLAUDE_CODE_OAUTH_TOKEN=placeholder` in OAuth mode — `container-runner.ts`). Real credentials never enter a container. The proxy reads them host-side and rewrites headers before forwarding: api-key mode re-injects `x-api-key`; OAuth mode swaps the placeholder `Authorization: Bearer` for the real token on the CLI's key-exchange request. It also strips hop-by-hop headers, caps bodies at 4 MB, and rejects `web_search_*` tool use with 403 (D-90).

**`readEnvFile()` (`src/env.ts`) deliberately does NOT populate `process.env`** — it returns only the requested keys, so secrets don't leak into child processes. Code that needs a `.env` value must call it explicitly; reading `process.env` will come back empty. (Parent repo: `learnings/env-file-not-process-env.md`.)

nanoclaw's own secrets live in `.env` at the project root. Sibling host services on the VPS use service-scoped `/etc/<svc>/secrets.env` (root:root, `600`) wired via a systemd drop-in `EnvironmentFile=`; nanoclaw's unit has no `EnvironmentFile` directive.

## Skills

`.claude/skills/` holds the upstream install/customize skills (`/setup`, `/customize`, `/debug`, `/update-nanoclaw`, plus many `add-*` channel skills that are **not** installed here) and two that matter for this fork:

| Skill                           | When to Use                                              |
| ------------------------------- | -------------------------------------------------------- |
| `/debug`                        | Container issues, logs, troubleshooting                  |
| `/update-nanoclaw`              | Bring upstream updates into this customized install      |
| `/use-native-credential-proxy`  | The credential path this fork actually runs              |

`container/skills/` (24 dirs) is where Daystrom's real capability lives — heavily vault/wiki/board oriented: `wiki`, `wiki-lint`, `wiki-query`, `wiki-scan`, `research`, `remind`, `qmd`, `moc-refresh`, `weekly-review`, `nightly-report`, `board-synth-v2`, `widget`, `obsidian-bases`, `obsidian-markdown`, `import-chat`, `agent-browser`, `security-audit`, and others.

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # tsx src/index.ts (runs from source; NOT hot reload)
npm run build        # tsc
npm test             # vitest run
./container/build.sh # Rebuild agent container
```

**Service management on the VPS:** `nanoclaw.service` is a **SYSTEM unit**.

```bash
sudo systemctl restart nanoclaw
```

Upstream docs (and `setup/service.ts` when installing as non-root) say `systemctl --user restart nanoclaw`. **That is wrong for this box** — documented trap, parent repo `deploy/VPS-FACTS.md`.

**Deploy:** see the parent repo's `AGENTS.md` §Commands — push `custom/daystrom` → VPS `git pull --ff-only` → `rm -rf dist && npm run build` → clear sessions → `sudo systemctl restart nanoclaw`. Skill/`CLAUDE.md`-only changes are zero-restart (they sync per agent spawn) but **still need the session clear**, since agents resume long-lived sessions from the DB.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
