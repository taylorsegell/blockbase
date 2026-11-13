# Destination fixture inventory

These fixtures are intentionally small and unrelated to the catalog itself.

| Fixture | Framework | Styling | Tokens / modes | Alias and layout | Class helper |
| --- | --- | --- | --- | --- | --- |
| `fixture-a` | Vite `^5.4.0` | Tailwind 3 + CSS | `--color-*`, `.dark` | `@/` → `src/components` | `clsx` |
| `fixture-b` | Next `^14.2.5` | CSS variables | `--surface-*`, prefers-color-scheme dark | `~/` → `app`, `app/ui` | `classnames` |

The inspector tests use these as profile goldens: framework, styling systems,
token names, aliases, component directories, package versions, helper
evidence, deterministic bounded samples, and no-write behavior are asserted.
