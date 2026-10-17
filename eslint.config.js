import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'mcp-audit-logs/**',
      'video/**',
      // Skills de agente: documentacion y assets vendorizados, no codigo del paquete.
      '.agents/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // stdout está reservado al JSON-RPC: solo stderr.
      'no-console': ['error', { allow: ['error', 'warn', 'info'] }],
    },
  },
  {
    // eslint.config.js es JS plano: no entra al proyecto de tsconfig.
    // scripts/*.mjs tampoco (utilerías de CI, con self-test propio).
    files: ['**/*.js', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
);
