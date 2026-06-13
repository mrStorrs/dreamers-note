# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash scripts/validate-vault-bootstrap.sh` | <1s | 30s | Vault support-file validation. |
| `bash tests/test-framework.sh` | 5s | 30s | Framework, package foundation, and vault-bootstrap integration checks. |
| `npm run typecheck` | <1s | 30s | TypeScript package foundation type-check. |
| `npm test` | 2s | 30s | TypeScript package foundation, index/search core, and legacy compatibility checks. |
| `package:index:rebuild` | 91ms | 30s | PASS: Cold rebuild without embeddings against a 150-note/400-file fixture. Budget 10000ms. |
| `package:search:warm` | 25ms | 30s | PASS: Warm lexical search against the local SQLite index. Budget 1000ms. |
| `package:index:refresh-one` | 62ms | 30s | PASS: One-note refresh against an existing index. Budget 2000ms. |
| `python3 tests/test-daily-triage.py` | <1s | 30s | Daily-triage dry-run proposal checks. |
| `python3 tests/test-vault-normalization.py` | <1s | 30s | Dry-run normalization proposal checks. |
| `python3 tests/test-vault-remap.py` | <1s | 30s | AI-assisted vault remap inventory/apply checks against fixture vaults. |
| `bash -n scripts/validate-framework.sh scripts/validate-vault-bootstrap.sh tests/test-framework.sh` | <1s | 30s | Shell syntax check. |
