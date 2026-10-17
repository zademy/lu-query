# When the parser refuses

Every failure exits with code 1 and one line on stderr. None of them is fixed by retrying.

| Message                                                           | Cause                                         | Fix                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `uso: node audit-report.mjs <auditDir> <dd/mm/aaaa> <dd/mm/aaaa>` | Fewer than three arguments                    | Pass all three; there are no optional flags                                                                                                  |
| `no existe el directorio X`                                       | Wrong path                                    | Ask the user where the `lu-query-*-log.md` files are. If `MCP_AUDIT_DIR` appears in the message, that is what the server was configured with |
| `desde no es una fecha dd/mm/aaaa`                                | Wrong date format                             | Two digits, slash, two digits, slash, four digits. `2026-10-01` is rejected on purpose                                                       |
| `desde no existe en el calendario`                                | `31/02/2026`, `00/13/2026`                    | Ask for a real date                                                                                                                          |
| `hasta (X) es anterior a desde (Y)`                               | Swapped arguments                             | Swap them                                                                                                                                    |
| `la ventana cubre N días y el máximo es 31`                       | Window too wide                               | Split into chunks of at most one month                                                                                                       |
| `no hay sesiones del X al Y`                                      | No audit file in the window                   | The message lists the three closest files: the user asked for a period the server was not running, or the directory is the wrong one         |
| `... no tiene archivos de auditoría de sesión`                    | Directory exists but holds no `-log.md`       | Audit is disabled: the server needs `audit=enabled` and an `MCP_AUDIT_DIR`. There is nothing to recover                                      |
| `ningún archivo de la ventana se pudo leer (...)`                 | Every file has an unreadable `format-version` | This skill reads `format-version 3-md`. An older trail (`1-json`, `2-md`) or a newer server needs a skill update, not a different command    |

## Failures the parser does NOT refuse

| Situation                                                      | What the report does                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| One file has an unknown `format-version`                       | Skips it, shows an amber banner with the file and the version it found, and counts it in "ilegibles"                            |
| A file was truncated mid-entry (process killed while flushing) | Drops that entry, keeps the rest, reports it as an "entrada incompleta descartada"                                              |
| The window produced no statements at all                       | Refuses - a report with nothing in it is a mistake, not a result                                                                |
| Tailwind or Chart.js cannot be downloaded                      | The HTML still opens, unstyled and without charts. The numbers are in the tables only if they rendered; regenerate with network |

## Requirements

- **Node 18+.** Nothing else: no Python, no npm install, no build. If `node` is missing the
  command itself fails with "command not found"; install it from nodejs.org or with `brew install node`.
- **Network on first open** for the two CDN scripts. Making the report offline-proof would mean
  vendoring Tailwind and Chart.js into the package: out of scope on purpose.
