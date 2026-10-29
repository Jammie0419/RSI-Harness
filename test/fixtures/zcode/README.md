# ZCode session store fixtures

There are no committed fixtures for this source: the store is a binary SQLite
database, so `test/session-sources.test.ts` builds reduced stores with
`node:sqlite` at test time. They contain no personal session history.

The compatibility contract is record-based, not a claim that every ZCode
release is supported. The schema is ZCode's private, migration-driven surface
(see its `schema_migration` table) and may change without notice:

- `session.directory` holds the session's working directory; `task_type`
  (`interactive` / `subagent_child`), `parent_id` and `time_deleted` separate
  machine-generated and deleted sessions; `time_created` / `time_updated` are
  epoch milliseconds.
- `message.data` is a JSON document; `$.role` is `user` or `assistant`. ZCode
  defines five `$.semantics.origin` values — `real_user`, `agent_runtime`,
  `system`, `migration`, `import` (checked against the app's bundled code) —
  and only `real_user` is typed input. Even then, wrappers flagged with
  `synthetic`, hidden `uiVisibility`/`transcriptVisibility`/`visibility`, or a
  compact summary (`kind: "compact_summary"`, a `summary` field) are
  provider-only content and are excluded, mirroring ZCode's own realUserInput
  projection. An origin outside the five is reported as `unknown_user_source`.
- The prompt text lives in `part` rows of `type: "text"` (`$.text`), joined to
  their message by `message_id`; assistant tool calls are `type: "tool"` rows
  with `tool` and `state.input` / `state.output`. Compact summaries also appear
  as `type: "compaction"` parts (`auto`, optional `summaryMessageId`) and are
  never user evidence.

The reader opens the store read-only (`PRAGMA query_only` as a second belt),
forces the page-1 header read so a non-SQLite file is rejected as
`unreadable`, and probes the schema before querying: a store it cannot
recognise is `unsupported_format`, one it cannot open is `unreadable` — never
empty history. Subagent and deleted sessions are counted as `filtered`. A
user-role origin outside the known pair (`real_user`, `agent_runtime`) is
reported as `unknown_user_source`, and malformed rows are counted under
`malformed_json` without dropping the readable prompts.

The scanner does not read ZCode's rollout dumps (`~/.zcode/cli/rollout`),
`input_history`, usage tables, or any other store sidecars.
