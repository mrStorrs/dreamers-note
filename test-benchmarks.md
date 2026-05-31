# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash scripts/validate-vault-bootstrap.sh` | <1s | 30s | Vault support-file validation. |
| `bash tests/test-framework.sh` | <1s | 30s | Framework and vault-bootstrap integration checks. |
| `python3 tests/test-vault-normalization.py` | <1s | 30s | Dry-run normalization proposal checks. |
| `bash -n scripts/validate-framework.sh scripts/validate-vault-bootstrap.sh tests/test-framework.sh` | <1s | 30s | Shell syntax check. |
