// ESLint flat config — mechanical enforcement of the architecture boundaries
// (Constitution II: the domain does not know it is on a server).
// `npm run build` runs this first; violations FAIL THE BUILD.
import eslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
    plugins: {
      '@typescript-eslint': eslint,
      import: importPlugin,
    },
    rules: {
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'import/first': 'error',
    },
  },
  {
    // DOMAIN RING (Constitution II): zero imports outside src/domain,
    // and ZERO external packages — time/randomness arrive as injected value objects.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^[^.]',
              message:
                'The domain must not import any package (Prisma, Express, luxon, process.env, loggers). Inject Clock/Randomness as ports/value objects instead. [Constitution II]',
            },
          ],
        },
      ],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/domain',
              from: './src',
              except: ['./src/domain'],
              message: 'Domain may only import within src/domain. [Constitution II]',
            },
          ],
        },
      ],
    },
  },
  {
    // APPLICATION RING: may use domain, never infrastructure/interfaces directly
    // (dependency inversion — application depends on ports, wired by the container).
    files: ['src/application/**/*.ts'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/application',
              from: './src',
              except: ['./src/application', './src/domain', './src/contracts'],
              message:
                'Application must not import infrastructure or interfaces; depend on ports and let the container wire implementations.',
            },
          ],
        },
      ],
    },
  },
];
