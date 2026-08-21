# Diablo — Discord Copilot Agent Bridge

Control **GitHub Copilot** from Discord, with every dangerous action gated behind
a human approval, projects kept isolated from each other, and durable project
knowledge shared across sessions.

The Bridge implements no reasoning of its own. Copilot is the engine; this is the
orchestration, safety and interaction layer around it.

> 繁體中文操作說明：[README.zh-TW.md](./README.zh-TW.md)

---

## How it talks to Copilot

The Copilot CLI can run as an **Agent Client Protocol** server (`copilot --acp`),
speaking JSON-RPC over stdio. That is the integration point, and it was verified
against **GitHub Copilot CLI 1.0.80** rather than assumed:

| Capability | Mechanism |
|---|---|
| Start a session | `session/new {cwd, mcpServers}` → `sessionId` |
| Send a prompt | `session/prompt` → resolves with `stopReason` |
| Receive output | `session/update` notifications (13 variants, streamed) |
| See tool/action requests | `tool_call` updates with `kind`, `rawInput`, `locations` |
| **Intercept approval** | **`session/request_permission` — an agent→client request that blocks Copilot until answered** |
| Answer approval | `{outcome:{outcome:"selected", optionId}}` or `{outcome:"cancelled"}` |
| Resume | `session/load` (agent advertises `loadSession: true`) |
| Terminate | `session/close`, plus `session/cancel` to interrupt a turn |

The last three rows are why this design is safe rather than merely careful.
`session/request_permission` is a *blocking request*: Copilot cannot proceed
until the Bridge replies. The promise returned by `ApprovalManager` is therefore
the thing physically holding Copilot still, and the only ways it resolves are an
explicit human decision, an explicit project policy, or an explicit cancel.

**The Bridge never passes `--allow-all-tools`, `--allow-all` or `--yolo`.** Those
flags stop Copilot issuing permission requests at all, which would silently
defeat the entire safety model. This is not configurable — see
`buildCopilotArgs` in `src/copilot/acp-session.ts`.

---

## Architecture

```
Discord ──┐
CLI ──────┼──► IInteractionProvider ──► Agent Core ──► copilot --acp ──► Git project
future ───┘                             │
                                        ├── ProjectManager     (isolation boundary)
                                        ├── SessionManager     (thread = session)
                                        ├── CopilotProcessMgr  (one process per session)
                                        ├── ApprovalManager    (the safety gate)
                                        ├── MemoryManager      (project knowledge)
                                        └── EventBus           (internal events)
```

`src/core/` imports nothing from `src/discord/`. Deleting the Discord directory
would leave the Bridge compiling and working through the CLI provider — that is
what makes "the Agent Core must not depend on Discord" checkable rather than
aspirational.

| Boundary | Meaning |
|---|---|
| Project | Isolation boundary. One Git repo, one working directory, its own memory and policy. |
| Discord thread | One independent agent session, resolved by `discord_thread_id` — users never type a session id. |
| Project memory | Durable knowledge, shared by every session in the project, invisible to other projects. |
| Approval | The security boundary. Every dangerous action passes through it. |

---

## Requirements

- **Node.js ≥ 22.14** (uses the built-in `node:sqlite`)
- **GitHub Copilot CLI**, logged in — check with `copilot --version` and `copilot login`
- A Discord bot, if you want Discord (optional)

## Setup

```bash
npm install
cp config/config.example.yaml config/config.yaml
cp .env.example .env          # then put your bot token in it
npm run build
```

Edit `config/config.yaml` to point at your projects. Then:

```bash
npm start                     # Discord
npm run cli                   # terminal only, no bot token needed
node dist/main.js --project=backend --cli
```

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>, add a bot.
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents. Without
   it the bot receives empty messages.
3. Invite it with scopes `bot` + `applications.commands`, and permissions:
   View Channels, Send Messages, Send Messages in Threads, **Create Public Threads**,
   Embed Links, Attach Files, Read Message History.
4. Turn on Developer Mode in Discord, right-click your channel → Copy Channel ID,
   and put that in `discord.channel_id`.

### Usage

Post in a mapped channel and the bot opens a thread for the task. Keep talking in
that thread and you stay in the same session, with its context intact. Approvals
appear as buttons in the thread.

| Command | Effect |
|---|---|
| `/status` | Project, session, state, current action, pending approvals |
| `/cancel` | Stop Copilot and cancel this session |
| `/reset` | Retire the session; the next message starts fresh. Memory is kept |
| `/project` | Show the project mapped to this channel |
| `/memory [list\|add\|remove\|search]` | Inspect and manage project memory |
| `/approve` / `/reject` | Same as the buttons, for when buttons are awkward |

---

## Safety model

**Authorization fails closed.** A project with `discord_enabled: true` and neither
`security.allowed_users` nor `security.allowed_roles` set will *refuse to start*.
Defaulting to "everyone may approve" would mean there is no security boundary,
which is worse than refusing. Authorization is re-checked on every message,
button press and slash command — a rendered button is not permission to press it.

**No interaction provider is not consent.** If Discord is down when Copilot asks
for permission, the request is recorded, the session parks in
`WaitingForApproval`, a loud error is logged, and *nothing is approved*. Work
resumes when someone approves the parked request.

**Expiry never approves.** After `approval.timeout_ms` (default 30 minutes) a
request becomes `Expired` and the embed says so — but Copilot stays blocked and
the buttons stay live, so a late click still counts. Only `/cancel` unblocks it.

**Risk is classified, because ACP does not.** Copilot sends `git status` and
`git push --force` through the identical permission request. The Bridge
classifies them itself (`src/approval/risk.ts`) so destructive operations get a
red, explicit prompt naming *why* they are dangerous. A project's
`security.deny_patterns` blocks matching commands outright, without asking.

**One approval funnel.** The Bridge declares `fs.readTextFile`,
`fs.writeTextFile` and `terminal` as **false** during the ACP handshake.
Advertising them would let Copilot read, write and execute via `fs/*` and
`terminal/*`, which do **not** go through `session/request_permission` — a second
path around the gate. Declining them keeps every dangerous action inside
Copilot's own tools, where a permission request is guaranteed.

**`allow_always` is off by default.** ACP offers it, but choosing it makes
Copilot stop asking about matching actions entirely — creating an approval path
the Bridge can neither display nor audit. Enable `security.allow_always` per
project only if you accept that.

---

## Project memory

Memory belongs to a **project**, not a thread, and is stored in SQLite. It is
injected as a preamble ahead of the first prompt of each Copilot session. The
Bridge deliberately **never writes into your repository** — silently editing
`AGENTS.md` in a working tree it does not own would be a surprise nobody asked
for.

Copilot has no way to say "I want to remember this", so the Bridge gives it one:
an in-process **MCP server over localhost HTTP** exposing a
`remember_project_fact` tool. When Copilot calls it, the Bridge asks you for
approval and reports the outcome back as the tool result.

The security property that makes this sound: the bearer token *is* the session
identity. A token minted for a session in project A can only ever write to
project A's memory, so cross-project isolation is enforced by the transport
rather than by a check someone might forget to write. The server binds to
`127.0.0.1` on an ephemeral port and rejects unauthenticated requests.

---

## Testing

```bash
npm test           # 100 tests, no Copilot login and no AI credits needed
npm run typecheck
```

Tests run against a **scripted fake ACP agent** (`test/fake-acp-agent.mjs`) that
speaks raw newline-delimited JSON-RPC — so the client is exercised against the
real wire format, not against another copy of the SDK. It can emit tool calls,
issue blocking permission requests, and crash on command.

`test/mvp.test.ts` walks the exact 25-step scenario in §45 of the spec, with test
names citing step numbers. `test/safety.test.ts` covers the rules the spec marks
mandatory (§26, §41) plus scope enforcement (§25) and failure reporting (§39).

To verify against the **real** Copilot CLI (spends credits):

```bash
npm run build && node scripts/smoke-copilot.mjs .
```

---

## Known limitations and deliberate deviations

1. **Sessions stay `Running` between turns.** §11 makes `Completed` terminal, but
   §13 requires a follow-up message in a thread to reach the same session with its
   context. Those cannot both hold, so turn completion is reported via
   `notifyCompletion` while the session record stays live; `Completed` is reached
   by `/reset`, `Cancelled` by `/cancel`, `Failed` by an error. `/status`
   distinguishes them with "current action", matching §31's own display format.

2. **MCP over ACP is unavailable.** Copilot 1.0.80 advertises
   `mcpCapabilities: {http: true, sse: true}` — no `acp`. The memory tool
   therefore uses localhost HTTP rather than the ACP transport.

3. **Memory preamble is per Copilot session, not per turn.** Later turns rely on
   Copilot still holding it in context. A `/compact` inside Copilot could evict
   it; the Bridge does not currently detect that.

4. **A memory request that nobody answers resolves as "not saved"** rather than
   blocking forever. Declining to store a note is safe; wedging Copilot mid-task
   over one is not. Action approvals do block — that asymmetry is intentional.

5. **One Copilot process per session** (§15). This costs memory, so
   `sessions.max_concurrent_per_project` caps it and idle processes are reaped.
   Exceeding the cap is reported to the user, not queued silently.

6. **Phase 6 (Git integration) is not built as a module.** Most of §27 is already
   covered: Copilot's own git commands arrive as permission requests, and the risk
   classifier escalates the destructive ones. What is genuinely absent is
   Bridge-driven PR creation and branch management. Phase 7 is untouched.

7. **`node:sqlite` is experimental** in Node 22 and prints a warning on startup.
   Silence it with `node --no-warnings=ExperimentalWarning dist/main.js`.

8. **Nothing survives a restart.** Copilot processes are children of the Bridge,
   so sessions still marked active at startup are marked `Failed` rather than
   left looking alive. ACP `session/load` support exists in the client but is not
   yet wired into automatic resume.

---

## Layout

```
src/
├── config/       YAML loading, ${ENV} interpolation, fail-closed validation
├── core/         orchestrator, projects, sessions, events, commands, reporter
├── copilot/      ACP client, process manager, event parser, argv builder
├── approval/     approval manager, risk classification, models
├── memory/       memory manager, MCP server
├── interaction/  IInteractionProvider, registry, CLI provider
├── discord/      bot, provider, formatting, authorization
├── storage/      node:sqlite migrations and repositories
└── main.ts       wiring and shutdown
test/
├── fake-acp-agent.mjs   scripted stand-in for `copilot --acp`
├── harness.ts           whole-stack test rig
├── mvp.test.ts          the §45 acceptance scenario
└── safety.test.ts       §25, §26, §39, §41
```
