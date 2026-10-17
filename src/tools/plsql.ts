import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withToolContext } from '../audit/context.js';
import { resolveSchemaFor } from '../catalog/schema.js';
import { MAX_ROWS } from '../config.js';
import type { DataAccess } from '../db/data-access.js';
import type { OracleBind, OracleCallBind } from '../db/oracle-types.js';
import { SecurityError, guardTool } from '../errors.js';
import { assertIdentifier } from '../security/identifiers.js';
import type { ServerContext } from '../server.js';

/**
 * Plsql — describe_plsql, call_procedure y el recurso plsql-source
 * (`PlsqlTools`/`PlsqlService`/`PlsqlCallExecutor` del Java).
 *
 * El Java usa `{ call … }` de JDBC con registro de OUT y cursor; aquí el
 * bloque PL/SQL equivalente lleva binds nativos de salida y el chokepoint
 * serializa `outBinds` (los cursores se fetchean a filas) y commitea, como
 * el auto-commit del Java. call_procedure enruta: (a) procedimiento solo-IN
 * por `execute` (commitea igual), (b) función o cualquier OUT/INOUT/REF
 * CURSOR por `call` con binds de salida.
 */

/** Resultado de call_procedure (`PlsqlCallResult` del Java, mismo orden). */
export interface PlsqlCallResult {
  outParams: Record<string, unknown>;
  returnValue: unknown;
  cursorResult: unknown;
}

/** `PlsqlService.describe` del Java: argumentos + source del diccionario. */
export async function describePlsql(
  dataAccess: DataAccess,
  schema: string,
  name: string,
  type: string | undefined,
): Promise<{
  schema: string;
  name: string;
  type: string | null;
  arguments: unknown[];
  source: string;
}> {
  const arguments_ = await dataAccess.queryForList(
    `SELECT argument_name, data_type, in_out, position, defaulted
FROM all_arguments
WHERE owner = :1 AND object_name = :2
ORDER BY position`,
    [schema, name],
    { maxRows: MAX_ROWS },
  );

  // El texto de ALL_SOURCE ya trae el salto de línea: join vacío como en el Java.
  const lines = await dataAccess.queryForList(
    `SELECT line, text
FROM all_source
WHERE owner = :1 AND name = :2 AND (:3 IS NULL OR type = :3)
ORDER BY line`,
    [schema, name, type ?? null, type ?? null],
    { maxRows: MAX_ROWS },
  );
  const source = lines.map((row) => (typeof row.TEXT === 'string' ? row.TEXT : '')).join('');

  return { schema, name, type: type ?? null, arguments: arguments_, source };
}

/** Un argumento del array JSON que recibe call_procedure (`PlsqlCallArg`). */
interface CallArg {
  name?: string;
  direction?: string;
  dataType?: string;
  value?: unknown;
}

/** Dirección normalizada: IN por defecto, `IN OUT` se pliega a INOUT (Java). */
function direction(arg: CallArg): 'IN' | 'OUT' | 'INOUT' {
  const dir = arg.direction?.trim().toUpperCase() ?? 'IN';
  return dir === 'OUT' || dir === 'INOUT' || dir === 'IN OUT'
    ? dir === 'OUT'
      ? 'OUT'
      : 'INOUT'
    : 'IN';
}

/** El tipo Oracle como texto; lo que no es string (o falta) se trata como vacío. */
function typeText(oracleType: unknown): string {
  return typeof oracleType === 'string' ? oracleType : '';
}

/** Tipo de driver para binds OUT/INOUT (`PlsqlCallExecutor.jdbcType`): NUMBER/DATE tipados, resto string como el Java. */
function bindTypeOf(oracleType: unknown): 'NUMBER' | 'DATE' | undefined {
  const t = typeText(oracleType).trim().toUpperCase();
  if (
    [
      'NUMBER',
      'NUMERIC',
      'DECIMAL',
      'INTEGER',
      'INT',
      'SMALLINT',
      'FLOAT',
      'BINARY_FLOAT',
      'BINARY_DOUBLE',
      'BINARY_INTEGER',
      'PLS_INTEGER',
      'NATURAL',
      'POSITIVE',
    ].includes(t)
  ) {
    return 'NUMBER';
  }
  if (t === 'DATE' || t.startsWith('TIMESTAMP')) return 'DATE';
  return undefined;
}

function isCursorType(oracleType: unknown): boolean {
  const t = typeText(oracleType).trim().toUpperCase();
  return t === 'REF CURSOR' || t === 'CURSOR';
}

/**
 * Rechaza los tipos compuestos que JDBC no puede bindear, con la guía del Java
 * (`PlsqlService.requireSupportedType`).
 */
function requireSupportedType(oracleType: unknown, label: string): void {
  const t = typeText(oracleType).trim().toUpperCase();
  if (t === '' || isCursorType(t)) return;
  const composite =
    t === 'BOOLEAN' ||
    t === 'RECORD' ||
    t === 'TABLE' ||
    t === 'VARRAY' ||
    t === 'OBJECT' ||
    t.startsWith('PL/SQL') ||
    t.startsWith('TABLE OF') ||
    (t.startsWith('REF ') && !isCursorType(t));
  if (composite) {
    throw new SecurityError(
      `PL/SQL ${label} of type '${typeText(oracleType)}' is not bindable via JDBC on Oracle 19c. ` +
        'Create a wrapper subprogram that exposes scalar SQL types instead ' +
        '(for example a NUMBER-to-BOOLEAN wrapper: ' +
        'PROCEDURE wrap(n NUMBER) IS BEGIN proc(n <> 0); END;).',
    );
  }
}


/** Valor IN bindeable; los contenedores JSON no lo son. */
function toBind(value: unknown, label: string): OracleBind {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new SecurityError(`valor no bindable para ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `"S"."P"` o `"S"."PKG"."PROC"`: cada parte validada (`parseQualifiedName`). */
function qualified(schema: string, name: string): string {
  const parts = name.split('.').map((part) => assertIdentifier(part, 'nombre'));
  return [`"${assertIdentifier(schema, 'schema')}"`, ...parts.map((part) => `"${part}"`)].join('.');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `:${i + 1}`).join(', ');
}

/**
 * `PlsqlService.call` + `PlsqlCallExecutor` del Java, sobre el chokepoint TS.
 * Ver el comentario del módulo para el porqué de cada ruta.
 */
export async function callProcedure(
  dataAccess: DataAccess,
  schema: string,
  name: string,
  argsJson: string,
  isFunction: boolean,
  returnType: string | undefined,
): Promise<PlsqlCallResult> {
  let parsed: CallArg[];
  try {
    const value: unknown = JSON.parse(argsJson);
    if (!Array.isArray(value)) throw new Error('expected a JSON array of arguments');
    parsed = value as CallArg[];
  } catch (error) {
    throw new SecurityError(`Invalid args JSON: ${(error as Error).message}`);
  }

  if (isFunction && returnType !== undefined && returnType.trim() !== '') {
    requireSupportedType(returnType, 'return type');
  }
  for (const arg of parsed) requireSupportedType(arg.dataType, `argument '${arg.name ?? ''}'`);


  const qualifiedName = qualified(schema, name);
  const ins = parsed.filter((arg) => direction(arg) !== 'OUT');
  const outs = parsed.filter((arg) => direction(arg) !== 'IN');
  const inBinds = ins.map((arg, i) => toBind(arg.value, `'${arg.name ?? `arg${i + 1}`}'`));

  // (a) Procedimiento sin OUT: bloque con binds IN. `execute` commitea como el
  // auto-commit del Java (execute_dml/call_procedure auto-commitean).
  if (outs.length === 0 && !isFunction) {
    await dataAccess.execute(
      `BEGIN ${qualifiedName}(${placeholders(parsed.length)}); END;`,
      inBinds,
    );
    return { outParams: {}, returnValue: null, cursorResult: null };
  }

  // (b) Función o cualquier OUT/INOUT (incluido REF CURSOR): bloque con binds
  // nativos de salida, como el callable de JDBC del Java. El driver llena
  // `outBinds`, y el chokepoint lo serializa (cursores a filas) y commitea.
  const offset = isFunction ? 2 : 1;
  const argsPlace = Array.from({ length: parsed.length }, (_, i) => `:${i + offset}`).join(', ');
  const callString = isFunction
    ? `:1 := ${qualifiedName}(${argsPlace})`
    : `${qualifiedName}(${argsPlace})`;
  const outBind = (arg: CallArg): OracleCallBind => {
    if (isCursorType(arg.dataType)) return { dir: 'OUT', type: 'CURSOR' };
    const type = bindTypeOf(arg.dataType);
    // Solo llegan OUT/INOUT: los IN se rutean a toBind en la construccion de binds.
    const dir: 'OUT' | 'INOUT' = direction(arg) === 'INOUT' ? 'INOUT' : 'OUT';
    // Sin type el driver devuelve el OUT como string; NUMBER/DATE se tipan como en JDBC.
    const spec: { val?: OracleBind; dir: 'OUT' | 'INOUT'; type?: 'NUMBER' | 'DATE' | 'CURSOR' } = { dir };
    if (type !== undefined) spec.type = type;
    if (dir === 'INOUT') spec.val = toBind(arg.value, `'${arg.name ?? 'arg'}'`);
    return spec;
  };
  const retType = bindTypeOf(returnType);
  const retBind: OracleCallBind = {
    dir: 'OUT',
    ...(isCursorType(returnType) ? { type: 'CURSOR' as const } : retType ? { type: retType } : {}),
  };
  const emptyBinds: OracleCallBind[] = [];
  const binds: OracleCallBind[] = (isFunction ? [retBind] : emptyBinds).concat(
    parsed.map((arg) =>
      direction(arg) === 'IN' ? toBind(arg.value, `'${arg.name ?? 'arg'}'`) : outBind(arg),
    ),
  );

  const out = await dataAccess.call(callString, binds);
  const outParams: Record<string, unknown> = {};
  let cursorResult: unknown = null;
  let cursorTaken = false;
  // Los outBinds posicionales traen SOLO los binds de salida, en orden: el
  // retorno primero (si es función) y luego los OUT/INOUT de los argumentos.
  let outIndex = isFunction ? 2 : 1;
  parsed.forEach((arg) => {
    if (direction(arg) === 'IN') return;
    const value = out[String(outIndex)];
    outIndex += 1;
    if (isCursorType(arg.dataType)) {
      // El primer cursor del call viaja en cursorResult (contrato del Java).
      if (!cursorTaken) {
        cursorResult = value;
        cursorTaken = true;
      } else {
        outParams[arg.name ?? 'arg'] = value;
      }
    } else {
      outParams[arg.name ?? 'arg'] = value;
    }
  });
  let returnValue: unknown = null;
  if (isFunction) {
    const ret = out['1'] ?? null;
    if (isCursorType(returnType)) cursorResult = ret;
    else returnValue = ret;
  }
  return { outParams, returnValue, cursorResult };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plain(
  uri: string,
  text: string,
): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

const PLSQL_URI = 'oracle://schema/{schema}/plsql/{object}';

/** Registro de las dos tools y del recurso (`PlsqlTools`/`OracleResources`). */
export function registerPlsql(ctx: ServerContext): void {
  const { dataAccess } = ctx;

  ctx.server.registerTool(
    'describe_plsql',
    {
      description:
        'Describe a PL/SQL object: returns its arguments (name, data type, in/out, position) and full source code. Read-only.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the object. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        name: z.string().describe('Object name (procedure, function or package).'),
        type: z
          .string()
          .describe("Object type, e.g. 'PROCEDURE', 'FUNCTION', 'PACKAGE' or 'PACKAGE BODY'.")
          .optional(),
      },
    },
    async (args) =>
      withToolContext('describe_plsql', args, () =>
        guardTool(async () => {
          const schema = await resolveSchemaFor(ctx, args.schema, 'describe_plsql');
          const described = await describePlsql(dataAccess, schema, args.name, args.type);
          return { content: [{ type: 'text' as const, text: JSON.stringify(described) }] };
        }),
      ),
  );

  ctx.server.registerTool(
    'call_procedure',
    {
      description:
        'Execute a PL/SQL procedure, function or package subprogram with typed arguments. Supports IN/OUT/INOUT scalar parameters and function return values via typed binds (SYS_REFCURSOR OUT/return arguments are fetched and returned as row arrays). Pass args as a JSON array: [{"name":"P","direction":"IN","dataType":"NUMBER","value":1}]. PL/SQL BOOLEAN/RECORD/TABLE/VARRAY/OBJECT types are rejected with guidance to create a scalar wrapper. Requires GRANT EXECUTE on the target object. Auto-commits like execute_dml.',
      inputSchema: {
        schema: z
          .string()
          .describe(
            "Schema (owner) of the object. Optional — defaults to the server's current schema; omit rather than guess.",
          )
          .optional(),
        name: z
          .string()
          .describe('Object name; optionally qualified as PKG.PROC for a package subprogram.'),
        args: z
          .string()
          .describe(
            'Arguments as a JSON array: [{"name":"P","direction":"IN|OUT|INOUT","dataType":"NUMBER","value":1}].',
          ),
        isFunction: z
          .boolean()
          .describe(
            'Set true if the object is a function (registers a return slot and populates returnValue).',
          )
          .optional(),
        returnType: z
          .string()
          .describe(
            'Oracle return type for functions (e.g. NUMBER, VARCHAR2, REF CURSOR). Ignored for procedures.',
          )
          .optional(),
      },
    },
    async (args) =>
      withToolContext('call_procedure', args, () =>
        guardTool(async () => {
          const schema = await resolveSchemaFor(ctx, args.schema, 'call_procedure');
          const result = await callProcedure(
            dataAccess,
            schema,
            args.name,
            args.args,
            args.isFunction ?? false,
            args.returnType,
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }),
      ),
  );

  ctx.server.registerResource(
    'plsql-source',
    // Sin `list`: como en el Java, este recurso se resuelve por URI, no se enumera.
    new ResourceTemplate(PLSQL_URI, { list: undefined }),
    {
      title: 'Fuente PL/SQL',
      description: 'PL/SQL source code (procedure, function, package, package body, type body)',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const schema = assertIdentifier(String(variables.schema), 'schema');
      const object = assertIdentifier(String(variables.object), 'objeto');
      try {
        const described = await describePlsql(dataAccess, schema, object, undefined);
        if (described.source.trim() === '') {
          return plain(
            uri.href,
            `(No PL/SQL source found for ${schema}.${object} — the object may not exist or is not a PL/SQL object.)`,
          );
        }
        return plain(uri.href, `-- ${schema}.${object}\n\n${described.source}`);
      } catch (error) {
        return plain(
          uri.href,
          `(Database error reading PL/SQL source for ${schema}.${object}: ${message(error)})`,
        );
      }
    },
  );
}
