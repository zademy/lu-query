---
name: lu-query-audit-report
description: Turn the lu-query audit trail into a single interactive HTML report - KPIs, per-day and per-hour activity, slowest statements, ORA error groups, READ/WRITE split, per-session table. Use when asked what was executed against the database over a period, for an audit or an activity report, or to review what an agent did in a session.
compatibility: Needs Node 18+ on the machine that runs the report and the audit Markdown files already on disk (MCP_AUDIT_DIR). Reads files only - no database connection. The HTML pulls Tailwind and Chart.js from a CDN, so opening it needs network.
---

# Audit report from the lu-query trail

The MCP server writes one Markdown file per **session** - one per server process - with one entry
per statement it ran. This skill reads those files and renders a report. It never connects to the
database.

## When to use

- "What did we run against the DB last week?", "show me the activity from 01/10 to 17/10"
- An audit trail to hand to someone else.
- Before a retrospective: which statements were slow, which failed, which wrote.

## When not to use

- You want to ask the **live** database something -> [lu-query-query-data](../lu-query-query-data/SKILL.md).
- You want to investigate a specific failure now -> [lu-query-triage-incident](../lu-query-triage-incident/SKILL.md).
- There are no audit files (audit disabled): the server needs audit enabled and an MCP_AUDIT_DIR,
  otherwise there is nothing to report on.

## Workflow

1. **Get the directory.** Ask where the lu-query audit Markdown files live. Check first:
   - the MCP config's MCP_AUDIT_DIR for lu-query (if you can read it),
   - ./mcp-audit-logs inside a lu-query clone.
     Never guess silently: an existing directory with no audit files means audit was off.
2. **Get the window.** Ask for two dates in dd/mm/yyyy, **maximum one month**. If the user says
   "last week" or "October", resolve it to concrete dates and state them back before running.
3. **Run the parser.** Never parse the Markdown yourself - it is deterministic work, and you would
   spend the whole context on regex:

   ```bash
   node scripts/audit-report.mjs <auditDir> <dd/mm/yyyy> <dd/mm/yyyy>
   ```

   It prints the absolute path of the HTML it wrote to <auditDir>/reports/. Exit code 1 plus a
   message on stderr means it refused: do not retry with different values, read
   references/troubleshooting.md and fix the cause.

4. **Hand over the path.** Give the user the path and one sentence about what it covers. Do not
   paste the HTML into the conversation and do not summarize numbers you did not read.
5. **Regenerating the same window** overwrites the same file, so a second run is always a fresh
   render of the same data, not a second copy.

## Reading results correctly

- **One entry per statement, not per query.** run_query is just one of the tools in the report;
  writes, DDL and PL/SQL appear too. The type split (READ/WRITE/OTHER) is the honest summary of what
  the session did to the data.
- **Filas: -1** marks a failed statement. Those rows are excluded from "filas devueltas" and
  counted as errors instead.
- **A session is a server process**, not a person and not a conversation. Two clients started at the
  same moment produce two files; one client reconnecting produces several.
- **Duration is server-side**, per statement: it includes Oracle round-trips but not the time the
  agent spent thinking. The p95 is computed over statements that ran, not over sessions.
- **The trail does not say who ran it.** There is no user, host or client in the format, so never
  attribute statements to a person from this report.
- **The SQL is verbatim.** In writes that means real literals (emails, ids, occasionally
  credentials). The HTML carries a warning about it; keep it out of repositories and out of shared
  storage.

Panel by panel: references/report.md. Every failure mode: references/troubleshooting.md.

## Safety

Read-only on disk: the script only reads audit files and writes one HTML file under
<auditDir>/reports/. It never touches the database, never installs anything and never runs
npm install. The generated HTML is a document, not a viewer: it runs no query.
