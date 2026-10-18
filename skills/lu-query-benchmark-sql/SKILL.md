---
name: lu-query-benchmark-sql
description: Measure a SQL statement before and after a rewrite - real execution stats from DBMS_XPLAN, repeated runs, a result fingerprint that proves the rows did not change, and one HTML report with the bottleneck list and the per-run curves. Use when the user asks why a query is slow, wants to compare two versions, or wants a tuning recommendation with numbers behind it.
compatibility: Needs the lu-query MCP server with a PLAN_TABLE, DBMS_XPLAN, ADVISOR and SELECT ANY DICTIONARY on the user, and Node 18+ on the machine that renders the report. Writes files only inside the folder it creates; it never changes the statement you point it at without asking first.
---

# lu-query-benchmark-sql

Turns "this query is slow" into a number you can defend: run it, run the rewrite,
prove the rows came out the same, and show both on one page.

The point is not the plan. The plan is an estimate. The point is that the
rewrite is faster **and** returns the same thing, measured N times on this
database, with the limits stated on the face of the report.

## When to use

- The user asks why a query is slow and wants evidence, not a guess.
- There are two versions of a query and nobody knows which is faster.
- A tuning recommendation needs the numbers behind it to be accepted.

## When not to use

- Just want the plan of a statement you will not run. That is `explain_plan`.
- Something is locking or hanging right now. That is `lu-query-triage-incident`.
- The query is wrong and returns wrong rows. That is a correctness bug, not a
  tuning job. Fix it first: a benchmark of a wrong query is a benchmark of a bug.

## Workflow

### 1. Ask where the file is. Always.

Ask. Never guess a path, never search the working directory for "something that
looks like a query", never start from a query you found in the conversation.

> Give me the path to the `.sql` file with the query to analyze.

If the user pastes SQL directly instead of giving a path, use it. The rule is that
you wait for the answer.

### 2. Establish what "after" means

Two possibilities, and you need to know which before you start:

- The user has a second file. Ask for its path.
- There is no second version. Then **you** propose the rewrite, and you do not
  write it to disk until the user approves it. Show it in the conversation first.

Never modify the original file. It is the baseline; if it changes, the comparison
means nothing.

### 3. Read the file and settle the details

- If it holds more than one statement, say which ones you found and ask which to
  measure. Measure all of them if the user wants, one report each.
- If it has Oracle binds (`:customer_id`), ask for one concrete value for each.
  A benchmark over a bind you never chose tells you nothing about the plan the
  application will get. Take one representative value and say in the report that
  it is one.
- Save both versions verbatim into the output folder before running anything, so
  the run is reproducible even if the session moves on.

### 4. Create the output folder

```
perf-<slug>-<AAAAMMDD-HHMMSS>/
  01-original.sql
  02-optimizado.sql
  03-reporte.html
  04-mediciones.json
```

`<slug>` is a short name you make from the query. Create it in the agent's working
directory and tell the user where it is.

### 5. Measure the original, ten times

Each repetition is two tool calls, in this order, with nothing in between:

```sql
SELECT /*+ gather_plan_statistics */ <the statement verbatim>;
```

```sql
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));
```

The hint is not optional. With `statistics_level = TYPICAL`, which is the default,
Oracle does not gather the basic row counts and `ALLSTATS LAST` comes back with no
`A-Rows` at all.

`DISPLAY_CURSOR` with `NULL, NULL` reports the last statement in the session, so
these two calls cannot be separated by anything else.

From each repetition record only three numbers, from the root row of the plan:
`A-Time` divided by 1000 for milliseconds, `Buffers`, `Reads`. The root row is
the last one, the one with no letter in its `Id`. Do not sum the other rows: they
count the same work again.

**Keep the full plan text from repetition 1 only.** That is the cold-cache plan
and it is the one worth reading. The other nine give you three numbers each;
pasting ten plans into the conversation is what makes this kind of task fail.

The first 2 repetitions are warmup and are marked as such. Everything is compared
on the **median** of the remaining 8, never the mean: a cold first run drags the
mean and hides the result you are actually trying to show.

Repeat 10 times. If the statement takes more than a few seconds, say so before
starting, because 10 runs of a 30 second query is 5 minutes.

### 6. Fingerprint the result

`run_query` caps at 1000 rows, so comparing rows row by row proves nothing about
the 70,000 the statement returned. Ask the database for a summary instead. See
`references/mediciones.md` for the exact statement and the traps in it (no
`ORDER BY`, `DATE` through `TO_CHAR`, `NULL` given a fixed marker).

Do this for the original before you move on. If you only find out at the end that
the rewrite changed the rows, the whole run is wasted.

### 7. Propose the rewrite and get approval

Read the plan against `references/bottlenecks.md` and work the checklist in the
order that file gives, which starts with statistics and ends with indexes.

Show the rewrite in the conversation with the reason for each change. Wait for
the user to approve it. Only then write `02-optimizado.sql` and measure it.

If a fix would need a new index or a schema change, do not write it. Say it as a
recommendation and mark it in the report as something that was not applied.

### 8. Measure the optimized version the same way

Same 10 repetitions, same 2 warmups, same three numbers, same fingerprint.

Then compare the fingerprints. They must match: same row count and same checksum.
If they do not, the rewrite is wrong, whatever the speed. Say so plainly and stop
there. A faster query that returns a different answer is not an optimization.

### 9. Write the measurements and render

Write `04-mediciones.json` following `references/mediciones.md`, then:

```bash
node scripts/bench-report.mjs <carpeta>
```

It prints the absolute path of `03-reporte.html`. It computes the medians, the
factor and the fingerprint verdict; you do not do arithmetic.

If it exits non-zero, read the message. Do not retry with different values.

### 10. Fill in the findings

The renderer does not invent bottlenecks: it draws what you write in `findings`.
Go through `references/bottlenecks.md` and record only what the plan actually
shows, each with the node that proves it. A finding with no evidence line is a
guess; leave it out.

Strip the two rows `run_query` adds to every plan (`VIEW` and `COUNT STOPKEY`)
before you read anything into them.

### 11. Hand over the path

Give the path to the folder and one sentence on what the numbers came out. Do not
paste the HTML into the conversation. Do not summarize numbers you did not read.

## Reading the results correctly

- **The statement you measured is not the statement in production.** It carries
  the `gather_plan_statistics` hint and travels inside the wrapper `run_query`
  adds. Its `sql_id` and `plan_hash_value` are not the real ones. The report says
  so at the top.
- **One session, no concurrency.** These numbers are for a single session on an
  idle database. A plan that wins here can lose with real load on top.
- **Warm cache.** From repetition 3 on, the buffer cache holds the data, so
  physical reads in the report read lower than what production would see. That is
  exactly why the first 2 repetitions are marked and excluded.
- **A matching fingerprint is not a correct result.** `ORA_HASH` is 32 bits and
  collides. The report says `coincide` or `no coincide` and never `correct`.
- **`ALLSTATS LAST` reports the last statement in the session.** If you measure
  something else between the two calls, you get the wrong plan, silently.
- **10 repetitions is not a benchmark of a fleet.** It is enough to separate a
  10x change from noise. It is not enough to claim a 4% change.

## Safety

- The original `.sql` is never written to. The optimized one is written only after
  the user approves it.
- Nothing here creates an index, changes a schema or runs DDL. Those come out as
  recommendations in the report, not as actions.
- The output folder is the only thing created, and the report goes into it.
- The report embeds the SQL it measured, binds included. It is an internal
  document: do not publish it or commit it without reading it.

## Index recommendations (required before rendering)

For every measured query, review the actual plan predicates and table accesses, existing index columns in order, expressions, uniqueness, status and visibility, table/column statistics and selectivity. Use the existing metadata tools and run_query against ALL_INDEXES, ALL_IND_COLUMNS, ALL_IND_EXPRESSIONS and ALL_CONSTRAINTS when needed. Use suggest_index as a candidate source, not proof. Read references/indexes.md for interpretation and the reporting contract in references/mediciones.md.

Record indexRecommendations in 04-mediciones.json. Explain each finding in the user's language with short sentences and a book-index analogy, followed by the exact evidence in the expandable technical detail. Always state what happens, what to try, its cost, and how to measure success. If metadata or usage history is unavailable, name what is missing. Never label an index bad because a single plan did not use it. Never create, rebuild or drop an index as part of report rendering. Execute a proposed DDL only after explicit approval and measure its effects separately from a SQL rewrite.
