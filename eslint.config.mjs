import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/*
  Two things this is for. The hooks rules, because the one renderer bug the
  audit found that shipped (a handler holding a stale callback) is exactly
  what exhaustive-deps reports. And the TypeScript recommended set, which
  the compiler's strict mode does not cover (unused expressions, misused
  promises are not in it, but no-explicit-any is, and is turned off here:
  the IPC edges and the wire are `any` on purpose).
*/
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'dist-next/**', 'build/**', 'node_modules/**', 'test/**', '*.config.*'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  }
)
