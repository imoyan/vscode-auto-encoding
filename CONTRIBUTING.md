# Contributing to Auto Encoding

Thank you for your interest in contributing to **Auto Encoding**!

## Development Setup

Requirements:
- Node.js 22+
- Python 3 (for VSIX privacy and gitleaks helper tests)
- VS Code (for Extension Host integration tests)

```sh
git clone https://github.com/imoyan/vscode-auto-encoding.git
cd vscode-auto-encoding
npm ci
npm run check
```

## Available Scripts

- `npm run check` — Type-check (`tsc --noEmit`), lint (`eslint`), and run all unit tests.
- `npm run build` — Bundle the extension into `dist/extension.js` using esbuild.
- `npm run package:vsix` — Build and package a universal `.vsix` file.
- `npm run test:host` — Run real VS Code Extension Host tests in an isolated temporary profile.

## Adding a New Language (i18n)

Auto Encoding uses VS Code's official localization format. To add a new locale (for example, `de`, `fr`, `zh-cn`, `ko`):

1. Copy `package.nls.json` to `package.nls.<locale>.json` and translate the values.
2. Copy `l10n/bundle.l10n.json` to `l10n/bundle.l10n.<locale>.json` and translate the values, keeping `{0}`, `{1}`, etc. placeholders intact.
3. Run `npm run check` and open a Pull Request.

## Pull Request Workflow

We follow **GitHub Flow**:
1. Create a short-lived branch from `main`.
2. Keep changes focused and include tests for bug fixes or new behavior.
3. Ensure `npm run check` passes cleanly.
4. Open a Pull Request describing the motivation, changes, and verification steps.

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE) and adhere to the [Code of Conduct](./CODE_OF_CONDUCT.md).
