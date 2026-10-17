import { describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';

/** Los prompts del `OraclePrompts` del Java, con el mismo nombre. */
const PROMPT_NAMES = [
  'data-quality-audit',
  'debug-invalid-plsql',
  'explain-schema',
  'operating-rules',
  'oracle-sql-style',
  'prepare-plsql-call',
  'review-sql-performance',
  'safe-dml-plan',
  'triage-database-incident',
];

/** El SDK tipa el mensaje como unión de bloques; estos prompts devuelven texto. */
interface PromptResult {
  description?: string;
  messages: { role: string; content: { type: string; text: string } }[];
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  config?: Record<string, unknown>,
): Promise<void> {
  const harness = await createHarness({ config });
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

/** Texto del prompt ya renderizado, como lo vería el usuario del MCP. */
async function render(
  harness: Harness,
  name: string,
  args: Record<string, string> = {},
): Promise<string> {
  const result = (await harness.client.getPrompt({ name, arguments: args })) as PromptResult;
  expect(result.messages[0]?.role).toBe('user');
  expect(result.messages[0]?.content.type).toBe('text');
  return result.messages[0]?.content.text ?? '';
}

describe('prompts/list', () => {
  it('publica los nueve prompts del Java con sus argumentos', async () => {
    await withHarness(async (harness) => {
      const { prompts } = await harness.client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(PROMPT_NAMES);

      const explainSchema = prompts.find((prompt) => prompt.name === 'explain-schema');
      expect(explainSchema?.description).toBe(
        'Explore an Oracle schema or table with bounded metadata calls and statistics-first sizing.',
      );
      expect(explainSchema?.arguments).toEqual([
        { name: 'schema', description: expect.any(String), required: false },
        { name: 'table', description: expect.any(String), required: false },
        { name: 'detail_level', description: expect.any(String), required: false },
        { name: 'max_objects', description: expect.any(String), required: false },
      ]);
      const review = prompts.find((prompt) => prompt.name === 'review-sql-performance');
      expect(review?.arguments).toContainEqual({
        name: 'sql',
        description: 'SQL statement to review (required, maximum 64,000 characters)',
        required: true,
      });
    });
  });
});

describe('prompts/get', () => {
  it('review-sql-performance renderiza el SQL fenced y los valores por defecto', async () => {
    await withHarness(async (harness) => {
      const text = await render(harness, 'review-sql-performance', {
        sql: 'SELECT * FROM employees',
      });

      expect(text).toContain('## SQL Input');
      expect(text).toContain('```sql\nSELECT * FROM employees\n```');
      expect(text).toContain('- Schema: (not provided)');
      expect(text).toContain('- Bind/selectivity context: (not provided)');
      expect(text).toContain('- SQL Tuning Advisor mode: off');
      expect(text).toContain('## Agent Execution and Data Handling Contract');
    });
  });

  it('explain-schema resuelve el schema del servidor y elige el workflow de tabla', async () => {
    await withHarness(
      async (harness) => {
        const text = await render(harness, 'explain-schema', { table: 'EMPLOYEES' });

        expect(text).toContain('- Schema: HR (resolved by the server');
        expect(text).toContain('- Table: EMPLOYEES');
        expect(text).toContain('- Detail level: quick');
        expect(text).toContain('- Object limit: 20');
        expect(text).toContain('Call `describe_table`, `list_constraints`');
      },
      { schema: 'HR' },
    );
  });

  it('explain-schema sin tabla usa el workflow de schema con su límite de objetos', async () => {
    await withHarness(async (harness) => {
      const text = await render(harness, 'explain-schema', {
        schema: 'sales',
        detail_level: 'full',
        max_objects: '5',
      });

      expect(text).toContain('- Schema: sales (resolved by the server');
      expect(text).toContain('- Table: (not provided)');
      expect(text).toContain('- Detail level: full');
      expect(text).toContain('- Object limit: 5');
      expect(text).toContain('Call `list_tables` for schema `sales`. Analyze at most 5');
    });
  });

  it('debug-invalid-plsql con objeto evita el barrido de schema', async () => {
    await withHarness(
      async (harness) => {
        const text = await render(harness, 'debug-invalid-plsql', { object: 'PKG_UTIL' });

        expect(text).toContain('- Schema: HR (resolved by the server');
        expect(text).toContain('- Object: PKG_UTIL');
        expect(text).toContain('- Type: (not provided)');
        expect(text).toContain('Do not run a schema-wide invalid-object scan.');
        expect(text).toContain('Call `get_plsql_errors` for `HR.PKG_UTIL`');
      },
      { schema: 'HR' },
    );
  });

  it('safe-dml-plan renderiza el modo de dry run y el SQL fenced', async () => {
    await withHarness(async (harness) => {
      const text = await render(harness, 'safe-dml-plan', {
        sql: 'DELETE FROM employees',
        transactional_dry_run: 'accepted-risk',
      });

      expect(text).toContain('- Transactional dry-run mode: accepted-risk');
      expect(text).toContain('```sql\nDELETE FROM employees\n```');
      expect(text).toContain('## DML Input');
    });
  });

  it('data-quality-audit sustituye modo, umbral y claves de negocio', async () => {
    await withHarness(
      async (harness) => {
        const text = await render(harness, 'data-quality-audit', {
          table: 'EMPLOYEES',
          mode: 'full',
          null_threshold: '25',
          business_keys: 'EMAIL',
        });

        expect(text).toContain('Audit `HR.EMPLOYEES`');
        expect(text).toContain('- Mode: full');
        expect(text).toContain('- Null warning threshold: 25%');
        expect(text).toContain('- Business keys: EMAIL');
        expect(text).toContain('- Sensitive columns: (not provided)');
      },
      { schema: 'HR' },
    );
  });

  it('triage-database-incident y prepare-plsql-call montan sus datos de entrada', async () => {
    await withHarness(async (harness) => {
      const triage = await render(harness, 'triage-database-incident', {
        symptom: 'HR sessions hang at startup',
        sid: '4711',
      });
      expect(triage).toContain('- SID: 4711');
      expect(triage).toContain('- Username: (not provided)');
      expect(triage).toContain('HR sessions hang at startup');

      const call = await render(harness, 'prepare-plsql-call', {
        schema: 'HR',
        name: 'RAISE_SALARY',
        argument_values: '100, 2000',
      });
      expect(call).toContain('Prepare a safe payload for `HR.RAISE_SALARY`');
      expect(call).toContain('## Argument Values / Goal');
      expect(call).toContain('100, 2000');
    });
  });

  it('operating-rules y oracle-sql-style se publican sin argumentos', async () => {
    await withHarness(async (harness) => {
      const rules = await render(harness, 'operating-rules');
      expect(rules).toContain('## Decision Loop');
      expect(rules).toContain('## Agent Execution and Data Handling Contract');

      const style = await render(harness, 'oracle-sql-style');
      expect(style).toContain('# Oracle SQL authoring rules');
      expect(style).toContain('ORA-00942');
    });
  });

  it('ningún prompt deja un marcador de plantilla sin sustituir', async () => {
    const args: Record<string, Record<string, string>> = {
      'review-sql-performance': { sql: 'SELECT 1 FROM dual' },
      'explain-schema': { schema: 'HR' },
      'debug-invalid-plsql': { schema: 'HR' },
      'safe-dml-plan': { sql: 'UPDATE employees SET salary = 1 WHERE id = 2' },
      'data-quality-audit': { schema: 'HR', table: 'EMPLOYEES' },
      'triage-database-incident': { symptom: 'CPU saturated' },
      'prepare-plsql-call': { schema: 'HR', name: 'PKG.RAISE_SALARY' },
      'operating-rules': {},
      'oracle-sql-style': {},
    };

    await withHarness(async (harness) => {
      for (const [name, promptArgs] of Object.entries(args)) {
        const text = await render(harness, name, promptArgs);
        expect(text, name).not.toMatch(/%[sd]/);
      }
    });
  });

  it('rechaza un argumento requerido ausente y un identificador inválido', async () => {
    await withHarness(async (harness) => {
      await expect(harness.client.getPrompt({ name: 'review-sql-performance' })).rejects.toThrow(
        /sql/,
      );
      await expect(
        harness.client.getPrompt({ name: 'explain-schema', arguments: { schema: 'a b' } }),
      ).rejects.toThrow(/schema/);
    });
  });
});
