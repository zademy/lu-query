# Auditoría en Markdown por sesión, sin JSON

El Java auditaba a un log JSON; decidimos eliminar el JSON por completo y escribir UN archivo Markdown por sesión (`lu-query-<ts>-log.md`, format-version `3-md`, flush por entrada) porque el consumidor es la persona que abre el archivo, no una máquina. `MCP_AUDIT_ENABLED` nace en `true`: la auditoría es la característica del producto, no un extra — el costo de I/O por entrada se acepta, y si el disco falla el writer se desactiva con un aviso en stderr en lugar de tumbar el server.

## Consecuencias

- No hay salida estructurada: un consumidor futuro debe leer el formato `3-md` (codec en `src/audit/markdown.ts`).
- El recurso MCP `oracle://audit/session/{id}` sirve el archivo tal cual, truncado al máximo del protocolo.
