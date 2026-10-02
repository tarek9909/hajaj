# Restaurant Workforce and Salary Management System
## Technical Architecture and Implementation Specification

**Backend:** Node.js, TypeScript, MySQL  
**Frontend:** React, Vite, TypeScript  
**Architecture:** Multi-tenant modular monolith  
**Document version:** 1.0

This specification translates the business documentation into the application structure, database model, API contracts, calculation engine, frontend requirements, security controls, and testing requirements.

The central calculation rule is:

**An employee’s additional working time must clear outstanding working-hour debt before any remaining time becomes payable overtime.**

---

## 1. Scope and Implementation Assumptions

### 1.1 Included functionality

The application will provide restaurant management, administrator accounts, employee records, configuration, bulk scheduling, manual attendance, working-hour debt recovery, overtime, deductions, warnings, monthly salary calculations, reports, and audit history.

Employees are staff records, not login accounts.

All active administrators of a restaurant have the same access. There will be no configurable roles, permission tables, or permission-management interface.

### 1.2 Business defaults used in this specification

The following defaults carry forward from the business architecture:

| Area | Implementation baseline |
|---|---|
| Payroll period | Calendar month |
| Debt reconciliation | Across the complete payroll month |
| Outstanding debt | Carried forward until recovered or explicitly waived |
| Overtime during an open month | Provisional |
| Lateness grace | Prevents the late penalty, but does not reduce required hours |
| Late deduction | One configured percentage of daily salary per qualifying workday |
| Automatic late warning | Maximum one per qualifying workday |
| Warning counting period | Calendar month |
| Warning threshold | Flag at the configured count or above |
| Custom warnings | Count toward the threshold by default |
| Financial finalization | Restaurant payroll month finalized as one unit |
| Salary and pay-policy changes | Normally effective from the beginning of a payroll month |

These are implementation defaults, particularly monthly reconciliation and debt carry-forward. They must be approved as restaurant policy before production use.

**Monthly reconciliation means additional hours earlier in an open month can cover a shortfall later in that same month.** Finalized overtime from an earlier month is not automatically reversed.

---

## 2. Technology Stack

### 2.1 Backend

| Component | Selected approach |
|---|---|
| Runtime | Node.js 24 LTS, with a maintained patch release |
| Language | TypeScript |
| HTTP framework | Express 5 |
| Database | MySQL 8.4, InnoDB |
| Database access | `mysql2/promise`, parameterized SQL |
| Migrations | Version-controlled SQL migrations |
| Request validation | Zod schemas |
| Monetary calculations | `decimal.js` |
| Date and time handling | Luxon |
| Authentication | Server-side sessions with secure cookies |
| API documentation | OpenAPI specification |
| Long-running operations | Node.js worker using a MySQL-backed jobs table |

Node.js recommends supported LTS releases for production. Express 5 supports the selected Node.js baseline. Exact dependency versions should be pinned in the lockfile and updated through tested maintenance releases. [Node.js](https://nodejs.org/en/about/previous-releases?utm_source=chatgpt.com)

### 2.2 Frontend

| Component | Selected approach |
|---|---|
| UI | React |
| Build tooling | Vite |
| Language | TypeScript |
| Routing | React Router |
| Server-state management | TanStack Query |
| API calls | A shared wrapper around `fetch` |
| Forms | Typed form components with schema validation |
| Styling | A consistent component system and CSS approach |
| Tables | Reusable paginated and editable table components |

React’s documentation supports a Vite-based TypeScript application and identifies routing and server-state fetching as separate concerns. TanStack Query will manage API-backed data, caching, and invalidation. [React](https://react.dev/learn/build-a-react-app-from-scratch)

Use TypeScript strict checking in both applications. Also enable `noUncheckedIndexedAccess` and prohibit unchecked `any` in financial and attendance modules. TypeScript’s `strict` option enables its strict type-checking family. [TypeScript](https://www.typescriptlang.org/tsconfig/strict.html)

---

## 3. Application Architecture

### 3.1 Overall structure

Use a **modular monolith**, not microservices.

The deployment consists of a React application, one backend API, one background worker, and one MySQL database.

The API and worker share the same domain services and calculation engine.

The browser communicates only with the API. It never connects directly to MySQL.

### 3.2 Backend modules

| Module | Responsibility |
|---|---|
| Authentication | Login, logout, password setup, session validation |
| Restaurants | Restaurant creation, configuration identity, activation |
| Administrators | Restaurant administrator lifecycle |
| Employees | Staff information, employment status, salary history |
| Configuration | Effective-dated policies, positions, shift templates |
| Scheduling | Dated schedules, recurrence expansion, bulk changes |
| Attendance | Actual working intervals and corrections |
| Warnings | Automatic warnings, custom warnings, voiding |
| Adjustments | Authorized salary additions and deductions |
| Hour Debt | Debt sources, waivers, recovery allocations |
| Payroll | Calculation runs, reconciliation, finalization |
| Reporting | Summaries, detail views, exports |
| Audit | Traceable business changes |
| Jobs | Recalculations and export processing |

### 3.3 Layer responsibilities

Each module should follow this structure:

```text
Route
Controller
Request validation
Application service
Domain logic
Repository
Database
```

Controllers must not contain salary formulas or raw SQL.

Repositories must not decide business policy.

The calculation engine must not depend on Express, HTTP requests, or React.

### 3.4 Repository structure

```text
restaurant-workforce/
  apps/
    api/
      src/
        modules/
          auth/
          restaurants/
          administrators/
          employees/
          configuration/
          scheduling/
          attendance/
          warnings/
          adjustments/
          debt/
          payroll/
          reports/
          audit/
        infrastructure/
          database/
          sessions/
          jobs/
          logging/
        middleware/
        app.ts
        server.ts

    worker/
      src/
        handlers/
        worker.ts

    web/
      src/
        app/
        routes/
        features/
        components/
        hooks/
        lib/
        styles/

  packages/
    contracts/
    calculation-engine/

  database/
    migrations/
    seeds/

  tests/
    integration/
    end-to-end/

  docs/
    openapi.yaml
```

`contracts` contains shared request and response types and validation schemas.

`calculation-engine` contains the deterministic time, debt, and salary calculations.

Sharing types does not replace backend validation. All incoming values remain untrusted.

---

## 4. Authentication and Access Model

### 4.1 Account categories

Use two fixed account categories:

```typescript
type AccountKind =
  | "SUPERADMIN"
  | "RESTAURANT_ADMIN";
```

This is a fixed platform-access distinction, not a configurable RBAC system.

For the initial implementation, each restaurant administrator account belongs to one restaurant. A Superadmin account does not belong to a single restaurant.

Employee positions have no relationship to login access.

### 4.2 Administrator authentication

Administrators log in using an email address and password.

Use a server-generated, cryptographically random session token. Store only its hash in the sessions table.

The browser receives the token through a cookie with:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
```

Use a host-only cookie, such as `__Host-session`, without a `Domain` attribute. Rotate the session at login and revoke it on logout, password reset, or account deactivation. These controls follow OWASP session-management guidance. [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html?utm_source=chatgpt.com)

Proposed session limits are 30 minutes of inactivity and a 12-hour absolute lifetime. These are application defaults, not business requirements.

### 4.3 Password management

Hash passwords with Argon2id. Do not store plaintext or reversibly encrypted passwords. OWASP recommends purpose-built password hashing such as Argon2id rather than fast general-purpose hashes. [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html?utm_source=chatgpt.com)

New administrator accounts should receive a single-use password-setup link. The setup token must be hashed, expire, and become unusable after successful setup.

Password delivery by SMS or WhatsApp is not required.

### 4.4 Request authorization

For every authenticated request, verify:

```text
Session exists and is valid.
Account is active.
Requested account category is permitted.
Restaurant association is valid.
Restaurant is active for operational access.
```

An inactive administrator must lose access immediately, not only after their existing session expires.

Restaurant administrators cannot create Superadmin accounts.

### 4.5 Protecting the last administrator

When deactivating an administrator:

```text
Begin transaction.
Lock the restaurant record.
Count its active administrators.
Reject removal of the last active administrator.
Update account status.
Revoke the administrator’s sessions.
Write audit event.
Commit.
```

The restaurant lock prevents two administrators from concurrently deactivating each other and leaving the restaurant without active access.

---

## 5. Multi-Tenant Isolation

Each restaurant is a tenant.

Use a shared database with an explicit `restaurant_id` on every restaurant-owned record.

### 5.1 Trusted tenant context

The backend creates a tenant context only after validating the authenticated account against the requested restaurant.

```typescript
interface TenantContext {
  restaurantId: string;
  actorId: string;
  accountKind: "SUPERADMIN" | "RESTAURANT_ADMIN";
  requestId: string;
}
```

Repository methods must require this context.

The system must not trust a `restaurantId` supplied inside a request body as authorization.

### 5.2 Query scoping

An employee lookup must use both identifiers:

```sql
SELECT *
FROM employees
WHERE restaurant_id = ?
  AND id = ?;
```

It must not retrieve by employee ID alone and assume the caller is authorized.

The same isolation applies to exports, jobs, cached results, salary details, warnings, and audit views. OWASP specifically identifies consistent tenant context and tenant-scoped data access as essential multi-tenant controls. [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html?utm_source=chatgpt.com)

### 5.3 Database enforcement

Tenant-owned parent tables should expose a unique key on:

```sql
UNIQUE (restaurant_id, id)
```

Child relationships should use composite foreign keys:

```sql
FOREIGN KEY (restaurant_id, employee_id)
REFERENCES employees (restaurant_id, id)
```

Where a child contains both an employee ID and a schedule-day ID, enforce that the schedule day belongs to that same employee as well.

Use `ON DELETE RESTRICT` for historical business relationships. MySQL supports composite foreign-key constraints, subject to its indexing and referenced-key requirements. [MySQL](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html?utm_source=chatgpt.com)

A Superadmin selecting a restaurant still operates through the same tenant-scoped services. Record the Superadmin as the actual actor rather than impersonating a restaurant administrator.

---

## 6. Data Representation Standards

### 6.1 Identifiers

Use `BIGINT UNSIGNED` for database identifiers.

Serialize identifiers as strings in JSON and TypeScript contracts:

```json
{
  "employeeId": "1052",
  "restaurantId": "18"
}
```

Do not convert database identifiers into JavaScript numbers.

### 6.2 Time durations

Store calculated durations as integer minutes:

```text
480 minutes = 8 hours
30 minutes = 0.5 hour
```

Do not store a working duration as a decimal value such as `8.30`.

Attendance input uses minute precision. Reject timestamps with nonzero seconds instead of silently rounding them.

### 6.3 Date and time

Use:

```text
DATE for work dates and payroll month identifiers.
DATETIME(3) for timestamps stored in UTC.
IANA time-zone names for restaurant time zones.
```

The application and database connections must use UTC for timestamps.

Schedules retain their work date and time-zone snapshot.

Attendance API values must contain an explicit UTC offset. The backend validates the supplied local time and offset against the restaurant’s time zone, including daylight-saving ambiguities. Luxon provides time-zone-aware date-time operations for this implementation. [moment.github.io](https://moment.github.io/luxon/api-docs/index.html)

An overnight shift belongs to its scheduled start work date, even if departure occurs in the next calendar month.

### 6.4 Money and rates

Use:

```text
DECIMAL(18,4) for stored monetary amounts.
DECIMAL(18,8) for rate snapshots.
DECIMAL(7,4) for percentages.
DECIMAL(7,4) for overtime multipliers.
```

The currency determines how many decimal places are posted and displayed.

Perform calculations with `decimal.js`, not ordinary floating-point arithmetic. MySQL `DECIMAL` stores exact fixed-point values, and `decimal.js` provides decimal arithmetic in the application layer. [MySQL](https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html)

Return money as strings:

```json
{
  "currency": "USD",
  "netSalary": "1076.25"
}
```

### 6.5 Record versions

Mutable records require a `row_version`.

The client supplies the version it edited. If another administrator has already changed the record, the backend rejects the stale update.

The client must not silently overwrite the newer version.

---

## 7. Database Specification

Unless stated otherwise, restaurant-owned tables contain `id`, `restaurant_id`, and creation metadata. Mutable tables additionally contain `updated_at`, `updated_by`, and `row_version`.

Historical financial results are immutable rather than updated in place.

### 7.1 Restaurants and accounts

#### `restaurants`

Stores the tenant identity.

```text
id
name
contact_name
contact_mobile
contact_email
currency_code
currency_decimal_places
timezone
status: ACTIVE | INACTIVE
payroll_start_month
created_at
updated_at
row_version
```

Currency changes are blocked after financial activity begins. Time-zone changes require an effective-date process and must not reinterpret existing timestamps.

#### `admin_accounts`

```text
id
restaurant_id: nullable for Superadmin only
account_kind: SUPERADMIN | RESTAURANT_ADMIN
full_name
email_normalized
mobile: nullable
password_hash
status: ACTIVE | INACTIVE
password_setup_required
last_login_at
created_at
updated_at
row_version
```

Enforce globally unique normalized email addresses for this initial one-restaurant-per-administrator model.

A database check must enforce that restaurant administrators have a restaurant and Superadmins do not.

#### `sessions`

```text
id
admin_account_id
token_hash
csrf_token_hash
created_at
last_seen_at
absolute_expires_at
revoked_at
```

#### `account_tokens`

```text
id
admin_account_id
purpose: PASSWORD_SETUP | PASSWORD_RESET
token_hash
expires_at
used_at
created_at
```

Tokens are single-use.

### 7.2 Configuration

#### `restaurant_policy_versions`

```text
id
restaurant_id
effective_from_month
salary_working_day_divisor
standard_daily_minutes
overtime_multiplier
late_grace_minutes
late_deduction_percentage
warning_threshold
custom_warnings_count_by_default
debt_settlement_mode: MONTHLY
carry_debt_forward: true
created_by
created_at
```

Require a unique restaurant and effective-month combination.

Resolve the applicable policy using the latest version effective on or before the payroll month.

Existing policy versions are immutable. A later policy is a new record.

Validate positive working-day divisors, positive daily minutes, nonnegative grace periods, percentages from 0 to 100, and warning thresholds of at least one.

#### `positions`

```text
id
restaurant_id
name
normalized_name
status: ACTIVE | INACTIVE
```

Position names are unique within the restaurant.

#### `deduction_types`

```text
id
restaurant_id
name
calculation_method: FIXED | DAILY_PERCENTAGE
default_value
status: ACTIVE | INACTIVE
```

Historical adjustments retain their applied values even when a deduction type changes.

#### `shift_templates`

```text
id
restaurant_id
name
status: ACTIVE | INACTIVE
```

#### `shift_template_intervals`

```text
id
restaurant_id
shift_template_id
sequence_number
start_local_time
start_day_offset
end_local_time
end_day_offset
planned_unpaid_break_minutes
```

Multiple intervals support split shifts.

Template edits do not automatically change previously generated schedules.

### 7.3 Employees and salary history

#### `employees`

```text
id
restaurant_id
employee_number
full_name
mobile
position_id
employment_start_date
employment_end_date
status: ACTIVE | INACTIVE
```

Employee numbers are unique per restaurant.

Mobile numbers should be normalized, but duplicate numbers should produce a warning rather than an automatic rejection.

#### `employee_salary_versions`

```text
id
restaurant_id
employee_id
effective_from_month
monthly_salary
reason
created_by
created_at
```

Require a unique restaurant, employee, and effective-month combination.

Salary changes do not overwrite the employee’s previous salary.

For version 1, rate changes begin at month boundaries. Partial-month employment uses an explicit base-salary adjustment rather than an unapproved proration formula.

### 7.4 Scheduling and attendance

#### `schedule_days`

One record per employee per work date.

```text
id
restaurant_id
employee_id
work_date
day_type: WORK | OFF | EXCUSED
source_template_id: nullable
policy_version_id
required_minutes
timezone_snapshot
exception_reason: nullable
```

Require:

```text
UNIQUE (restaurant_id, employee_id, work_date)
```

`required_minutes` is the dated working obligation. It is not recalculated silently from the current configuration.

#### `schedule_intervals`

```text
id
restaurant_id
employee_id
schedule_day_id
sequence_number
planned_start_at
planned_end_at
planned_unpaid_break_minutes
```

Intervals must not overlap for the same employee, including across adjacent work dates.

#### `attendance_days`

```text
id
restaurant_id
employee_id
schedule_day_id
work_date
status: NOT_RECORDED | IN_PROGRESS | COMPLETED |
        CONFIRMED_ABSENT | NEEDS_REVIEW
additional_work_approved
notes
```

Require one attendance day per employee and work date.

A missing record is not a confirmed absence.

#### `attendance_intervals`

```text
id
restaurant_id
employee_id
attendance_day_id
schedule_interval_id: nullable
sequence_number
check_in_at
check_out_at: nullable
unpaid_break_minutes
```

The association with a schedule interval determines which expected arrival is used for lateness.

The gap between split intervals is already excluded from worked time. It must not also be entered as an unpaid break.

#### `workday_exceptions`

```text
id
restaurant_id
employee_id
schedule_day_id
exception_type
required_minutes_override
related_salary_adjustment_id: nullable
reason
status: ACTIVE | VOID
created_by
created_at
```

Examples include approved reduced obligations, paid excused absence, and unpaid absence.

An unpaid-absence treatment must explicitly resolve both the salary effect and working obligation. It must not deduct the same unpaid time while also leaving that time as recoverable debt.

### 7.5 Warnings and salary adjustments

#### `warnings`

```text
id
restaurant_id
employee_id
origin: AUTOMATIC_LATE | CUSTOM
automatic_attendance_day_id: nullable
incident_date
title
reason
late_minutes: nullable
system_qualifies
counts_toward_limit
admin_voided
void_reason: nullable
voided_by: nullable
voided_at: nullable
created_by: nullable for automatic warnings
created_at
```

Place a unique constraint on:

```text
(restaurant_id, automatic_attendance_day_id)
```

Custom warnings use a null automatic-attendance reference and may have multiple records per day.

An automatic warning is valid when the attendance qualifies and it has not been manually voided.

Separating `system_qualifies` from `admin_voided` prevents recalculation from accidentally restoring a deliberately voided warning.

#### `late_penalties`

```text
id
restaurant_id
employee_id
attendance_day_id
policy_version_id
salary_version_id
qualifies
late_minutes
daily_salary_basis
deduction_percentage
calculated_amount
source_attendance_version
```

Require one late-penalty record per attendance day.

This table records the current operational result. Finalized monetary amounts come from immutable payroll lines.

Voiding a warning does not automatically remove a late penalty.

#### `salary_adjustments`

```text
id
restaurant_id
employee_id
payroll_month
work_date: nullable
category: BASE_ADJUSTMENT | ADDITION | DEDUCTION
direction: INCREASE | DECREASE
deduction_type_id: nullable
calculation_method: FIXED | DAILY_PERCENTAGE
value
reason
status: ACTIVE | VOID
created_by
created_at
```

The application derives the financial sign from category and direction. It must not accept a negative deduction and accidentally turn it into an addition.

Manual changes to base salary due must not alter the contractual salary used to calculate the reference hourly rate.

### 7.6 Working-hour debt

#### `hour_debt_sources`

Provides a stable identity for each source of debt.

```text
id
restaurant_id
employee_id
source_type: ATTENDANCE_SHORTFALL | OPENING_IMPORT
attendance_day_id: nullable
origin_work_date
imported_minutes: nullable
reason: nullable
created_at
```

An attendance source is unique per attendance day.

The table does not contain an editable running balance. Current balances come from calculations.

An opening import is used only for approved migration or initial onboarding, not as a routine way to change balances.

#### `debt_waivers`

```text
id
restaurant_id
employee_id
debt_source_id
effective_month
minutes
reason
status: ACTIVE | VOID
created_by
created_at
```

A waiver must identify the debt source it resolves.

It cannot exceed that source’s available debt. If an attendance correction makes an existing waiver invalid, the report receives a blocker rather than silently reducing the waiver.

### 7.7 Payroll and calculation history

#### `payroll_periods`

```text
id
restaurant_id
month_start
status: DRAFT | READY_FOR_REVIEW | FINALIZED | REOPENED
source_revision
current_calculation_run_id: nullable
active_finalized_run_id: nullable
finalized_by: nullable
finalized_at: nullable
```

Require one record per restaurant and month.

`source_revision` increases whenever relevant source data changes.

#### `calculation_runs`

```text
id
restaurant_id
payroll_period_id
input_revision
engine_version
input_hash
input_snapshot
status: BUILDING | COMPLETE | OBSOLETE | FAILED
created_at
completed_at
```

Retain the actual calculation inputs, not only their hash. This allows an old result to be explained and reproduced.

A completed run is immutable.

#### `payroll_employee_results`

```text
id
restaurant_id
calculation_run_id
employee_id
previous_finalized_result_id: nullable
employee_snapshot
policy_snapshot
salary_snapshot
required_minutes
worked_minutes
opening_debt_minutes
new_shortfall_minutes
waived_minutes
recovered_minutes
closing_debt_minutes
additional_minutes
eligible_overtime_minutes
base_salary_due
overtime_amount
addition_amount
late_deduction_amount
other_deduction_amount
net_salary
valid_warning_count
warning_threshold
blockers
```

Require one employee result per calculation run.

Employee snapshots preserve the name and position shown in the finalized report.

#### `payroll_daily_results`

Stores each date’s input snapshot and derived working-time result.

```text
id
restaurant_id
calculation_run_id
employee_id
attendance_day_id
work_date
planned_intervals_snapshot
actual_intervals_snapshot
required_minutes
worked_minutes
late_minutes
shortfall_minutes
additional_minutes
recovered_minutes
eligible_overtime_minutes
attendance_status
```

#### `debt_lot_results`

Stores the calculation-specific balance of each debt source.

```text
id
restaurant_id
calculation_run_id
employee_id
debt_source_id
opening_minutes
new_minutes
waived_minutes
recovered_minutes
closing_minutes
```

#### `debt_recovery_allocations`

Explains which additional working time recovered which debt.

```text
id
restaurant_id
calculation_run_id
employee_id
additional_time_daily_result_id
debt_lot_result_id
allocated_minutes
```

This table makes recovery traceable and prevents the same time from becoming both recovery and paid overtime.

#### `payroll_lines`

```text
id
restaurant_id
calculation_run_id
employee_id
line_type
source_record_id
description
quantity
rate_snapshot
signed_amount
```

Line types include base salary, overtime, late deduction, manual addition, and manual deduction.

The salary summary must equal the sum of its posted lines.

### 7.8 Operational support

#### `audit_events`

Append-only records containing the actor, restaurant, action, entity, timestamp, request ID, reason, and relevant before-and-after values.

Never include passwords or session tokens.

#### `jobs`

Contains tenant-scoped recalculation and export jobs, status, attempt count, lease expiry, deduplication key, and error information.

#### `idempotency_requests`

Contains the actor, restaurant, endpoint, idempotency key, request hash, operation status, and stored response.

#### `export_requests`

Contains the requesting account, restaurant, report filters, exact calculation-run ID, status, private storage reference, and expiry.

---

## 8. Scheduling Implementation

### 8.1 Dated schedule generation

Weekly recurrence is an input convenience, not a second schedule database.

When an administrator applies a weekly pattern to a month, the backend expands it into dated `schedule_days` and `schedule_intervals`.

Every displayed weekly or monthly view reads those same records.

### 8.2 Bulk scheduling workflow

Use two operations:

```text
Preview bulk change.
Commit the reviewed change.
```

The preview identifies employee/date combinations, existing entries, overlaps, employment-date conflicts, finalized periods, and required-hours mismatches.

The commit revalidates the preview against current record versions.

A preview is not permission to overwrite data that changed afterward.

### 8.3 Bulk request example

```json
{
  "employeeIds": ["1052", "1053", "1054"],
  "dateFrom": "2026-10-01",
  "dateTo": "2026-10-31",
  "weekdays": [1, 2, 3, 4, 5, 6],
  "shiftTemplateId": "12",
  "existingEntryPolicy": "REJECT_CONFLICTS"
}
```

Define weekdays consistently as Monday `1` through Sunday `7`.

Use atomic commits for an explicitly bounded batch. A proposed initial limit is 1,000 employee-date changes per operation.

### 8.4 Required hours

A template’s planned paid duration should match the configured daily requirement.

A shorter planned shift must not automatically reduce the required obligation. It requires an approved exception.

A longer shift can include planned additional work, but payable overtime still depends on actual work and outstanding debt.

---

## 9. Attendance Processing

### 9.1 Attendance save sequence

For every save:

```text
Authenticate and resolve tenant.
Validate employee and dated schedule.
Validate expected record version.
Lock the payroll period.
Reject changes to a finalized month.
Validate timestamps, interval overlaps, and breaks.
Save attendance.
Reevaluate automatic lateness warning and penalty.
Increment payroll source revision.
Queue recalculation in the same transaction.
Write audit event.
Commit.
```

### 9.2 Validation rules

Departure must follow arrival, and break time cannot exceed its working interval.

Intervals must not overlap, including intervals assigned to adjacent work dates.

A completed attendance record must have departure times for every working interval.

Missing attendance must remain unresolved rather than automatically becoming absence.

Attendance on an unscheduled date requires an approved dated schedule or day-off work record before salary calculation.

### 9.3 Late arrival evaluation

For each planned arrival:

```text
Late minutes =
  max(0, actual arrival - planned arrival)
```

For the daily warning and deduction:

```text
Qualifying late workday =
  at least one arrival exceeds the configured grace period
```

For split shifts, retain each arrival’s lateness, but cap the automatic late warning and deduction at one per workday.

### 9.4 Corrections

When a correction changes a late arrival into an arrival within grace, the automatic warning stops qualifying and the draft penalty is removed.

The warning’s history remains.

An attendance correction does not delete a manually issued custom warning.

---

## 10. Working-Hour Debt and Overtime Engine

### 10.1 Engine characteristics

The engine must be deterministic:

```text
Same input snapshot
+ Same engine version
= Same calculation result
```

It must calculate in integer minutes and return explicit allocations and blockers.

It must never read the current clock implicitly. An `asOf` value is supplied for draft calculations.

### 10.2 Daily calculations

For each completed and resolved workday:

```text
W = Actual worked minutes after unpaid breaks
R = Required paid minutes for the dated work obligation

Regular minutes    = min(W, R)
Shortfall minutes  = max(0, R - W)
Additional minutes = max(0, W - R)
```

Future workdays and incomplete records do not create finalized shortfalls.

They instead affect completeness indicators and finalization blockers.

### 10.3 Monthly reconciliation

```text
Debt available =
  Opening debt
  + New shortfalls
  - Approved waivers

Debt recovered =
  min(Debt available, Additional minutes)

Eligible overtime =
  Additional minutes - Debt recovered

Closing debt =
  Debt available - Debt recovered
```

Validate waivers at the individual debt-source level before applying the aggregate formulas.

### 10.4 Allocation order

Use a deterministic allocation process.

First load outstanding debt sources from the preceding finalized month. Add the current month’s shortfalls and apply valid waivers.

Order debt sources by original work date, then source ID.

Order additional-time records by work date, then record ID.

Allocate additional minutes to the oldest outstanding debt until either the debt or the additional-time pool is exhausted.

Any remaining additional minutes become eligible overtime.

Because this is monthly settlement, an allocation may connect earlier additional time to a later shortfall within the same open month. Label these as monthly settlement allocations, not as a claim that the debt existed on the earlier date.

### 10.5 Required invariants

The engine must enforce:

```text
Additional minutes =
  Recovery minutes + Eligible overtime minutes

Opening debt + New shortfalls - Waivers =
  Recovery minutes + Closing debt

No balance is negative.

No minute is allocated more than once.

A completed monthly result cannot contain
both positive eligible overtime and positive closing debt.
```

### 10.6 TypeScript contract

```typescript
type RecordId = string;
type DecimalString = string;

interface WorkdayCalculationInput {
  attendanceDayId: RecordId;
  workDate: string;
  requiredMinutes: number;
  workedMinutes: number;
  isResolved: boolean;
}

interface DebtCalculationResult {
  openingDebtMinutes: number;
  newShortfallMinutes: number;
  waivedMinutes: number;
  additionalMinutes: number;
  recoveredMinutes: number;
  eligibleOvertimeMinutes: number;
  closingDebtMinutes: number;
}
```

Only nonnegative safe integers are valid for minute values.

The service must reject unsafe totals rather than allowing integer overflow.

### 10.7 Daily examples

Assume eight required hours, a planned shift of 10:00–18:00, no unpaid breaks, and no opening debt.

| Actual attendance | Worked time | New debt | Eligible overtime |
|---|---:|---:|---:|
| 10:30–18:00 | 450 minutes | 30 minutes | 0 |
| 10:30–18:30 | 480 minutes | 0 | 0 |
| 10:30–19:00 | 510 minutes | 0 | 30 minutes |

With 60 minutes of existing debt, working ten hours against an eight-hour obligation produces:

```text
Additional time: 120 minutes
Debt recovery:    60 minutes
Eligible overtime: 60 minutes
```

### 10.8 Grace period and debt

An employee arriving eight minutes late with a ten-minute grace period receives no late penalty.

If they leave at the normal departure time and do not otherwise complete those minutes, they still have an eight-minute shortfall.

The grace period and working-hour obligation are independent rules.

---

## 11. Salary Calculation Engine

### 11.1 Reference rates

```text
Daily salary =
  Contractual monthly salary / Working-day divisor

Normal hourly rate =
  Daily salary / (Standard daily minutes / 60)

Overtime hourly rate =
  Normal hourly rate × Overtime multiplier

Overtime pay =
  Eligible overtime minutes / 60 × Overtime hourly rate
```

The overtime multiplier represents the total overtime rate.

### 11.2 Late deduction

```text
Late deduction =
  Daily salary × Late percentage / 100
```

Apply it once per qualifying late workday.

Recovering missed hours does not automatically remove this deduction or its warning.

### 11.3 Net salary

```text
Net salary =
  Base salary due
  + Overtime pay
  + Approved additions
  - Late deductions
  - Other approved deductions
```

Base salary due equals contractual salary unless an approved base adjustment applies.

Unresolved absence treatment, missing salary configuration, and ambiguous partial-month treatment produce blockers.

Do not silently clamp a negative net salary to zero. Flag it for resolution.

### 11.4 Rounding

Calculate rates at high precision.

Round posted financial lines to the configured currency precision using a documented rounding method, such as half-up.

The monthly total must sum those posted lines.

Do not calculate a report total using one rounding method while displaying line items using another.

### 11.5 Calculation example

```text
Monthly salary:              $1,040
Working-day divisor:         26
Standard daily hours:        8
Overtime multiplier:         1.5
Late deduction:              10%

Daily salary:                $40
Normal hourly rate:          $5
Overtime hourly rate:        $7.50

Opening debt:                120 minutes
New shortfalls:              210 minutes
Additional work:             780 minutes
Waivers:                     0 minutes

Debt recovered:              330 minutes
Eligible overtime:           450 minutes
Closing debt:                0 minutes

Overtime pay:                $56.25
Three late deductions:       $12
Other approved deduction:    $8

Net salary:                  $1,076.25
```

---

## 12. Payroll Recalculation, Transactions, and Finalization

### 12.1 Change detection

Any relevant attendance, schedule, salary, policy, waiver, or adjustment change increments the affected payroll period’s `source_revision`.

The current report becomes stale until a calculation run matches that revision.

Do not continue displaying an old result as current without a visible stale indicator.

### 12.2 Worker processing

The API commits the source update and recalculation job together.

The worker then captures a consistent input snapshot, records the source revision and preceding finalized result, and performs calculations outside long-running database locks.

Before publishing the result, it locks the period and verifies that the input revision and dependencies still match.

A result calculated from stale inputs is marked obsolete rather than published.

### 12.3 Locking rules

Use `SELECT ... FOR UPDATE` for payroll-period state transitions and related financial writes.

All payroll-affecting writes must follow the same locking protocol. Otherwise, a finalization transaction could miss a concurrent attendance change.

MySQL documents locking reads for this purpose. `SKIP LOCKED` may be used to claim background jobs, but not to skip financial records during payroll calculation. [MySQL](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)

Use the same `mysql2` connection throughout each transaction, with rollback and connection release on failure. Parameterize values rather than constructing SQL from user input. [Sidorares](https://sidorares.github.io/node-mysql2/docs)

### 12.4 Finalization

Finalization must verify that:

```text
The restaurant-local payroll month has ended.
All included shifts, including overnight shifts, are resolved.
There are no employee calculation blockers.
The calculation matches the latest source revision.
The preceding payroll dependency is finalized.
The expected calculation-run ID still matches.
```

The month is finalized atomically and points to one immutable calculation run.

An employee may have closing hour debt in a finalized report. Debt is carried forward rather than automatically deducted.

### 12.5 Reopening

A reopen request requires a reason.

Preserve the original finalized run and audit the action.

If later finalized months depend on the month being reopened, block the action and identify those dependencies. Reopen dependent months in reverse chronological order, then recalculate and finalize forward.

Do not silently modify later finalized results.

### 12.6 Idempotency

Require an `Idempotency-Key` for financial adjustments, custom-warning creation, bulk commits, finalization, and export creation.

For the same actor, tenant, endpoint, and key:

```text
Same request body: return the original operation result.
Different request body: return a conflict.
```

Idempotency complements, but does not replace, database uniqueness constraints.

---

## 13. API Specification

Use `/api/v1` as the API prefix.

Restaurant operations use an explicit restaurant path:

```text
/api/v1/restaurants/:restaurantId
```

The restaurant ID in the path is validated against the authenticated account.

### 13.1 Authentication

```text
POST /auth/login
POST /auth/logout
GET  /auth/me
GET  /auth/csrf
POST /auth/password-setup
POST /auth/password-reset/request
POST /auth/password-reset/complete
```

Password-reset requests should return a neutral response without confirming whether an email exists.

### 13.2 Superadmin

```text
GET   /platform/restaurants
POST  /platform/restaurants
GET   /platform/restaurants/:restaurantId
PATCH /platform/restaurants/:restaurantId
PATCH /platform/restaurants/:restaurantId/status
POST  /platform/restaurants/:restaurantId/administrators
```

Restaurant creation and first-administrator creation should be an atomic onboarding operation.

### 13.3 Restaurant administrators

Under the restaurant prefix:

```text
GET   /administrators
POST  /administrators
GET   /administrators/:administratorId
PATCH /administrators/:administratorId
PATCH /administrators/:administratorId/status
```

### 13.4 Employees

```text
GET   /employees
POST  /employees
GET   /employees/:employeeId
PATCH /employees/:employeeId
PATCH /employees/:employeeId/status

GET   /employees/:employeeId/salary-history
POST  /employees/:employeeId/salary-versions

GET   /employees/:employeeId/attendance
GET   /employees/:employeeId/warnings
GET   /employees/:employeeId/debt
GET   /employees/:employeeId/payroll-history
```

Salary changes use a separate endpoint rather than being accepted through an unrestricted employee update.

### 13.5 Configuration

```text
GET   /configuration?month=YYYY-MM
GET   /configuration/policy-history
POST  /configuration/policy-versions

GET   /positions
POST  /positions
PATCH /positions/:positionId

GET   /deduction-types
POST  /deduction-types
PATCH /deduction-types/:deductionTypeId

GET   /shift-templates
POST  /shift-templates
PATCH /shift-templates/:shiftTemplateId
```

### 13.6 Scheduling and attendance

```text
GET  /schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
POST /schedules/bulk-preview
POST /schedules/bulk-commit
PUT  /schedules/days/:scheduleDayId
POST /schedules/days/:scheduleDayId/exceptions

GET  /attendance?date=YYYY-MM-DD
PUT  /attendance/days/:attendanceDayId
POST /attendance/bulk-save
```

### 13.7 Warnings, adjustments, and debt

```text
GET  /warnings?month=YYYY-MM
POST /employees/:employeeId/warnings
POST /warnings/:warningId/void

GET  /adjustments?month=YYYY-MM
POST /employees/:employeeId/adjustments
POST /adjustments/:adjustmentId/void

GET  /debt?month=YYYY-MM
POST /employees/:employeeId/debt-waivers
POST /debt-waivers/:waiverId/void
```

There must be no endpoint that directly overwrites an employee’s debt balance.

### 13.8 Payroll and reports

```text
GET  /payroll/periods
GET  /payroll/periods/:month
POST /payroll/periods/:month/recalculate
GET  /payroll/periods/:month/blockers
POST /payroll/periods/:month/finalize
GET  /payroll/periods/:month/reopen-impact
POST /payroll/periods/:month/reopen

GET  /reports/monthly?month=YYYY-MM
GET  /reports/employees/:employeeId?month=YYYY-MM
GET  /reports/attendance?month=YYYY-MM
GET  /reports/debt?month=YYYY-MM
GET  /reports/warnings?month=YYYY-MM

POST /exports
GET  /exports/:exportId
GET  /exports/:exportId/download

GET  /jobs/:jobId
GET  /audit-events
```

### 13.9 Response conventions

Successful response:

```json
{
  "data": {
    "employeeId": "1052",
    "fullName": "Ali Hassan",
    "monthlySalary": "1040.00"
  },
  "meta": {
    "requestId": "request-reference"
  }
}
```

Error response:

```json
{
  "error": {
    "code": "PAYROLL_PERIOD_FINALIZED",
    "message": "This month is finalized and cannot be edited.",
    "details": {
      "month": "2026-09"
    }
  },
  "meta": {
    "requestId": "request-reference"
  }
}
```

Use `401` for unauthenticated requests, `403` for denied operations, `404` for inaccessible resources, `409` for business conflicts, `412` for stale record versions, and `422` for validation errors.

List endpoints require pagination and allowlisted sorting fields.

### 13.10 Attendance request example

```json
{
  "expectedVersion": 4,
  "status": "COMPLETED",
  "intervals": [
    {
      "scheduleIntervalId": "803",
      "checkInAt": "2026-09-15T10:30:00+03:00",
      "checkOutAt": "2026-09-15T19:00:00+03:00",
      "unpaidBreakMinutes": 0
    }
  ],
  "notes": "Attendance verified by administrator."
}
```

The server calculates lateness, worked minutes, debt, overtime, and deductions. These calculated fields must not be accepted from the client.

---

## 14. Frontend Specification

### 14.1 Routes

```text
/login
/password-setup
/password-reset

/platform/dashboard
/platform/restaurants
/platform/restaurants/:restaurantId

/r/:restaurantId/dashboard
/r/:restaurantId/employees
/r/:restaurantId/employees/:employeeId
/r/:restaurantId/schedules
/r/:restaurantId/attendance
/r/:restaurantId/warnings
/r/:restaurantId/reports
/r/:restaurantId/administrators
/r/:restaurantId/configuration
```

Protected routes use the authenticated account returned by `/auth/me`.

Frontend route protection improves navigation but never replaces backend authorization.

### 14.2 Dashboard

Show today’s scheduled employees, recorded arrivals, late arrivals, incomplete attendance, employees at the warning threshold, current debt, provisional overtime, and salary-report status.

Current-period financial figures must be explicitly marked provisional.

### 14.3 Employee page

Display full name, mobile, position, monthly salary, status, warning count, and outstanding debt.

Employee profile sections should cover information, salary history, schedule, attendance, warnings, debt, and payroll history.

### 14.4 Schedule page

Use a grid with employees as rows and dates as columns.

Required interactions include multi-cell selection, template application, copying a week, repeating a pattern, marking days off, and editing one date.

Keep edited values in a local draft until the administrator saves.

A bulk preview must identify overwritten entries and conflicts.

### 14.5 Attendance page

Display planned times beside editable actual times.

Calculated columns include worked time, lateness, shortfall, additional time, recovery, and provisional overtime.

Incomplete entries must be visually distinguishable from completed attendance.

If saving changes affects a warning or salary result, show the recalculated outcome returned by the API.

### 14.6 Warning indicator

Use a clickable indicator beside the name:

```text
Ali Hassan • 2/3 warnings
Ali Hassan • 3/3 warnings, limit reached
```

Render the dot in red in the actual interface, but include text and an accessible label. Do not communicate warning status through color alone.

Selecting the indicator opens the underlying warnings.

### 14.7 Reports page

Provide month and year selection, employee and position filters, status filters, and these report views:

```text
Overview
Salary summary
Attendance details
Working-hour debt
Warnings and deductions
```

Show the calculation time, revision, completeness status, and whether the report is finalized.

### 14.8 State and cache rules

Every tenant-owned query key must include the restaurant:

```typescript
[
  "restaurant",
  restaurantId,
  "employee-payroll",
  employeeId,
  month
]
```

After attendance changes, invalidate the related attendance, warning, debt, dashboard, and payroll queries.

After switching restaurants or logging out, clear sensitive cached data.

Do not persist salaries, warning details, or session credentials in browser local storage.

Use server-returned financial values rather than duplicating authoritative calculations in React.

---

## 15. Reporting and Exports

### 15.1 Monthly employee result

Every monthly employee report must expose:

```text
Employee identity and position
Contractual salary and base salary due
Daily and hourly reference rates
Scheduled and attended days
Confirmed absences and incomplete records
Required and actual minutes
Opening debt
New shortfalls
Approved waivers
Recovered minutes
Closing debt
Additional minutes before recovery
Eligible overtime
Overtime amount
Late incidents and deductions
Other additions and deductions
Warning count and threshold
Net salary
Calculation and finalization status
```

### 15.2 Example report response

```json
{
  "data": {
    "employeeId": "1052",
    "month": "2026-09",
    "currency": "USD",
    "status": "FINALIZED",
    "isProvisional": false,
    "hourDebt": {
      "openingMinutes": 120,
      "newShortfallMinutes": 210,
      "waivedMinutes": 0,
      "recoveredMinutes": 330,
      "closingMinutes": 0
    },
    "overtime": {
      "additionalMinutes": 780,
      "eligibleMinutes": 450,
      "hourlyRate": "7.50",
      "amount": "56.25"
    },
    "salary": {
      "baseDue": "1040.00",
      "additions": "0.00",
      "lateDeductions": "12.00",
      "otherDeductions": "8.00",
      "net": "1076.25"
    },
    "warnings": {
      "validCount": 4,
      "threshold": 3,
      "limitReached": true
    },
    "blockers": []
  }
}
```

### 15.3 Export consistency

Exports must reference a specific calculation-run ID.

Do not generate the summary from one revision and employee details from a newer revision.

Provide Excel exports and a printable salary statement. Files remain private, require authorization to download, and expire according to the configured retention policy.

Treat employee-entered or administrator-entered text as text cells during export, not executable spreadsheet formulas.

---

## 16. Security and Privacy Controls

Use HTTPS, secure cookies, request-size limits, rate-limited login and reset operations, and strict allowlists for writable fields.

Cookie-authenticated mutations require CSRF protection. Use a session-bound token in a custom request header and verify the request origin; `SameSite` should be additional protection rather than the only control. [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

Apply tenant authorization before returning employee data, reports, exports, or job status.

Keep MySQL on a private network. Use separate runtime and migration credentials.

The application’s audit-writing credentials should not permit ordinary modification or deletion of audit records.

Logs must exclude passwords, tokens, and unnecessary personal or salary details. Record identifiers and error codes are preferable to logging complete request bodies.

Only public configuration belongs in frontend environment variables. Vite exposes `VITE_` variables to the client bundle, so database credentials and session secrets must never use that prefix or enter the frontend build. [vitejs](https://vite.dev/guide/env-and-mode?utm_source=chatgpt.com)

---

## 17. Testing Requirements

### 17.1 Calculation tests

The engine requires unit tests for the following outcomes:

| Scenario | Expected result |
|---|---|
| Eight required hours, eight worked | No debt or overtime |
| Thirty minutes late, leaves on time | Thirty minutes of shortfall |
| Thirty minutes late, leaves thirty minutes later | Required hours completed, no overtime |
| Thirty minutes late, leaves one hour later | Thirty overtime minutes before prior-debt settlement |
| One hour of opening debt, two additional hours | One hour recovered, one hour eligible |
| Debt exceeds additional time | No overtime, positive closing debt |
| Arrival within grace but hours incomplete | No late penalty, remaining hour debt |
| Warning manually voided | Recalculation does not restore it |
| Additional time earlier in the same month | Available for monthly shortfall reconciliation |
| Approved waiver | Reduces only the identified eligible debt |
| Split shift | Gaps excluded, daily allowance applied once |
| Overnight shift | Correct duration and start-work-date attribution |
| Missing departure | Blocker, not zero worked time |
| Repeated calculation | Identical result for identical inputs |

Also test decimal rounding and currencies with different posting precision.

### 17.2 Database integration tests

Run integration tests against MySQL, not an alternative database with different locking behavior.

Test cross-restaurant relationships, duplicate attendance, automatic-warning uniqueness, foreign-key enforcement, transaction rollback, stale versions, job retries, and idempotency.

### 17.3 Concurrency tests

Explicitly test simultaneous attendance edits, attendance edits during finalization, repeated finalization, duplicate worker execution, concurrent debt waivers, and concurrent administrator deactivation.

### 17.4 Browser tests

The end-to-end suite must cover onboarding a restaurant, adding administrators, creating employees, bulk scheduling, saving attendance, issuing and voiding warnings, reviewing debt, finalizing a month, and exporting the finalized report.

A separate security suite must attempt cross-restaurant reads and writes using valid IDs belonging to another restaurant.

---

## 18. Deployment, Operations, and Delivery Requirements

### 18.1 Deployment model

Serve the compiled React application and API through the same application origin.

Run the Node.js API and worker as separate processes or containers using the same application release.

MySQL stores operational data, sessions, jobs, and financial history. Redis and Kubernetes are not required for the initial system.

Provide separate development, staging, and production environments.

### 18.2 Configuration

Backend configuration includes database credentials, application origin, cookie settings, password-token expiry, worker limits, logging level, and optional email-delivery settings.

Validate configuration at startup. Fail startup when required settings are missing.

### 18.3 Release pipeline

Every release must pass formatting, linting, TypeScript checking, unit tests, MySQL integration tests, frontend build, and migration validation.

Apply migrations using a controlled release step, not independently from every API instance.

Pin dependencies and retain the calculation-engine version in every payroll run.

### 18.4 Monitoring

Monitor API failures, slow database queries, job retries, queue age, failed calculations, blocked finalizations, authentication failures, export failures, and database capacity.

Expose separate liveness and readiness endpoints. Readiness must fail when the application cannot perform its required database operations.

### 18.5 Backups and recovery

Use encrypted backups with point-in-time recovery where supported by the selected hosting setup.

Regularly test restoration into a separate environment.

Proposed recovery targets are a maximum 15-minute data-loss window and restoration within four hours. These are acceptance targets requiring infrastructure validation, not measured guarantees.

### 18.6 Initial performance acceptance targets

For load testing, use an initial working envelope of 200 active employees per restaurant and 30 simultaneous administrator sessions across the platform.

Proposed targets are sub-second ordinary reads and writes, and a monthly calculation for one 200-employee restaurant within ten seconds under the agreed test load.

These targets must be measured before being represented as supported capacity.

---

## 19. Implementation Order and Completion Criteria

Build the platform in dependency order:

**Foundation and tenant isolation → Accounts and configuration → Employees and schedules → Attendance and warnings → Debt and payroll engine → Reports and finalization → Security and deployment validation.**

Debt reconciliation should be tested independently before being connected to final salary reporting.

The implementation is complete when:

| Requirement | Completion condition |
|---|---|
| Tenant isolation | No restaurant can read or change another restaurant’s records |
| Administrator access | Equal restaurant-admin capabilities without configurable roles |
| Scheduling | Bulk weekly and monthly planning works on one dated schedule model |
| Attendance | Planned and actual time remain separate and editable with history |
| Debt | Every shortfall, recovery, waiver, and carry-forward is traceable |
| Overtime | Only additional time remaining after debt settlement is payable |
| Warnings | Automatic and custom warnings persist with correct threshold indicators |
| Salary | Every amount can be traced to its inputs and posted calculation lines |
| Corrections | No duplicate penalties or silent historical changes |
| Finalization | One protected, reproducible calculation run per finalized month |
| Reporting | On-screen details and exports use the same calculation revision |
| Operations | Deployment, backup restoration, and concurrency tests pass |

**The defining technical invariant is that each worked minute has one financial treatment: it completes the current obligation, recovers owed time, or becomes eligible overtime. It must never be counted in more than one of those categories.**