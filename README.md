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

## Inputs

Documented in [action.yml](./action.yml).

## Build (maintainers)

```bash
npm ci
npm run build
git add dist/
```

Commit `dist/index.js` — GitHub Actions runs the bundled entrypoint.
