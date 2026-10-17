import type { DataAccess, DataAccessCall, QueryOptions } from './data-access.js';
import type { OracleBind, OracleCallBind, OracleRow } from './oracle-types.js';

export type FakeCall = DataAccessCall;

export type FakeMatch = (call: FakeCall) => boolean | Promise<boolean>;

export type FakeReplyFn = (call: FakeCall) => FakeReply | Error | Promise<FakeReply | Error>;

export interface FakeReply {
  rows?: OracleRow[];
  rowCount?: number;
  /** Fila de OUT binds que responde un `call` (cursores ya serializados). */
  outRow?: OracleRow;
}

/**
 * Backend fake programable para tests y para los tickets siguientes: se
 * inyecta en `createServer` igual que el pool real, sin tocar la interfaz.
 */
export class FakeDataAccess implements DataAccess {
  readonly calls: FakeCall[] = [];
  closed = false;

  private readonly rules: { match: FakeMatch; reply: FakeReplyFn }[] = [];

  /** Regla: si `match` aplica, responde con `reply` (o lanza el Error que devuelva). */
  on(match: FakeMatch, reply: FakeReplyFn): this {
    this.rules.push({ match, reply });
    return this;
  }

  /** Atajo: responde igual a cualquier llamada. */
  always(reply: FakeReplyFn): this {
    return this.on(() => true, reply);
  }

  /** Atajo: falla siempre, para probar el contrato isError de las tools. */
  alwaysFail(error: Error): this {
    return this.always(() => error);
  }

  private async answer(
    method: FakeCall['method'],
    sql: string,
    binds?: OracleBind[] | OracleCallBind[],
    options?: QueryOptions,
  ): Promise<FakeReply> {
    const call: FakeCall = {
      method,
      sql,
      ...(binds === undefined ? {} : { binds }),
      ...(options === undefined ? {} : { options }),
    };
    this.calls.push(call);

    for (const rule of this.rules) {
      if (!(await rule.match(call))) continue;
      const reply = await rule.reply(call);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return { rows: [] };
  }

  queryForList(sql: string, binds?: OracleBind[], options?: QueryOptions): Promise<OracleRow[]> {
    return this.answer('queryForList', sql, binds, options).then((reply) => reply.rows ?? []);
  }

  async queryForObject(
    sql: string,
    binds?: OracleBind[],
    options?: QueryOptions,
  ): Promise<OracleRow | null> {
    const reply = await this.answer('queryForObject', sql, binds, options);
    return reply.rows?.[0] ?? null;
  }

  async execute(sql: string, binds?: OracleBind[], options?: QueryOptions): Promise<number> {
    return (await this.answer('execute', sql, binds, options)).rowCount ?? 0;
  }

  call(callString: string, binds?: OracleCallBind[]): Promise<OracleRow> {
    return this.answer('call', callString, binds).then((reply) => reply.outRow ?? {});
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
