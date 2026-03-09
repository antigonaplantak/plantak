# Plantak Operations Runbook

## Pre-release contract

Working tree must be clean.

Run:

```bash
pnpm run ops:release-check
```

Expected result:

- `RELEASE_CHECK_OK`

## Go-live contract

Run:

```bash
pnpm run ops:go-live-check
```

Checks:

- compose stack up
- `/api/health` returns 200
- queue dashboard returns 401 without auth
- queue dashboard returns 200 with auth
- effective container Redis env is correct
- no runtime pnpm download
- no localhost Redis fallback
- API restart stays green

Expected result:

- `GO_LIVE_CHECK_OK`

## Rollback contract

Run:

```bash
pnpm run ops:rollback-smoke
```

Checks:

- tagged rollback ref boots in isolated compose project
- `/api/health` returns 200 on rollback stack
- queue dashboard auth returns 200 on rollback stack

Expected result:

- `ROLLBACK_SMOKE_OK`

## Release order

```bash
pnpm run ops:release-check
pnpm run ops:go-live-check
pnpm run ops:rollback-smoke
```

## Current stable ref

- `production-deploy-discipline-green-20260309`
- current green commit can be updated after each proven release milestone
