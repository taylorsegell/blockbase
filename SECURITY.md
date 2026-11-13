# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab), not in a public issue. Include steps to reproduce and the affected version. You should get an acknowledgement within a week.

## Scope

In scope:

- Code execution during `import`. Import must never run component code or dependency install scripts.
- Escape from the preview policy: dependency allowlist, iframe sandbox, CSP, loopback-only sessions.
- Path traversal or symlink escapes when reading or writing the catalog or a destination project.
- The optional MCP server, including its bearer-token check when it is exposed beyond loopback.

Out of scope: the licensing or behavior of third-party components you import.
