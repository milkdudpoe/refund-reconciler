import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', '.e2e-profiles/', 'artifacts/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } },
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'chrome', property: 'sync', message: 'Use chrome.storage.local only.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='innerHTML']", message: 'Render user content as text.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'Render user content as text.' },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Render user content as text.' },
        { selector: "MemberExpression[object.name='localStorage']", message: 'Use chrome.storage.local.' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
