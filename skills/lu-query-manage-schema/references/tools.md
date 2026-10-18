# Tool reference - DDL

All seven tools resolve the owner themselves: the `schema` argument, then `ORACLE_DB_SCHEMA`, then the session's `CURRENT_SCHEMA`. Verified responses are plain confirmation lines.

## Comments

```
comment_on_table(table, comment, schema?)   -> "Comment applied to table DEVUSER.SKL_DEPT"
comment_on_column(table, column, comment, schema?) -> "Comment applied to column DEVUSER.SKL_EMP.EMAIL"
```

Owner-only in Oracle. Replaces any existing comment.

## View

```
create_or_replace_view(view, selectBody, schema?)
-> "View DEVUSER.SKL_V_EMP created (or replaced)."
```

`selectBody` is the SELECT body only - no `CREATE VIEW` prefix, no trailing `;`. Example body:

```
SELECT e.EMP_ID, e.EMAIL, d.DEPT_NAME FROM SKL_EMP e LEFT JOIN SKL_DEPT d ON d.DEPT_ID = e.DEPT_ID
```

## Synonym

```
create_synonym(synonym, targetSchema, targetName, isPublic?)
-> "Synonym DEVUSER.SKL_EMPLOYEES created."
```

`isPublic` defaults to private. `targetSchema`/`targetName` may name a remote object via a DB link.

## Sequence

```
create_sequence(sequence, startWith?, incrementBy?, cache?, schema?)
-> "Sequence DEVUSER.SKL_SEQ created."
```

Fails if the name exists (ORA-00955). Use `get_sequence_info` to inspect instead of recreating.

## Index

```
create_index(table, columns: string[], index, tableSchema, unique?, schema?)
-> "Index DEVUSER.SKL_EMP_EMAIL_IX created on DEVUSER.SKL_EMP."
```

- `columns`: array, e.g. `["DEPT_ID","SALARY"]` (composite, in order).
- `index`: the new index's name (your choice).
- `tableSchema`: owner of the **table**.
- `unique`: creates a unique index; Oracle rejects it if existing rows violate uniqueness.

## Materialized-view log

```
create_mview_log(table, withPrimaryKey?, withRowid?, includingNewValues?, schema?)
-> "Materialized view log created on DEVUSER.SKL_DEPT."
```

Required before `FAST` refresh of a materialized view over that table.
