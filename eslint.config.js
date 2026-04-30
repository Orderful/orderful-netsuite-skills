// Copyright (c) 2026 Orderful, Inc.

import js from '@eslint/js';
import headers from 'eslint-plugin-headers';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**'],
  },
  js.configs.recommended,
  {
    plugins: { headers },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'headers/header-format': [
        'error',
        {
          source: 'string',
          style: 'line',
          content: 'Copyright (c) 2026 Orderful, Inc.',
        },
      ],
    },
  },
];
