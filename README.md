# PharmIDE

A Tauri v2 desktop application for pharmacy workflow management. Models the full prescription lifecycle inside a spatial, patient-centric workspace interface.

## What It Does

- **Patient workspaces** — each patient gets an independent workspace with draggable/resizable tiles on a 12×8 grid
- **Full Rx pipeline** — e-order intake → tech entry → RPh verification → fill → fill verification → dispensing
- **Merkle audit chain** — every state transition is hashed and chained for tamper-evident logging
- **Prescriber directory** — searchable, editable, with name-change tracking
- **E-script generator** — AI-generated mock e-orders via Claude Haiku
- **Inventory management** — on-hand tracking with adjustment history
- **Role-based access** — tech and RPh roles with enforced permission boundaries

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 19 (JSX) |
| Build | Vite 7 |
| Desktop | Tauri v2 |
| Backend | Rust |
| Database | SQLite (rusqlite) |

## Dev Setup

```bash
npm install
npm run tauri dev       # Full dev — Vite + Rust hot reload
npm run dev             # Frontend only
npm run lint            # ESLint
npm run tauri build     # Production build (Windows WIX installer)
```

## Databases

| File | Purpose |
|------|---------|
| `drug_tree.db` | FDA drug reference (read-only, bundled) |
| `pharmide.db` | Prescriptions, patients, prescribers, audit log, users |
| `inventory.db` | Pharmacy inventory |
