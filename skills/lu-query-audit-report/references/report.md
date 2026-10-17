# What the report shows

Seven panels, all rendered from the same aggregate - there is nothing to configure.

## 1. KPIs

| Card                 | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| Sentencias           | Entries in the window, every tool, every kind                              |
| OK / Errores         | Split by the `✅ OK` / `❌ ERROR` marker of each entry                     |
| Tasa de error        | `errores / sentencias` as a percentage                                     |
| Filas devueltas      | Sum of `Filas` where the statement succeeded (`-1` excluded)               |
| Duración media / p95 | Milliseconds per statement, computed over successful and failed runs alike |
| Sesiones · días      | Server processes that contributed, and distinct calendar days              |

The header also states the audit directory, when the file was generated, the timezone and how many
files were read, skipped or partially dropped. Read that line before quoting the numbers: it tells
you whether the report is complete.

## 2. Actividad por día y por hora

Statements and errors per calendar day, and per hour of day. The day is the one the log itself
declares (`2026-10-17T23:59-0600` counts as the 17th), so the grouping never shifts with the
timezone of whoever opens the HTML. A session that runs across midnight shows up on both days.

## 3. Tools más llamadas / más tiempo

Two rankings of the same tools: one by call count, one by total milliseconds. They disagree on
purpose - a cheap tool called 200 times and an expensive one called 3 times look identical in the
first chart and very different in the second.

## 4. Las 10 sentencias más lentas

The ten slowest entries with tool, kind, type, rows and duration, and the full SQL behind a
"ver SQL" toggle. This is where a `SELECT *` over a big table shows up.

## 5. Errores

Grouped by `ORA-xxxxx`, with the count, the tool and one real message as the sample. Errors that
carry no ORA code are grouped as "sin código ORA": those are client-side failures (no connection, bad
parameters) rather than Oracle rejections.

## 6. Efecto sobre los datos (type)

READ / WRITE / OTHER split. If a read-only task shows WRITE, something ran a write: read the
slowest-statements panel before assuming it was harmless.

## 7. Sesiones

One row per server process: session id, start, timezone, statements, errors, total duration and the
file it came from. Use the file name to reopen the raw Markdown when the report is not enough.

## Charts

Tailwind and Chart.js come from a CDN, so the first open needs network. Interaction is Chart.js
native: click a legend entry to hide that series, hover any bar or point for the exact value.
