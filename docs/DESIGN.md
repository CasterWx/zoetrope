# agentry — Design Document (v1)

**agentry** is a terminal UI that visualizes Claude Code agent sessions as a live flow graph: the main agent, its subagents, workflows, and tool activity — rendered with [ratatui-flow](../../ratatui-flow). Synthesized from a multi-agent research pass over rwy (`/Users/furkan/personal/projects/rwy`), ratatui-flow (`/Users/furkan/personal/projects/ratatui-flow`), and real transcripts under `~/.claude/projects/`. Full research: see the workflow output referenced in the repo history.

## Hard constraints

1. **No network IO, ever.** All IO is local filesystem. No reqwest/hyper/etc. in the dep tree (dev-deps included). "Your transcripts never leave your machine" goes in the README.
2. **Defensive parsing.** The transcript format is undocumented/internal. Unknown entry types, missing fields, malformed lines: skip, never panic. Mirrors Claude Code's own resilience.
3. **rwy's async architecture**, ported: single-task UI loop owns all state; background tokio tasks feed typed messages over bounded mpsc; no `Arc<Mutex>`.
4. ratatui-flow is a **path dep** (`../ratatui-flow`). Its error type is `ratatui_flow::Error` (NOT `FlowError` — that name doesn't exist).

## CLI

```
agentry                      # live mode: watch the latest session for the current cwd
agentry --dir <path>         # live mode for another project's cwd
agentry replay <file.jsonl>  # replay a finished session (paced by timestamps)
agentry replay <f> --speed 8 # speed multiplier (default 8.0)
agentry inspect <file.jsonl> # no TUI: print parsed session tree to stdout (debug/smoke-test)
```

Arg parsing: hand-rolled over `std::env::args` (no clap; keep deps lean).

## Dependencies (Cargo.toml)

```toml
ratatui = "0.30"
ratatui-flow = { path = "../ratatui-flow" }       # default features (sugiyama, crossterm)
crossterm = { version = "0.29", features = ["event-stream"] }  # same ver ratatui 0.30 uses — types must unify
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync", "fs", "io-util"] }
futures = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde", "clock"] }
anyhow = "1"
```

## Module map

```
src/
├── main.rs        # CLI parsing, channel setup, spawn tailer task, run tui
├── tui.rs         # terminal lifecycle + central event loop (rwy tui.rs pattern + tick_animation)
├── handler.rs     # key/mouse routing: app keys → quit/pause/fit, rest → flow; process_flow_events
├── tailer.rs      # background task: live tailing + replay pacing; TailRequest/UiEvent enums
├── transcript.rs  # serde data model for JSONL entries + meta.json + dir discovery/sanitization
├── state/
│   ├── mod.rs     # App: owns Flow<AgentNode, StepEdge> + SessionModel + UI state; handle_ui_event
│   ├── session.rs # SessionModel: pure domain — agents, statuses, tool calls, derived from entries
│   └── graph.rs   # SessionModel → Flow incremental sync + Sugiyama layout on structural change
└── ui/
    ├── mod.rs     # draw(frame, app): splits, Background, flow, MiniMap, detail panel, status bar
    ├── nodes.rs   # AgentNode: NodeContent impl (the agent card)
    └── panel.rs   # detail panel for the selected agent
```

## Transcript format (verified against real data, Claude Code 2.1.153–2.1.165)

### Layout
- Main: `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`. Sanitization: absolute cwd, every `/` → `-` (leading slash → leading dash). Only `<uuid>.jsonl` directly in that dir are transcripts.
- Subagents: `<session-uuid>/subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json`. `agentId` = 17 hex chars (NOT a UUID), also present as a field on every line of its file.
- Workflow subagents: `<session-uuid>/subagents/workflows/<wf-id>/agent-*.jsonl` + `.meta.json` + `journal.jsonl` (ledger of `started`/`result` entries — NOT a transcript; `result` entries carry `agentId` = workflow-subagent completion marker).
- **Ignore**: `vercel-plugin/skill-injections.jsonl` (no `type` field), `memory/`, `sessions-index.json`, `tool-results/` (output overflow spill).

### meta.json
`{agentType: String, description: Option<String>, toolUseId: Option<String>}`. Direct Agent calls have all three; workflow subagents have only `agentType: "workflow-subagent"`.
**Linkage:** `meta.toolUseId` === the `Agent` tool_use block `.id` in the main transcript; `meta.agentType` === `tool_use.input.subagent_type`.

### Entries — `#[serde(tag = "type")]` + `#[serde(other)] Unknown`
- **Transcript entries** (`user`, `assistant`, `system`, `attachment`): envelope has `uuid`, `parentUuid` (null only on the single root — distinguish *present-and-null* from *absent*), `timestamp` (ISO8601 UTC millis, e.g. `2026-06-05T13:51:15.151Z`), `sessionId`, `isSidechain` (false in main, true in subagent files), optional `promptId`, `requestId` (assistant-only). Subagent lines add `agentId` (all lines) and `attributionAgent` (assistant lines only — do NOT rely on it; join on `agentId`).
- **assistant**: `.message = {role, model, content[], stop_reason, usage}`. Content block types: `text {text}`, `thinking {thinking, signature}`, `tool_use {id, name, input, caller?}` (`caller` is newer-schema; Option). `usage.output_tokens` etc. — sub-fields vary by version, all Option/default. `model` e.g. `claude-opus-4-8`.
- **user**: `.message.content` is **string OR array** (untagged enum). Array blocks: `text`, `tool_result {tool_use_id, content, is_error?}` — `content` is **also string-or-array**; `is_error` is `Option<bool>`, **missing means success**. Top-level optional `toolUseResult` (object|string) sibling of `.message`.
- **system**: subtypes via `subtype` field (`turn_duration`, `stop_hook_summary`, `local_command`, …) — keep as a lean variant, mostly ignored.
- **attachment**: `.attachment.type` various — context injections, not graph material.
- **Flat metadata entries** (`ai-title`, `last-prompt`, `mode`, `permission-mode`, `file-history-snapshot`, `queue-operation`): NO uuid/parentUuid/timestamp — must deserialize into lean variants (a struct requiring envelope fields fails). **`ai-title` provides the session title for the header bar.**
- **Ledger entries** (`started {key, agentId}`, `result {key, agentId, result}`): appear in subagent files and journal.jsonl. Excluded from graph; `result` in journal.jsonl marks workflow-subagent completion.
- `summary` type: documented to exist, never observed — handled by Unknown.
- Format is strict JSONL: one JSON object per line, no embedded newlines, no blob lines. Longest observed line 38KB; largest file 2MB/792 lines.

### Tool calls
`tool_use` names observed: Bash, Edit, Read, Write, ToolSearch, AskUserQuestion, Agent, Workflow, TaskStop, WebFetch. `Agent` input: `{description, prompt, subagent_type}`. Pair `tool_use.id` with the later user `tool_result.tool_use_id` → pending (no result yet = in-flight) vs complete (`is_error` decides Failed).

## Domain model (state/session.rs)

```rust
pub struct SessionModel {
    pub session_id: String,
    pub title: Option<String>,           // from ai-title
    pub agents: IndexMap-ish<AgentId, AgentInfo>,  // BTreeMap<String, AgentInfo> + Vec<String> spawn order, or Vec with index map — implementer's choice, but spawn order must be stable
    pub last_activity: Option<DateTime<Utc>>,
}
pub enum AgentId { Main, Sub(String /* agentId */), Workflow(String /* wf-id */) }  // or flat String keys "main", agentId, wf-id
pub struct AgentInfo {
    pub kind: AgentKind,                 // Main | Subagent | WorkflowGroup
    pub agent_type: Option<String>,      // "claude-code-guide", "workflow-subagent", …
    pub description: Option<String>,     // meta.description or Agent tool_use input.description
    pub parent: Option<String>,          // node id of parent (main or wf-id)
    pub spawned_by_tool_use: Option<String>, // toolUseId — completion join key
    pub status: AgentStatus,             // Running | Done | Failed
    pub model: Option<String>,
    pub tool_calls: Vec<ToolCallInfo>,   // {id, name, summary: Option<String>, ts, state: Pending|Ok|Err}
    pub output_tokens: u64,              // summed from usage
    pub first_ts / last_ts: Option<DateTime<Utc>>,
}
```

**Graph topology (v1): nodes are agents, not messages.** One node per agent + one group node per workflow run. Edges: `main → direct subagent` (edge id = toolUseId), `main → workflow node` (edge id = wf-id), `workflow → its subagents`. Sessions have 800+ lines — per-message nodes would be noise; agents are the story.

**Status rules:**
- Direct subagent: `Done`/`Failed` when main transcript contains `tool_result` with `tool_use_id == spawned_by_tool_use` (`is_error` → Failed). Else `Running`.
- Workflow subagent: `Done` when journal.jsonl has a `result` entry with its `agentId`. Workflow node: all-children-done rollup (`Failed` if any child failed, `Done` when all children terminal, else `Running`). NOTE: the Workflow tool_use's `tool_result` in the main transcript is a *launch acknowledgment* ("Workflow launched in background…"), NOT a completion signal — verified against real data; do not complete groups from it.
- Main: live mode — `Running` if main file grew within the last ~3s (tailer emits liveness); replay — `Running` until stream ends.
- Edge `animated = target agent Running`.

## Tailer (tailer.rs)

**Decision: poll-based, no `notify` dep** (no precedent in rwy; poll is simpler, WASM-trait-friendly, and a 200ms interval is imperceptible). Single tailer task manages ALL files of the watched session.

```rust
pub enum TailRequest { Watch(PathBuf), Pause, Resume }   // Watch = switch session (live mode discovers; replay passes file)
pub enum UiEvent {
    Batch { session_id: String, updates: Vec<Update> },  // batched per poll tick
    SessionReset { session_id: String },                 // truncation/rotation detected
    Liveness { session_id: String, main_active: bool },
    ReplayFinished,
    Error(String),
}
pub enum Update {
    Entry { source: Source, entry: transcript::Entry },  // Source::Main | Source::Sub(agentId) | Source::Journal(wfId)
    SubagentMeta { agent_id: String, workflow: Option<String>, meta: transcript::SubagentMeta },
}
```

Per-file tail state: `{ offset: u64, partial: Vec<u8> }`. Each tick: `metadata().len()`; if `len < offset` → reset to 0 + emit `SessionReset`; if grown, read appended bytes, split on `\n`, parse complete lines, buffer the trailing partial. Scan `subagents/` and `subagents/workflows/*/` each tick for new `agent-*.jsonl` / `meta.json` / `journal.jsonl` (cheap readdir; dirs may not exist yet — that's fine). Live mode also re-checks the project dir for a *newer* session file and auto-switches (emit reset first).

**Replay:** parse all files fully, merge updates ordered by timestamp (fallback: per-file line order; entries without timestamps ride along with their predecessor), then emit in wall-clock-paced batches: sleep `min(gap / speed, 2s)` between consecutive timestamps. Pause/Resume via TailRequest in the same select.

**Everything stamped with session_id; App drops events where `!is_current(session_id)`** (stale buffered messages across a switch — rwy's identity-stamping pattern).

## Event loop (tui.rs — rwy's loop + tick_animation)

```
ratatui::init() → execute!(EnableMouseCapture)
spawn crossterm EventStream reader → unbounded mpsc
tick = interval(16ms)
loop {
    now; flow.tick_auto_pan(now - last_tick);      // return value may be ignored (rwy does)
    flow.tick_animation(now - last_tick);          // rwy does NOT have this — agentry MUST (marching ants)
    last_tick = now;
    terminal.draw(|f| ui::draw(f, app))?;          // draw EVERY iteration or animation freezes
    tokio::select! {
        _ = tick.tick() => {}
        Some(ev) = ui_rx.recv() => app.handle_ui_event(ev),
        Some(ev) = event_rx.recv() => if handler::handle_event(&ev, app, &tail_tx) { break },
    }
    while let Ok(ev) = event_rx.try_recv() { if handler::handle_event(&ev, app, &tail_tx) { break } }  // drain → no mouse lag
    while let Ok(ev) = ui_rx.try_recv() { app.handle_ui_event(ev) }
}
execute!(DisableMouseCapture); ratatui::restore()
```
Bounded channels (cap 32) backpressure on `send().await` — tailer batches per tick so this is fine. Panic hook: ratatui::init installs screen restore but NOT mouse-capture disable — add a custom hook layer that also disables mouse capture.

## Graph sync (state/graph.rs — rwy's incremental pattern)

- **Never rebuild.** Per update: `flow.node_content_mut(id)` → mutate in place; else `flow.add_node(...)` + `flow.add_edge(...)`. Treat duplicate-id `Err` as idempotent no-op. Add nodes before their edges.
- Node: `Node::new(id, (0.0, 0.0), (W, H), AgentNode{…})` — fixed dims ~`(30.0, 7.0)` main/workflow, ~`(26.0, 6.0)` subagents (explicit dims; no DOM-style measuring). Handles: `Handle::source(HandlePosition::Bottom).with_hidden(true)`, `Handle::target(HandlePosition::Top).with_hidden(true)` (clean look, rwy does this).
- **Layout:** structural change (node/edge added) sets a dirty flag → at sync end, `flow.apply_layout(Sugiyama::vertical())`. `request_fit_view()` ONLY on first populate (had_no_nodes → has_nodes guard) and on a manual `f` key (via `handle_controls_key_event`). Accepted v1 tradeoff: relayout overwrites manual drags on structural change.
- `flow.set_edge_animated(edge_id, running)` on status change; node card colors react to status via content mutation.
- Flow config: `Flow::new().with_deselect_on_pane_click(false)` + `flow.deselect_on_drag = false` (detail panel persists), `with_min_zoom(0.1)` (Sugiyama trees outgrow default 0.5 fit-view limit).
- Selection survives sync because node ids are stable (`main`, agentId, wf-id) and we never clear()+re-add.

## UI

- **AgentNode card** (ui/nodes.rs): border + title = agent_type (or "claude" for main), status glyph+color (`palette.success`=done green, `palette.error`=failed, accent/spinner-ish for running), description (truncated), `⚒ N tools`, last tool name, output token count. Read `ctx.theme.palette()`, `ctx.selected`. Status glyphs: `●` running (accent), `✓` done (success), `✗` failed (error).
- **Detail panel** (ui/panel.rs): when `flow.selected_nodes().next()` is Some → 65/35 horizontal split; panel shows the selected agent's description, model, status, timing, and a scrollable recent-tool-call list (name + summary, ✓/✗/⏳). Data from SessionModel, keyed by node id. Copy the selected id out before borrowing app mutably elsewhere (borrow-checker note from rwy).
- **Status bar**: session title (ai-title), live/replay indicator, agent & tool counts, pause state, key hints (`q` quit, `f` fit, `space` pause [replay], `tab/arrows` navigate).
- **Companions**: `Background::new(&flow)` then `&mut flow` then `MiniMap::new(&flow)` (render order matters; Widget impl is on `&mut Flow`, companions take `&Flow` — separate render_widget calls avoid borrow conflicts).
- Keys: `q`/`ctrl-c` quit; `space` pause/resume (replay); rest → `flow.handle_controls_key_event` (zoom/fit) then `flow.handle_key_event` (selection nav). Mouse → `flow.handle_mouse_event`. Consume `into_events()`; only `SelectionChanged` matters (read selection during render anyway).

## inspect subcommand

`agentry inspect <file.jsonl>`: parse the session fully (transcript + subagents + journal), print a tree: session title, each agent (type, description, status, #tools, tokens), tool-call tallies. Exit non-zero on unreadable file. **This is the headless smoke test** — CI-runnable end-to-end check of parser + session model with no TTY.

## Testing (inline #[cfg(test)], no tests/ dir)

Worth testing: transcript line parsing against real-format fixture strings (every entry type incl. flat metadata, polymorphic content, missing is_error, Unknown), sanitization rule, partial-line buffering + truncation reset (tailer state machine over an in-memory/tempfile sequence), session model status transitions (spawn → running → done/failed; workflow journal completion), graph sync idempotency (same update twice = no duplicate nodes; selection preserved). Not worth testing: render output, getters.

## Pitfalls checklist (from research — verify before calling done)

- [ ] `ratatui_flow::Error` (no FlowError); `add_edge_from_connection(conn, content)` two args (unused in v1 — read-only graph)
- [ ] Draw every loop iteration; post-select try_recv drains; unbounded crossterm channel
- [ ] `tick_animation` wired (rwy reference loop lacks it)
- [ ] Partial trailing line buffered; `len < offset` → reset + SessionReset
- [ ] `parentUuid` present-and-null (root) vs absent (metadata) — Option handling, lean variants for flat types
- [ ] `is_error` missing = success
- [ ] user content + tool_result content polymorphic string|array
- [ ] Only `<uuid>.jsonl` in project dir + `subagents/**/agent-*.jsonl`; never skill-injections.jsonl/journal as transcript
- [ ] fit-view only on first populate; min_zoom raised
- [ ] No network deps anywhere in the tree
- [ ] First render has zero canvas size — `request_fit_view` (deferred) not `fit_view`
