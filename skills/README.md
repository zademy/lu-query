# lu-query skills for AI agents

Optional, copyable skill folders that teach an AI agent how to use the **lu-query** MCP server well: which tool to reach for, in what order, what mutates, how failures are reported, and how to produce evidence.

They are documentation, not code: `lu-query` itself never installs them, so nothing changes for existing users. Two of them carry a dependency-free Node script: [lu-query-audit-report](lu-query-audit-report/SKILL.md) renders the audit trail as an HTML report, and [lu-query-benchmark-sql](lu-query-benchmark-sql/SKILL.md) renders a before/after benchmark of a query. Both run only when an agent asks, and neither needs a build step.

## Install (optional)

With the [`skills`](https://www.npmjs.com/package/skills) CLI - it discovers every skill in this repo and puts it where your agent looks:

```bash
npx skills@latest add zademy/lu-query                        # all ten skills
npx skills@latest add zademy/lu-query --list                 # show them without installing
npx skills@latest add zademy/lu-query -s lu-query-use-plsql # just one
npx skills@latest add zademy/lu-query -g -a opencode        # global, for OpenCode
```

By hand, if you prefer no CLI (each folder is self-contained):

```bash
cp -r skills/lu-query-* ~/.claude/skills/    # or .claude/skills/ per project
```

| Agent                           | Skills directory                         |
| ------------------------------- | ---------------------------------------- |
| Claude Code                     | `~/.claude/skills/` or `.claude/skills/` |
| OpenCode                        | `~/.config/opencode/skill/`              |
| Cline / Codex / Cursor / Gemini | `.agents/skills/` or `~/.agents/skills/` |

Already installed `lu-query` from npm? The same folders ship inside the package (`node_modules/lu-query/skills/`).

Nothing else is required: the skills reference the MCP server by tool name, so they work with any MCP client (Claude Desktop, OpenCode, Zed, …) as long as `lu-query` is configured with `ORACLE_DB_URL`, `ORACLE_DB_USERNAME` and `ORACLE_DB_PASSWORD`.

## Catalog

| Skill                                                               | Use it for                                                  | Primary tools                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| [lu-query-explore-schema](lu-query-explore-schema/SKILL.md)         | Unknown database: find objects, columns, keys, dependencies | 8 metadata + 21 catalog + graphs                         |
| [lu-query-query-data](lu-query-query-data/SKILL.md)                 | Answer a data question with a read-only SELECT              | `run_query`, `get_sample_data`                           |
| [lu-query-audit-data-quality](lu-query-audit-data-quality/SKILL.md) | Duplicates, orphan rows, exact counts                       | `find_duplicates`, `validate_fk_integrity`, `count_rows` |
| [lu-query-plan-data-changes](lu-query-plan-data-changes/SKILL.md)   | INSERT/UPDATE/DELETE/MERGE with impact preview              | 3 DML + `find_free_id`, `get_next_sequence_value`        |
| [lu-query-manage-schema](lu-query-manage-schema/SKILL.md)           | Comments, views, synonyms, sequences, indexes, mview logs   | 7 DDL tools                                              |
| [lu-query-use-plsql](lu-query-use-plsql/SKILL.md)                   | Read and call procedures/functions, OUT params, cursors     | `describe_plsql`, `call_procedure`, `get_plsql_errors`   |
| [lu-query-tune-sql](lu-query-tune-sql/SKILL.md)                     | Slow SQL: plan, statistics, index and advisor advice        | 4 explain/tuning + 3 stats                               |
| [lu-query-benchmark-sql](lu-query-benchmark-sql/SKILL.md)           | Prove a rewrite is faster **and** returns the same rows     | `explain_plan`, `run_query`, HTML report                 |
| [lu-query-triage-incident](lu-query-triage-incident/SKILL.md)       | "Is the DB healthy? Who blocks whom?"                       | 13 performance + health + session                        |
| [lu-query-audit-report](lu-query-audit-report/SKILL.md)             | "What was executed over a period?" interactive HTML report  | reads the audit Markdown, no MCP tool                    |

## Built-in prompts

The server also publishes nine MCP prompts: a prepared brief an agent can fetch instead of writing the request itself. `prompts/list` returns them with their arguments, `prompts/get` renders one.

| Prompt                     | Use it for                                                    | Related skill                 |
| -------------------------- | ------------------------------------------------------------- | ----------------------------- |
| `review-sql-performance`   | review a slow statement before changing it                    | `lu-query-tune-sql`           |
| `explain-schema`           | understand an unfamiliar schema                               | `lu-query-explore-schema`     |
| `debug-invalid-plsql`      | compile errors of a procedure or package                      | `lu-query-use-plsql`          |
| `safe-dml-plan`            | a write plan that never executes the DML                      | `lu-query-plan-data-changes`  |
| `data-quality-audit`       | duplicates, orphans and exact counts                          | `lu-query-audit-data-quality` |
| `triage-database-incident` | "is the database healthy, who blocks whom"                    | `lu-query-triage-incident`    |
| `prepare-plsql-call`       | a non-executing PL/SQL call plan                              | `lu-query-use-plsql`          |
| `operating-rules`          | the server's own calling discipline and safety limits         | every skill                   |
| `oracle-sql-style`         | canonical Oracle SQL style: identifiers, literals, pagination | every skill                   |

`operating-rules` and `oracle-sql-style` have no skill of their own on purpose: fetch them before writing SQL by hand.

## Rules that apply to every skill

1. **Least privilege is the real barrier.** `lu-query` validates identifier shape, escapes literals and caps rows; it does **not** authorize. Oracle grants decide. Never treat a skill step as a security control.
2. **Confirm before mutating.** `execute_dml` and `call_procedure` commit. `execute_dml_rollback_first` _executes_ and then rolls back. `get_next_sequence_value` advances the sequence. `EXPLAIN PLAN` writes to `PLAN_TABLE`.
3. **Errors are values, not exceptions.** A failing call returns `isError` text with an ORA hint. Read the hint before retrying; blind retries re-run the statement.
4. **Schema resolution is automatic.** Every object-scoped tool resolves the owner in this order: the `schema` argument of the call, then `ORACLE_DB_SCHEMA`, then the session's own `CURRENT_SCHEMA` (`SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`). Pass `schema` only to target an owner other than the one you are connected as. (Re-verified 2026-10-18 on 2.16.3: before that the session fallback was broken and these tools failed with "needs a schema".)
5. **Read the live contract.** Call `tools/list` for current schemas; these files document intent, precedence and verified behaviour.
6. **Evidence.** Every tool call is written to the session audit Markdown (on by default). Read it back with `oracle://audit/session/current` and quote the entry you relied on. The audit resource is a _template_: `resources/list` does not list it, only `resources/templates/list` does. Its `{id}` is the session timestamp and `current` is the live session; `test_connection` reports the session schema cheaply.

## Provenance

Every example in `references/examples.md` was executed against the fixtures below on **Oracle Database 26ai Free (23.26.3.0.0)**, MCP over stdio, lu-query **2.16.3**, 2026-10-18. The first full transcript run was on 2.13.0 (2026-10-17); since then every tool these examples use has been re-executed against 2.16.3, and the published tool schemas are byte-identical between both versions, so the transcripts below are current. Outputs are quoted verbatim and trimmed. Calls that were _not_ executed are marked `not executed`.

What changed in 2.16.x, and was re-checked on 2026-10-18:

- object-scoped tools now resolve the session schema when there is no `schema` argument and no `ORACLE_DB_SCHEMA` (before: they failed with "needs a schema");
- every read tool is capped at 1000 rows (before, some silently stopped at the driver's 100);
- `CLOB`/`NCLOB` columns come back as the full text, `BLOB` as a JSON buffer, `JSON` columns as the parsed object and `XMLTYPE` as XML text (before: those calls failed);
- `execute_dml_preview` counts rows with a mirror SELECT built from your own SQL, so an alias or a subquery in the predicate works (before: Oracle rejected the mirror).

Fixture (created by the maintainer, safe to recreate):

```sql
CREATE TABLE SKL_DEPT (DEPT_ID NUMBER(4) PRIMARY KEY, DEPT_NAME VARCHAR2(40) NOT NULL, BUDGET NUMBER(12,2));
CREATE TABLE SKL_EMP (EMP_ID NUMBER(6) PRIMARY KEY, DEPT_ID NUMBER(4), EMAIL VARCHAR2(120), HIRE_DATE DATE NOT NULL, SALARY NUMBER(10,2) NOT NULL);
-- 5 rows: duplicate EMAIL 'ada@example.com', one DEPT_ID=99 that does not exist, one NULL DEPT_ID
ALTER TABLE SKL_EMP ADD CONSTRAINT SKL_EMP_DEPT_FK FOREIGN KEY (DEPT_ID) REFERENCES SKL_DEPT(DEPT_ID) ENABLE NOVALIDATE;
CREATE SEQUENCE SKL_SEQ START WITH 1000 INCREMENT BY 1 CACHE 20;
-- SKL_ADD_EMP(p_email IN VARCHAR2, p_salary IN NUMBER, p_hire_date IN DATE, o_emp_id OUT NUMBER)
-- SKL_DEPT_EMPS(p_dept_id IN NUMBER) RETURN SYS_REFCURSOR
```

Cleanup:

```sql
DROP TABLE SKL_EMP CASCADE CONSTRAINTS PURGE;
DROP TABLE SKL_DEPT CASCADE CONSTRAINTS PURGE;
DROP SEQUENCE SKL_SEQ;
DROP PROCEDURE SKL_ADD_EMP;
DROP FUNCTION SKL_DEPT_EMPS;
```

### SQL benchmark: reading index advice

The [benchmark skill](lu-query-benchmark-sql/SKILL.md) includes index recommendations alongside the animated comparison and interactive table metrics. Each finding explains the problem in plain language, the proposed change, maintenance/storage costs, supporting plan/catalog evidence, and how to test it. States distinguish an untested candidate, a query rewrite, an index to review and a measured change. No recommendation runs DDL. Missing metadata is reported as missing; one unused-index observation is insufficient to recommend deletion. See [the index review guide](lu-query-benchmark-sql/references/indexes.md).
