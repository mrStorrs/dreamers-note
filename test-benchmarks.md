# Validation

Run `bash tests/test-framework.sh` with Node 18+ and Git. No dependency installation, TypeScript compiler, or native modules are required.

The behavioral tests use temporary vaults and client homes. They verify Markdown index generation, stable output, privacy exclusions, handwritten-index protection, installation from a source-only checkout, managed replacement, and preflight failures. Public-release checks protect local paths and historical private data from publication.

For installation checks that benefit from OS isolation, use `ai-test-01` with fixture client homes. Actual skill discovery is checked by restarting the target client.
