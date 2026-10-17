# Tool reference - PL/SQL

## describe_plsql

```
describe_plsql(name: string, type?: "PROCEDURE"|"FUNCTION"|"PACKAGE"|..., schema?: string)
-> {"schema":"DEVUSER","name":"SKL_ADD_EMP","type":"PROCEDURE",
    "arguments":[{"ARGUMENT_NAME":"P_EMAIL","DATA_TYPE":"VARCHAR2","IN_OUT":"IN","POSITION":1,"DEFAULTED":"N"},
                 {"ARGUMENT_NAME":"O_EMP_ID","DATA_TYPE":"NUMBER","IN_OUT":"OUT","POSITION":4,"DEFAULTED":"N"}],
    "source":"PROCEDURE SKL_ADD_EMP (\n  p_email IN VARCHAR2, …"}
```

Functions also list the implicit return as an `OUT` argument with `ARGUMENT_NAME: null` and `DATA_TYPE: "REF CURSOR"` at `POSITION 0`.

## call_procedure

```
call_procedure(name: string, args: string, isFunction?: boolean, returnType?: string, schema?: string)
-> {"outParams":{"O_EMP_ID":1000},"returnValue":null,"cursorResult":null}
```

- `args`: JSON string of `[{"name","direction","dataType","value"}]`, in parameter order.
- `direction`: `IN` (default), `OUT`, `INOUT`.
- `dataType`: `VARCHAR2`, `NUMBER`, `DATE`, `TIMESTAMP`, `REF CURSOR`, ... A value is needed for `IN`; `OUT`/`INOUT` take no `value`.
- `isFunction`: call as `:1 := f(...)` instead of `p(...)`.
- `returnType`: needed for cursor-returning functions (`"REF CURSOR"`).
- Commits on success.
- More than one cursor: the first becomes `cursorResult`; extras land in `outParams`.

## get_plsql_errors

```
get_plsql_errors(name?: string, type?: string, schema?: string)
-> []                      # valid
```

When invalid, rows carry Oracle's `LINE`, `POSITION`, `TEXT` and `ERROR` for each compile error.

## Resource

```
oracle://schema/{schema}/plsql/{object}   -> PL/SQL source (procedure, function, package, type body)
```
