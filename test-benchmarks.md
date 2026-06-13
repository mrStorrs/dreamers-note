# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash scripts/validate-vault-bootstrap.sh` | <1s | 30s | Vault support-file validation. |
| `bash tests/test-framework.sh` | 5s | 30s | Framework, package foundation, and vault-bootstrap integration checks. |
| `npm run typecheck` | <1s | 30s | TypeScript package foundation type-check. |
| `npm test` | 2s | 30s | TypeScript package foundation and legacy compatibility checks. |
| `python3 tests/test-daily-triage.py` | <1s | 30s | Daily-triage dry-run proposal checks. |
| `python3 tests/test-vault-normalization.py` | <1s | 30s | Dry-run normalization proposal checks. |
| `python3 tests/test-vault-remap.py` | <1s | 30s | AI-assisted vault remap inventory/apply checks against fixture vaults. |
| `bash -n scripts/validate-framework.sh scripts/validate-vault-bootstrap.sh tests/test-framework.sh` | <1s | 30s | Shell syntax check. |
