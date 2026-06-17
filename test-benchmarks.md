# test-benchmarks

| Command | Last run | Recommended timeout | Notes |
|---|---:|---:|---|
| `bash scripts/validate-framework.sh` | <1s | 30s | Framework structure validation. |
| `bash scripts/validate-vault-bootstrap.sh` | <1s | 30s | Vault support-file validation. |
| `bash tests/test-framework.sh` | 16s | 30s | Dispatcher for framework validation, focused shell contracts, Python script suites, shell syntax, typecheck, and Node tests. |
| `npm run typecheck` | 1s | 30s | TypeScript package foundation type-check. |
| `npm test` | 7s | 30s | TypeScript package foundation, index/search core, MCP proposal contracts, note-add/capture integration, import/triage integration, graph-health review, retrieval hardening, and legacy compatibility checks. |
| `package:index:rebuild` | 108ms | 30s | PASS: Cold rebuild without embeddings against a 150-note/400-file fixture. Budget 10000ms. |
| `package:search:warm` | 31ms | 30s | PASS: Warm hybrid search against the local SQLite index. Budget 1000ms. |
| `package:index:refresh-one` | 57ms | 30s | PASS: One-note refresh against an existing hybrid index. Budget 2000ms. |
| `package:context-pack:warm` | 27ms | 30s | PASS: Warm context pack over cited hybrid retrieval. Budget 1000ms. |
| `package:mcp:start-tools` | 76ms | 30s | PASS: MCP stdio startup through initialized tool listing. Budget 2000ms. |
| `package:embeddings:refresh` | 59ms | 30s | PASS: Optional local embedding refresh timing with the builtin provider. Budget 3000ms. |
| `package:proposal:create` | 228ms | 30s | PASS: Proposal creation with index refresh, lineage capture, and bounded evidence persistence. Budget 2000ms. |
| `package:proposal:apply` | 125ms | 30s | PASS: Authorized proposal apply with lock, rollback safety, and post-write index refresh. Budget 3000ms. |
| `package:graph:diagnostics` | 109ms | 30s | PASS: Bounded graph structure diagnostics with duplicate-title, orphan, unresolved-link, and over-broad-tag signals. Budget 2000ms. |
| `package:health:report` | 205ms | 30s | PASS: Health report with broken-link, stale-project, proposal, daily-capture, placement-debt, and conflicting-tag checks. Budget 3000ms. |
| `package:review:queue` | 297ms | 30s | PASS: Weekly review queue aggregation over health, duplicate, proposal, capture, and resurfacing runtime state. Budget 3000ms. |
| `python3 tests/test-daily-triage.py` | <1s | 30s | Daily-triage dry-run proposal checks. |
| `python3 tests/test-script-fixtures.py` | <1s | 30s | Shared Python script fixture and JSONL boundary checks. |
| `python3 tests/test-vault-normalization.py` | <1s | 30s | Dry-run normalization proposal checks. |
| `python3 tests/test-vault-remap.py` | <1s | 30s | AI-assisted vault remap inventory/apply checks against fixture vaults. |
| `bash -n scripts/validate-framework.sh scripts/validate-vault-bootstrap.sh tests/helpers/framework-contract-helpers.sh tests/test-framework.sh tests/test-framework-doc-contracts.sh tests/test-framework-skill-contracts.sh tests/test-framework-installer-contracts.sh tests/test-vault-bootstrap-contracts.sh` | <1s | 30s | Shell syntax check. |
