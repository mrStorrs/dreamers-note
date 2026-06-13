# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash scripts/validate-vault-bootstrap.sh` | <1s | 30s | Vault support-file validation. |
| `bash tests/test-framework.sh` | 1.7s | 30s | Framework and vault-bootstrap integration checks. |
| `python3 tests/test_package_foundation.py` | <1s | 30s | Package metadata, config, path safety, runtime, CLI, and facade checks. |
| `python3 tests/test-daily-triage.py` | <1s | 30s | Daily-triage dry-run proposal checks. |
| `python3 tests/test-vault-normalization.py` | <1s | 30s | Dry-run normalization proposal checks. |
| `python3 tests/test-vault-remap.py` | <1s | 30s | AI-assisted vault remap inventory/apply checks against fixture vaults. |
| `python3 -m unittest discover tests` | <1s | 30s | unittest discovery for importable test modules. |
| `git diff --check` | <1s | 30s | Whitespace and conflict-marker check. |
| `bash -n scripts/validate-framework.sh scripts/validate-vault-bootstrap.sh tests/test-framework.sh` | <1s | 30s | Shell syntax check. |
