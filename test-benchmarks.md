# Test benchmarks

| Command | Recommended timeout | Coverage |
|---|---:|---|
| `bash scripts/validate-framework.sh` | 30s | Canonical skill tree, final CLI surface, and removed legacy paths. |
| `bash scripts/validate-vault-bootstrap.sh` | 30s | Vault support files and safe bootstrap state. |
| `bash tests/test-framework.sh` | 60s | Installer preflight/sync, documentation and skill contracts, shell syntax, typecheck, and Node suites. |
| `npm run typecheck` | 30s | TypeScript CLI and runtime contracts. |
| `npm test` | 60s | Lexical search, graph review, exact change lifecycle, maintenance planners, and JSON CLI behavior. |
| `npm run test:cli` | 30s | JSON command grammar, bounded output, and non-mutating maintenance plans. |

The runtime uses a rebuildable lexical/graph SQLite cache. The test suite uses fixture vaults only; `change apply` safety and rollback tests never target a user vault.
