# Security Policy

## Supported Versions

Only the latest minor release of **Auto Encoding** receives security fixes.

| Version | Supported |
| ------- | --------- |
| `0.1.x` | Yes       |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub Issues.

Instead, use GitHub's **Private Vulnerability Reporting** feature on this repository:
1. Go to the **Security** tab of `imoyan/vscode-auto-encoding`.
2. Click **Report a vulnerability**.
3. Include reproduction steps, affected version, OS/VS Code version, and potential impact.

We aim to acknowledge reports within 7 days and coordinate a fix and disclosure timeline with you.

## Security & Privacy Guarantees

- **No network access or telemetry**: The extension runs entirely locally inside VS Code.
- **Path containment & bounded I/O**: File reads and conversions enforce workspace-root realpath checks, symlink/TOCTOU protection via pinned file handles, and configurable file size/count limits.
- **Reproducible VSIX verification**: Releases include `SHA256SUMS` and GitHub Artifact Attestations.
