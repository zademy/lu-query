/**
 * oracledb@26 no publica declaraciones de tipos. La superficie mínima que usa
 * lu-query está declarada a mano en src/db/oracle-types.ts; este archivo solo
 * evita el `any` implícito en el import perezoso.
 */
declare module 'oracledb' {
  const oracledb: unknown;
  export default oracledb;
}
