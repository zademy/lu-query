---
name: lu-query-plan-data-changes
description: Use lu-query to change Oracle rows safely - preview the blast radius with execute_dml_preview, rehearse with execute_dml_rollback_first, commit with execute_dml, and pick new keys with find_free_id or get_next_sequence_value. Use for INSERT/UPDATE/DELETE/MERGE where the user approved the change.
compatibility: Requires the lu-query MCP server connected over stdio. Needs write grants on the target tables; find_free_id and get_next_sequence_value resolve the owner themselves (schema argument, then ORACLE_DB_SCHEMA, then the session's CURRENT_SCHEMA).
---

# Plan and apply data changes with lu-query

## When to use

- The user has approved an INSERT, UPDATE, DELETE or MERGE on existing tables.
- You need a new primary key value from a sequence or the next free integer id.

## When not to use

- The change alters structure (DDL) → [lu-query-manage-schema](../lu-query-manage-schema/SKILL.md).
- You are still deciding what to change → [lu-query-audit-data-quality](../lu-query-audit-data-quality/SKILL.md) first.

## The three modes (choose explicitly)

| Tool                         | Executes? | Commits?             | Use for                                            |
| ---------------------------- | --------- | -------------------- | -------------------------------------------------- |
| `execute_dml_preview`        | **no**    | no                   | always first: how many rows, which columns         |
| `execute_dml_rollback_first` | yes       | **no** (rolled back) | rehearsing triggers, FKs and constraint violations |
| `execute_dml`                | yes       | **yes**              | the approved change, once                          |

## Workflow

1. **Preview.** `execute_dml_preview` on the exact statement. It counts the affected rows with a mirror SELECT built from your own SQL, so an alias or a subquery in the predicate is honoured. It returns `detectedKind`, `affectedRowCount` and up to 10 `sampleRows`. If `affectedRowCount` is not what you expect, stop and re-check the predicate.
2. **Rehearse when risky.** `execute_dml_rollback_first` proves the statement passes triggers/FKs/NOT NULL and shows `rowsAffected`, then rolls back. Use it before any bulk UPDATE.
3. **Obtain keys deliberately.** `find_free_id` returns the lowest unused integer in a range (default 1..1000, hard cap 10000) - it does not reserve it. `get_next_sequence_value` **consumes** the next value (gaps are normal).
4. **Apply.** `execute_dml` with the same statement text you previewed. It commits through the chokepoint.
5. **Verify.** Re-run the read (`count_rows`, `run_query`) and quote it. Do not report success from `rowsAffected` alone.
6. **Record.** The session audit Markdown contains the verbatim SQL, `WRITE` type and affected rows; quote that entry as evidence.

## Reading results correctly

- `execute_dml` returns `{statementKind, rowsAffected}`.
- `execute_dml_preview` returns `sampleRows` from the _current_ table state, not from the statement's projection; it does not show the values the statement would write.
- MERGE and exotic syntax may come back as an unknown kind from the parser; the statement still reaches Oracle unchanged. Trust Oracle's error, not the parser's guess.

## Safety

- `execute_dml` is irreversible from the tool's point of view: no undo tool exists. Preview, then apply.
- Sequences and `SYSDATE` are not transactional: rollback does not return sequence numbers.
- Identifiers and literals are validated/escaped by the server, but the statement is still your responsibility.

## Tool reference

| Tool                         | Signature                                                    | Returns                                                                                 |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `execute_dml_preview`        | `sql*`                                                       | `{detectedKind, table, affectedRowCount, sampleColumns, sampleRows, sampleCount, note}` |
| `execute_dml_rollback_first` | `sql*`                                                       | `{detectedKind, rowsAffected, rolledBack: true, note}`                                  |
| `execute_dml`                | `sql*`                                                       | `{statementKind, rowsAffected}`                                                         |
| `find_free_id`               | `table*`, `column*`, `maxRange?`, `excludeTable?`, `schema?` | `{schema, table, column, maxRange, excludeTable, candidateId}`                          |
| `get_next_sequence_value`    | `sequence*`, `schema?`                                       | `{schema, sequence, nextValue}`                                                         |

Details: `references/tools.md`. Verified transcripts: `references/examples.md`.
