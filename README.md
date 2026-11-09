# Mazal

A local finance application that connects a transaction ledger, document review, cash-flow planning, and a Python calculation engine. React provides the interface, Node owns the local API and SQLite records, and a Swift macOS shell packages the desktop app.

[Engineering notes](ENGINEERING.md) trace statement retries, ledger writes, recovery, and stale-edit protection.

[Product portfolio](https://github.com/hxssank/recruiter-portfolio)

## What the application does

- Imports statement rows into a review queue before committing them to the ledger. Source hashes and row identifiers connect transactions to the material they came from.
- Tracks accounts, recurring obligations, debt terms, spending plans, assets, and investment positions. Unknown amounts remain unknown instead of silently becoming zero.
- Links payroll records and timecards to possible bank deposits, with ambiguity and missing evidence visible to the user.
- Calculates dated cash-flow scenarios and long-term compounding plans. A separate Python service runs the numerical models.
- Exports an Excel workbook and supports encrypted backups of records and source documents.
- Uses a desktop-session token and loopback service checks for local access. The macOS shell owns desktop integration and native document helpers.

## How the pieces connect

```mermaid
flowchart LR
    UI[React interface] --> API[Node API]
    API --> Store[SQLite ledger and audit records]
    API --> Docs[Local document store]
    API --> Engine[Python calculation service]
    API --> Export[Workbook and encrypted backup]
    Shell[Swift macOS shell] --> UI
```

## Code worth reviewing

| Question | Start here |
| --- | --- |
| How do imports retain their source and avoid duplicate rows? | [Statement handling](server/routes/records.ts), [SQLite constraints](server/persistence.ts) |
| How does the app separate interface code from financial calculations? | [Shared calculations](shared/), [Python models](backend/mazal_engine/), [boundary checks](scripts/check-boundaries.mjs) |
| How does it handle incomplete financial information? | [Cash preview](shared/home-cash-preview.ts), [payroll lookup](shared/payroll-lookup.ts), [planning tests](shared/planner.test.ts) |
| How does backup and recovery work? | [Automatic backup](server/automatic-backup.ts), [complete restore](server/complete-backup.ts) |
| How is the desktop app packaged? | [Native shell](macos/Mazal.swift), [packaging scripts](scripts/build-mac-app.mjs) |

## Run locally

Use the Node version in [.node-version](.node-version), the Python version in [backend/.python-version](backend/.python-version), and uv 0.13.1. The setup script checks these versions and installs the locked dependencies.

```sh
npm run setup
npm run dev
```

For a production build served locally:

```sh
npm run build
npm start
```

The server stores new records in the repository's ignored `data/` directory by default. `MAZAL_DATA_DIR` selects another directory. This repository contains application code and synthetic test cases; personal statements, balances, backups, and source documents are excluded.

On macOS, `npm run mac:build` creates the desktop package. Review the build scripts before using installation commands on an existing installation.

## Validation

The following checks passed on November 9, 2026 in a fresh macOS ARM64 checkout with Node 24.22.0, Python 3.13.16, and the locked dependencies:

| Check | Result |
| --- | --- |
| Node application tests | 2,030 passed |
| Python engine tests and Ruff | 560 passed; lint passed |
| Release archive and native-package tests | 44 passed |
| TypeScript, production build, and architecture boundaries | Passed |
| Backup controls in WebKit at 320 px and 1440 px, plus sample/snapshot isolation | 4 passed |
| Clean source-release installation | Passed |

The clean-install check extracts the source ZIP into a new directory, installs its dependencies, builds the app, and starts isolated services. It verifies every served asset hash, checks empty records, round-trips a synthetic complete backup, and confirms both services stop. Personal records and the installed app are not used.

```sh
npm run check:release
npm run test:browser
npm run release:verify
```

The [pre-fix hosted run](https://github.com/hxssank/mazal/actions/runs/42697649145) exposed three defects: the source packager omitted the backup UI directory, a Python test decoded UTF-8 output with the Windows default encoding, and WebKit tests tried to fulfill a cached 304 response. This snapshot fixes those causes and adds archive coverage for the missing modules. See [Release checks](https://github.com/hxssank/mazal/actions/workflows/ci.yml) for the current Linux, macOS, and Windows results. Local passes do not establish a passing operating-system matrix.

## Current limits

This is a personal desktop application under development. Forecasts depend on the records and assumptions entered. An apparent payroll match is evidence to review, not proof of payment. The installed macOS app and all operating-system combinations were not verified for this GitHub snapshot.

The API is designed for a local desktop session. A hosted, multi-user product would need account authentication, authorization per record, tenant isolation, managed key storage, and deployment monitoring before exposing it to the internet.
