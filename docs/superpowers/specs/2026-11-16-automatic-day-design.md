# Automatic day: discovery of OpenCode and Codex history (2026-11-16)

Scope: this records only the **shape** of the on-disk history of OpenCode and Codex on this PC (file names, table and column names, key names and value types, row counts and newest timestamps). No prompt text, titles or paths were read or are recorded here. It exists so the readers can be written against the real formats, and so the test fixtures can be built synthetically from the same shapes.

Both formats are internal to those tools and can change. The readers must parse defensively (skip unknown records, never throw) and report "format not recognised" when files exist but nothing matches.

## Runtime fact: `node:sqlite` works inside Electron

Electron 39.8.10 bundles Node 22.22.1, and `require('node:sqlite')` works there (`DatabaseSync`, `StatementSync`, `backup`, `constants`; it prints an ExperimentalWarning). The dev machine's Node 24 has it too. So an OpenCode reader can open the database read-only in the server, in the Electron server process, and in vitest, with no new dependency.

## OpenCode

Location: `~/.local/share/opencode/opencode.db` (SQLite, about 550 MB, with a `-wal` file of about 35 MB; it can be open in OpenCode at the same time). It opens read-only without trouble.

It holds **two generations** of the conversation tables, and a reader has to handle both:

| | Sessions | Messages | Index useful for a one-day query |
|---|---|---|---|
| v1 | `session` (`id`, `directory`, `title`, `time_created`, `time_updated`, `project_id`, ...) | `message` (`id`, `session_id`, `time_created`, `data` JSON) and `part` (`id`, `message_id`, `session_id`, `time_created`, `data` JSON) | `message(session_id, time_created, id)`, `part(message_id, id)` |
| v2 | `session_v2` (same columns plus `time_busy`, `time_idle`, ...) | `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `data` JSON) and `session_part` (not used in the data seen) | `session_message(time_created)` |

- Timestamps are milliseconds since the epoch.
- **The folder of a session** is `session.directory` or `session_v2.directory` (set on every recent session). In v1, assistant messages also carry `data.path.cwd` and `data.path.root`.
- **v2 user prompt:** a `session_message` row with `type = 'user'`; `data` has the shape `{agents, files, text, time:{created}}`. Other `type` values seen: `assistant`, `idle` (`{outcome, time}`), `synthetic`, `agent-switched`, `compaction`, `system`. Only `user` rows are prompts; `synthetic` rows are tool or job notices.
- **v1 user prompt:** a `message` row whose `data.role = 'user'` (shape `{agent, model, role, summary:{diffs}, time:{created}}`), with its text in `part` rows where `data.type = 'text'` (`{text, time, type}`). The other part types are `reasoning`, `tool`, `step-start` and `step-finish`.
- **Query cost** (measured here): a count by time on `session_message` took 2 ms (indexed), on `message` 23 ms, and on `part` about 1,090 ms because there is no time index on it. The reader therefore selects the day's user messages first, and fetches `part` rows only by `message_id` (indexed). It never scans `part` by time.
- **Never read** the tables `account`, `control_account`, `credential`, `kv` or `session_share`: they hold tokens and secrets. The reader uses an allowlist of tables and columns, and the code must make it impossible to query anything else.
- **Recency:** the newest v1 session is from 2026-09-24 and the newest v2 session from 2026-11-01. Nothing was written today, so the format could not be checked against a fresh record. The database file itself changes today because of WAL maintenance, so the file's modified time must not be used to decide whether there was activity.

## Codex

Location: `~/.codex`. Two places hold history:

- **Rollout files:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. One line per record: `{timestamp (ISO string), ordinal, type, payload}`, and some lines have a top-level `metadata`. The date folders make a one-day read cheap: open only that day's folder (and the neighbouring day for the time zone edge).
- **Thread index:** `~/.codex/state_5.sqlite`, table `threads` (`id`, `rollout_path`, `cwd`, `title`, `first_user_message`, `preview`, `created_at_ms`, `updated_at_ms`, `source`, `archived`, `git_branch`, `git_origin_url`, ...). It has thread-level data only (one prompt, one folder), so the JSONL is the better source of every prompt. The other databases (`logs_2`, `goals_1`, `queue_1`, `memories_1`) are not needed.

Record kinds seen in the one rollout file (counts in brackets):

- `session_meta` (1): `payload` carries the working folder as `cwd`. `turn_context` (4): `payload.cwd`, `payload.timezone`, `payload.current_date`.
- **Prompts:** `response_item` with `payload.type = 'message'` and `payload.role = 'user'` (11), `content` is an array of `{type, text}`. Some of those are injected context, not typed prompts (instructions, environment). The reader skips texts that start with `<` and the instructions header, the same way the Claude reader skips them.
- Also present, not needed: `response_item` (`assistant` messages, `reasoning`, `function_call`, `function_call_output`, `developer` messages), `event_msg` (`item_completed`, `token_count`, `task_started`, `task_complete`, `turn_aborted`, `thread_settings_applied`), `token_usage_record` and `world_state`.
- `event_msg` / `item_completed` with `payload.item.client_id` marks an item sent from the client; it is a second place a typed prompt appears, and is only a fallback.

Recency: the thread index has **one thread ever** (source `vscode`, 2026-10-12), and one rollout file from the same day. Codex has barely been used here, so only one real session was available to learn the shape from.

## What the readers will do

- **OpenCode:** open the database read-only, list sessions updated that day (both generations), take user prompt rows for the day through the time indexes, and map each to the session's `directory`. Item ids: `opencode:<sessionId>:<messageId>`; the session title becomes `opencode:<sessionId>:title`. Each query runs under a timeout, and a locked or missing database gives a plain note.
- **Codex:** read the day's rollout files line by line (streamed, mtime-filtered like the Claude reader), take the folder from `session_meta` or `turn_context`, and prompts from `response_item` user messages. Item ids: `codex:<sessionId>:<ordinal>`.
- Both go through `redactSecrets` and `clip`. Folders are mapped to projects by the shared `place(cwd)` step.

## Still open

- Fresh records from both tools (today's format) have not been seen. Running one short prompt in each tool in a scratch repository would confirm the shapes above; until then the readers are tested on synthetic fixtures built from this document.
