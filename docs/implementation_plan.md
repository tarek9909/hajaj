# Restaurant Workforce Management Platform - Implementation Plan

## Architectural Overview
A modular monolith with:
- **`packages/contracts`**: Zod validation schemas, shared DTOs, enum definitions, and type contracts.
- **`packages/calculation-engine`**: Pure deterministic calculation domain: working-time evaluation, debt allocation & recovery, overtime eligibility, salary/late penalties, blockers, invariant checks, and tests with `decimal.js` and integer minutes.
- **`apps/api`**: Express 5 application with modular architecture, strict multi-tenant isolation (`restaurant_id` on every query), server-side session cookies (`__Host-session`), CSRF protection, optimistic locking (`row_version`), idempotency keys, OpenAPI spec, and audit logging.
- **`apps/worker`**: Background worker polling the MySQL `jobs` table with `SKIP LOCKED`, processing recalculation runs and export generations.
- **`apps/web`**: React + Vite + TypeScript web application with React Router, TanStack Query, typed API client, refined UI design system (deep charcoal nav, warm neutrals, crisp white surfaces, deep teal accents, tabular numerals, accessible warning dots, full responsiveness from 360px to 1920px).
- **`database`**: Migrations matching `restaurant_workforce.sql`, deterministic seed data, bootstrap CLI for first Superadmin.

## 8 Vertical Slices
1. **Slice 1: Monorepo Foundation, Database Migrations, Calculation Engine & Auth**
2. **Slice 2: Platform Superadmin, Restaurant Isolation & Administrator Management**
3. **Slice 3: Configuration & Employee Management**
4. **Slice 4: Bulk Scheduling & Calendar Engine**
5. **Slice 5: Daily Attendance, Lateness & Warning Management**
6. **Slice 6: Working-Hour Debt Reconciliation & Authoritative Payroll Engine**
7. **Slice 7: Monthly Reports, Finalization Workflow & Exports**
8. **Slice 8: Deterministic Seeds, Full Verification, Responsive Refinement & Hardening**
