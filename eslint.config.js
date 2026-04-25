// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Teach eslint-plugin-import to resolve the @/ path alias defined in tsconfig.json.
    // eslint-import-resolver-typescript reads compilerOptions.paths so @/* → ./*
    // works identically to how TypeScript resolves it.
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
        node: true,
      },
    },
  },
]);
