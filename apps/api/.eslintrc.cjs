module.exports = {
  root: true,
  overrides: [
    {
      files: ['**/*.spec.ts', '**/*.test.ts', 'src/test/**'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
