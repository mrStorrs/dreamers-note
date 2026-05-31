# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash tests/test-framework.sh` | <1s | 30s | Plan 01 integration checks. |
| `bash -n scripts/validate-framework.sh tests/test-framework.sh` | <1s | 30s | Shell syntax check. |
