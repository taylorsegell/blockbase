# Normalization support matrix

The v1 normalizer is a deterministic, source-preserving inventory pass. It does not execute imported code or rewrite a source file into a destination framework. Normalized files retain their exact content; adapters consume the occurrence evidence and canonical token contract when emitting destination-native expressions.

| Source form | Supported subset | Confidence | Unsupported or residual boundary |
| --- | --- | ---: | --- |
| React TSX/JSX | `className`/`class` string literals and finite quoted branches | 0.90–0.98 | Runtime template interpolation, unbounded identifiers, dynamic style objects |
| Tailwind | Semantic surface/text/border/action utilities, spacing scale, radius, shadow, typography scale | 0.90–0.98 | Arbitrary literals without an explicit CSS variable, unknown theme utilities |
| Plain CSS | Static declarations for color, spacing, radius, typography, shadow, and motion; explicit semantic `var(--...)` values | 0.92 for explicit variables | Unmapped literals are residuals with their exact fallback and location |
| CSS Modules | The plain CSS subset in `*.module.css` | 0.92 for explicit variables | Same residual rules as plain CSS |
| Inline styles | Object literals containing strings or numbers | 0.92 for explicit semantic variables | Runtime values and style identifiers are unsupported |
| Imports | Relative local imports present in the immutable envelope; third-party package specifiers are recorded | 1.0 for evidence | Missing local files become unresolved-import residuals; dynamic imports are unsupported |

## 21st.dev paste import

`blockbase import - --from 21st` reads a 21st.dev paste from stdin and splits it into files before the normal import, so the files above are normalized as usual. Boundaries:

- No network access. Remote URLs in the paste are reported, not fetched.
- shadcn pieces the paste imports from `@/components/ui/` but does not include are reported as warnings, not resolved.
- A paste whose shape is not recognized is refused with `format:*` reasons; the agent splits it by hand and imports the folder with `--demo`.
- A messy paste is read leniently and is never repaired. Only an empty, oversized, codeless or componentless paste is refused. Invisible characters, odd fences, loose markers and a missing closing fence are tidied when finding file boundaries, and anything that looks damaged, such as a replacement character or suspected truncation, is reported as a warning with its file and line.
- The license is recorded as `unknown` unless it is given; it is never guessed.

## Fixture coverage

| Fixture | Contract exercised | Expected outcome |
| --- | --- | --- |
| `static-tailwind` | Semantic utilities, spacing, radius, shadow | `safe` |
| `arbitrary-literals` | Arbitrary color/dimension literals and an unmapped theme utility | `needs-review` |
| `conditional-branches` | Finite conditional class branches | `safe` |
| `plain-css` | CSS variables, color literal, spacing declaration | `needs-review` |
| `css-modules` | CSS Module variables, radius, color literal | `needs-review` |
| `inline-static` | Static inline variables, numeric spacing, color literal | `needs-review` |
| `local-helpers` | Local static class helper and relative import | `safe` |
| `third-party-import` | Third-party dependency evidence | `safe` |
| `partial-decomposition` | Missing local import | `needs-review` |
| `unsupported-dynamic` | Runtime class interpolation and style object | `unsupported` |

Status mapping is explicit: no residuals is `safe`/`complete`, residual literals or missing local imports are `needs-review`/`partial`, and unsupported dynamic syntax is `unsupported`. A residual always retains its file path, line, column, reason, source, fallback value, and confidence; coverage never hides residuals behind a safe result.
