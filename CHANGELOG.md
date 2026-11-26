# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-26

### Added
- Initial public release of **Auto Encoding** (`imoyan.auto-encoding`).
- Automatic encoding reopening for clean workspace files (`autoEncoding.autoReopen`) using configured rules or unique byte detection.
- Automatic encoding alignment for Git comparisons and single Git views (`autoEncoding.autoReopenGitComparison`).
- Ranked decoded previews for ambiguous encoding candidates in the status bar QuickPick.
- Per-folder and per-file encoding rules (`autoEncoding.rules`) with Explorer badges (`autoEncoding.showExplorerBadges`).
- One-screen encoding and line-ending (`LF` / `CRLF`) conversion for single files and folders, with local backup and Undo (`autoEncoding.undoLastConversion`).
- Save warnings for encoding mismatch, decode loss, and `U+FFFD` replacement characters (`autoEncoding.warnOnSave`).
- Official VS Code internationalization (`package.nls` + `vscode.l10n`) with English (default) and Japanese (`ja`) support.
