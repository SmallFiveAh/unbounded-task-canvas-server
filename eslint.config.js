import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', '.wrangler/**', 'dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
      // 企业级红线：单文件 ≤ 400 行、嵌套 ≤ 4 层、圈复杂度 ≤ 12
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-depth': ['warn', 4],
      complexity: ['warn', 12],
    },
  },
  prettier,
];
