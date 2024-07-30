const love = require('eslint-config-love')

module.exports = [{
  ...love,
  languageOptions: {
    ...love.languageOptions,
    parserOptions: {
      ...love.languageOptions.parserOptions,
      project: './tsconfig.eslint.json'
    },
  },
  files: ['src/**/*.ts', 'test/**/*.ts'],
  rules: {
    ...love.rules,
    "@typescript-eslint/array-type": "off",
    '@typescript-eslint/class-methods-use-this': 'off',
    "@typescript-eslint/consistent-type-assertions": ["error", { "assertionStyle": "as" }],
    "@typescript-eslint/explicit-function-return-type": "off",
    '@typescript-eslint/no-explicit-any': 'off',
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-unused-vars": "off", // typescript does this better
    "@typescript-eslint/prefer-readonly": "off",
    "@typescript-eslint/return-await": ["error", "always"],
    "@typescript-eslint/strict-boolean-expressions": "off",
    // just for this project
    '@typescript-eslint/no-unsafe-argument': 'off'
  }
}]
