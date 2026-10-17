# Seguridad

## Reportar una vulnerabilidad

Abre un **GitHub Security Advisory privado** en este repo (Security → Report a vulnerability). No abras un issue público con detalles explotables.

## Secretos

- Las credenciales llegan solo por variables de entorno (`ORACLE_DB_USERNAME`/`ORACLE_DB_PASSWORD`, `SENTRY_DSN`); nunca se escriben a disco ni a logs.
- `SENTRY_SEND_DEFAULT_PII` es `false` por defecto: no se envía PII con los errores reportados.

## Superficie de ataque

- **stdio only**: el server no abre puertos; solo habla por stdin/stdout con el cliente MCP que lo lanzó.
- **Identificadores**: todo nombre de objeto pasa por una allow-list (`^[A-Za-z][A-Za-z0-9_$#]{0,127}$`); los literales se escapan (`'` → `''`).
- **Barrera de mínimos privilegios**: `run_query` solo acepta SELECT; DML y DDL pasan por tools dedicadas. La primera línea de defensa es que el usuario de BD tenga solo los permisos que quieras permitir — el server no es un firewall.

## Directorio de auditoría

Los archivos de auditoría (`MCP_AUDIT_DIR`, default `./mcp-audit-logs`) contienen el SQL verbatim ejecutado, incluidos sus literales: pueden capturar datos sensibles que una consulta haya filtrado en línea. Protege el directorio con permisos de disco restrictivos y exclúyelo de backups o copias compartidas.
