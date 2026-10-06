# Vultbase Security Audit — GitHub Action

Runs Vultbase smart contract analysis on pull requests and optional push-to-main.

## Usage

```yaml
- uses: Vultbase/vultbase-action@v1
  with:
    api-key: ${{ secrets.VULTBASE_API_KEY }}
    contracts: 'contracts/**/*.sol'
    protocol-name: 'My Protocol'
```

See `example-workflow.yml` and `example.vultbase.yml` in this repository.

**Live demo:** [Vultbase/security-audit-demo](https://github.com/Vultbase/security-audit-demo) — sample contract + workflow that asserts findings are returned.

## Inputs

Documented in [action.yml](./action.yml).

## Build (maintainers)

```bash
npm ci
npm run build
git add dist/
```

Commit `dist/index.js` — GitHub Actions runs the bundled entrypoint.
