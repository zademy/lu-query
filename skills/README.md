# lu-query skills for AI agents

Optional, copyable skill folders that teach an AI agent how to use the **lu-query** MCP server well: which tool to reach for, in what order, what mutates, how failures are reported, and how to produce evidence.

They are documentation, not code: `lu-query` itself never installs them, so nothing changes for existing users.

## Install (optional)

With the [`skills`](https://www.npmjs.com/package/skills) CLI - it discovers every skill in this repo and puts it where your agent looks:

```bash
npx skills@latest add zademy/lu-query                        # all eight skills
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
| [lu-query-triage-incident](lu-query-triage-incident/SKILL.md)       | "Is the DB healthy? Who blocks whom?"                       | 13 performance + health + session                        |

## Rules that apply to every skill

1. **Least privilege is the real barrier.** `lu-query` validates identifier shape, escapes literals and caps rows; it does **not** authorize. Oracle grants decide. Never treat a skill step as a security control.
2. **Confirm before mutating.** `execute_dml` and `call_procedure` commit. `execute_dml_rollback_first` _executes_ and then rolls back. `get_next_sequence_value` advances the sequence. `EXPLAIN PLAN` writes to `PLAN_TABLE`.
3. **Errors are values, not exceptions.** A failing call returns `isError` text with an ORA hint. Read the hint before retrying; blind retries re-run the statement.
4. **Object-scoped tools need a schema.** Verified on 2026-10-17: `describe_table`, `count_rows`, `find_duplicates`, `get_table_stats`, `get_histogram` and every DDL tool fail fast with "needs a schema" unless you pass `schema` or the server has `ORACLE_DB_SCHEMA` set. Browsing tools (`list_tables`, `search_objects`, `run_query`, `explain_plan`) resolve the session schema on their own.
5. **Read the live contract.** Call `tools/list` for current schemas; these files document intent, precedence and verified behaviour.
6. **Evidence.** Every tool call is written to the session audit Markdown (on by default). Read it back with `oracle://audit/session/current` and quote the entry you relied on.

## Provenance

Every example in `references/examples.md` was executed against the fixtures below on **Oracle Database 26ai Free (23.26.0.0.0)**, lu-query **2.13.0**, MCP over stdio, 2026-10-17. Outputs are quoted verbatim and trimmed. Calls that were _not_ executed are marked `not executed`.

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
