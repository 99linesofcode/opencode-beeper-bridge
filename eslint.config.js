import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Build output is compiled, not authored — linting it produces false
// failures on whatever the compiler emitted.
export default tseslint.config({ ignores: ['build/**', 'dist/**'] }, ...tseslint.configs.recommended, prettier);
