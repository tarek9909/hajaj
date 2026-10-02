# Restaurant Workforce and Salary Management System
## Business Architecture and Requirements Document

**Document scope:** Business structure, responsibilities, operational processes, calculation rules, reporting, and business controls.

---

## 1. Business Purpose

The system will allow a Superadmin to manage multiple restaurants through one platform. Each restaurant will operate its own employee-management workspace, with its own administrators, employees, schedules, attendance records, salary settings, deductions, and warnings.

The system’s primary purpose is to connect four activities:

**Planning employee schedules → Recording actual attendance → Evaluating working hours and conduct → Preparing monthly salary reports.**

Restaurant administrators will enter and maintain operational information. The system will calculate the resulting working hours, outstanding hour debt, eligible overtime, salary deductions, warnings, and monthly salary amounts.

### Governing overtime rule

**An employee must complete the required working hours and clear any outstanding working-hour debt before additional time becomes payable overtime.**

Additional time spent recovering missing hours is **debt recovery**, not overtime.

Lateness penalties and warnings remain separate from working-hour recovery. Making up missing hours does not automatically cancel the original late arrival, its warning, or its applicable deduction.

---

## 2. Business Structure and Responsibilities

### 2.1 Superadmin

The Superadmin controls the overall platform.

The Superadmin can create restaurants, update restaurant information, activate or deactivate restaurants, establish the first administrator account for each restaurant, and access restaurant information for oversight and support.

The Superadmin dashboard should provide an overview of restaurant activity and allow the Superadmin to enter a selected restaurant’s workspace.

Financial totals across restaurants must remain separated by currency unless a separate currency-conversion policy is introduced.

### 2.2 Restaurant Administrators

Each restaurant can have multiple administrators.

**All active administrators within the same restaurant have equal access.** There are no custom roles, permission groups, or administrator levels.

Every active restaurant administrator can:

| Business area | Administrator responsibility |
|---|---|
| Administrators | Add administrators and manage their active/inactive status |
| Configuration | Maintain the restaurant’s operational and salary rules |
| Employees | Create and maintain employee records |
| Scheduling | Assign, copy, and update employee schedules |
| Attendance | Enter and correct arrival, departure, and break information |
| Working-hour debt | Review outstanding hours and record justified waivers |
| Warnings | Review automatic warnings and issue custom warnings |
| Salary adjustments | Record authorized manual deductions or adjustments |
| Reporting | Review, export, finalize, and reopen monthly reports |

Because there are no differentiated permissions, **every restaurant administrator can view employee salaries and warnings**.

An administrator cannot access another restaurant’s information or grant access to another restaurant.

### 2.3 Employees

Employees are managed staff records. They do not require login accounts in the initial system.

Administrators maintain their information, schedules, attendance, salaries, and warnings.

An employee’s position, such as Chef or Waiter, is an employment classification. It does not grant access to the system.

### 2.4 Account and Restaurant Status

| Record | Active | Inactive |
|---|---|---|
| Restaurant | Its administrators can operate the restaurant workspace | Operational access is suspended; historical information remains |
| Administrator | Can access the assigned restaurant | Cannot access the restaurant, including through an existing session |
| Employee | Available for ongoing scheduling and attendance | Removed from routine future scheduling; historical records remain |

The system must prevent a restaurant from deactivating its last active administrator without Superadmin intervention.

Deactivation must never erase salary, attendance, or warning history.

---

## 3. Business Scope

### 3.1 Included

The initial system includes restaurant management, administrator management, employee records, restaurant configuration, weekly and monthly scheduling, manual attendance entry, working-hour debt tracking, overtime calculations, late deductions, automatic and custom warnings, monthly salary reporting, and change history.

### 3.2 Outside the Initial Scope

The initial system does not include employee self-service, biometric attendance, automatic location tracking, restaurant ordering, stock management, recruitment, statutory tax calculations, bank payments, or a complete leave-management system.

Salary reports calculate amounts for review. **Finalizing a report does not mean that salaries have been paid.**

SMS and WhatsApp warning notifications are also outside the initial scope. Warnings are recorded and displayed inside the system.

### 3.3 Business Policy Approval

Before operational use, each restaurant must approve its salary, deduction, overtime, and working-hour recovery policies and obtain appropriate local review.

This document defines the proposed business behavior. It does not establish jurisdiction-specific payroll or employment compliance.

---

## 4. Proposed Business Defaults

The following defaults complete areas that were not explicitly specified. They form the baseline for this architecture rather than previously confirmed restaurant policies.

| Policy area | Proposed baseline |
|---|---|
| Salary reporting period | Calendar month |
| Working-hour debt settlement | Reconciled across the payroll month |
| Unrecovered hour debt | Carried forward until recovered or explicitly waived |
| Overtime during an open month | Provisional until monthly reconciliation |
| Lateness grace period | Affects warnings and penalties, not required working hours |
| Late deduction | One configured percentage of daily salary per qualifying late workday |
| Automatic late warnings | Maximum of one per qualifying workday |
| Warning counting period | Calendar month |
| Custom warnings | Count toward the warning threshold by default |
| Warning threshold consequence | Visible flag only, with no additional automatic punishment |
| Unresolved attendance | Prevents finalization of the affected employee’s salary |
| Outstanding hour debt | Does not automatically create an additional financial deduction |

### Important consequence of monthly reconciliation

Under this proposed baseline, extra hours recorded earlier in an open month can be used to cover a shortfall recorded later in the same month.

For example, an employee may initially show two provisional overtime hours. If a later day creates one hour of debt, only one overtime hour remains eligible at month-end.

**Finalized overtime from a closed month is not automatically reversed because of a new shortfall in a later month.**

---

## 5. Business Navigation

### Superadmin Workspace

| Page | Purpose |
|---|---|
| Dashboard | Overview of restaurants and platform activity |
| Restaurants | Create, access, update, activate, or deactivate restaurants |

### Restaurant Workspace

| Page | Purpose |
|---|---|
| Dashboard | Today’s workforce activity and outstanding issues |
| Employees | Staff information and individual histories |
| Schedules | Weekly and monthly planning |
| Attendance | Daily arrival, departure, and break entry |
| Warnings | Automatic and custom warning management |
| Reports | Monthly attendance, hour debt, deductions, and salary results |
| Administrators | Restaurant administrator accounts and statuses |
| Configuration | Restaurant-specific rules and reusable options |

Working-hour debt should appear within employee profiles, attendance details, and reports. It does not require a separate main navigation tab.

---

## 6. Restaurant Configuration

Each restaurant maintains its own configuration. Changes in one restaurant must not affect another.

### 6.1 General and Salary Settings

| Setting | Business purpose |
|---|---|
| Restaurant name and contact details | Identify the restaurant |
| Currency | Define salary and financial reporting currency |
| Time zone | Establish the local time used for attendance and schedules |
| Salary working-day divisor | Calculate daily salary from monthly salary |
| Standard paid working hours per day | Establish the normal daily working obligation |
| Overtime multiplier | Calculate the rate for eligible overtime |
| Break treatment | Define which breaks are unpaid and excluded from worked time |

For example, a restaurant may use a 26-day salary divisor, eight standard paid hours per day, and a 1.5 overtime multiplier.

The working-day divisor is a salary-calculation setting. It must not change automatically because a particular month contains a different number of scheduled workdays.

### 6.2 Positions

The restaurant can maintain positions such as Waiter, Cashier, Chef, Cleaner, and Supervisor.

Each position has a name and active/inactive status.

Only active positions are available for new employee assignments. Deactivating a position does not remove it from historical employee records or reports.

### 6.3 Shift Templates

Shift templates make scheduling faster.

Each template includes its name, planned start, planned end, unpaid break allowance, and whether the shift ends on the following day.

Examples:

| Shift | Planned time | Unpaid break | Planned paid duration |
|---|---|---:|---:|
| Morning | 10:00–18:00 | None | 8 hours |
| Extended daytime | 09:00–18:00 | 1 hour | 8 hours |
| Evening | 18:00–02:00 next day | None | 8 hours |

The system should flag templates that do not match the restaurant’s normal working-hour requirement.

A shorter planned shift must not silently reduce the employee’s required hours. A reduced obligation must be explicitly recorded as an approved exception.

A longer planned shift can indicate planned additional work, but overtime still depends on actual attendance and outstanding debt.

### 6.4 Lateness Settings

| Setting | Business purpose |
|---|---|
| Grace period in minutes | Define the permitted delay before a late violation |
| Late deduction percentage | Define the deduction as a percentage of daily salary |
| Automatic warning rule | Generate a warning when lateness exceeds the grace period |
| Warning threshold | Define when an employee reaches the warning limit |
| Warning counting period | Define the period used to count warnings |

The boundary must be precise.

With a ten-minute grace period and a 10:00 start, arrival at **10:10 is within grace**. Arrival at **10:11 triggers the lateness rule**.

### 6.5 Other Deduction Types

The restaurant can configure named deduction types using a fixed amount or a percentage of daily salary.

Each type should have a name, calculation method, default value, and active/inactive status.

Applying a deduction to an employee requires a reason. A deduction type does not automatically apply merely because it exists in configuration.

### 6.6 Configuration Changes

Pay-affecting settings should normally become effective at the beginning of a specified payroll month.

Historical reports must retain the settings used to calculate them. Updating a multiplier or deduction percentage must not silently rewrite a finalized report.

Operational changes, such as adding a new position, can take effect immediately without altering historical records.

---

## 7. Employee Management

### 7.1 Employee Information

Each employee record must contain:

| Field | Requirement |
|---|---|
| Employee reference | Unique identifier within the restaurant |
| Full name | Required |
| Mobile number | Required |
| Position | Selected from active configured positions |
| Monthly salary | Required for salary calculations |
| Employment start date | Required |
| Employment end date | Recorded when applicable |
| Status | Active or inactive |

The employee’s contractual monthly salary determines the reference daily and hourly rates.

A separately approved reduction in the base salary payable for a partial month must not cause those reference rates to be prorated a second time.

### 7.2 Employee Profile

The employee profile should present personal and employment information, current salary, assigned schedule, attendance history, outstanding working-hour debt, warnings, deductions, and monthly salary history.

It should also provide the actions **Edit Employee**, **Assign Schedule**, **Add Warning**, and **Add Salary Adjustment**.

### 7.3 Employee Deactivation

Deactivation stops routine future scheduling but preserves the employee in all relevant historical reports.

Deactivation does not automatically clear outstanding hour debt, remove warnings, or complete the employee’s final salary calculation.

Outstanding items must be reviewed explicitly.

---

## 8. Schedule Management

### 8.1 Schedule Structure

The schedule records what each employee is expected to work on each date.

Each scheduled workday includes the employee, work date, assigned shift or time intervals, planned breaks, and any approved adjustment to the normal working-hour obligation.

Weekly and monthly views must display the same underlying schedule.

### 8.2 Bulk Scheduling Experience

The main scheduling interface should use employees as rows and dates as columns.

Administrators should be able to select multiple employees and dates, apply a shift template, repeat a weekly pattern, copy a previous week, and mark days off.

For example, an administrator can select six waiters, apply the Morning shift from Monday to Saturday, repeat the pattern throughout the month, and mark Sundays off.

Individual dates can then be changed without replacing the entire pattern.

Bulk updates should show the affected employees and dates before saving. Existing exceptions must not be silently overwritten.

### 8.3 Split and Overnight Shifts

Overnight shifts must include the correct departure date. The shift-start date should be used as the work date for reporting.

Split shifts should be represented as separate working intervals.

For example, 10:00–14:00 and 18:00–22:00 represent eight working hours. The four-hour gap is not counted as work.

The normal daily working-hour allowance applies once to the workday, not once to each interval.

### 8.4 Schedule Changes

Future schedules can be changed normally.

Changes to a date with attendance must identify that recalculation may be required. Changes affecting finalized salary records require reopening or an explicit adjustment process.

---

## 9. Daily Attendance Management

### 9.1 Daily Attendance Page

The administrator selects a date and sees the employees scheduled for that day.

The planned schedule appears automatically. The administrator enters actual arrival, actual departure, unpaid breaks, and any relevant note.

The system then shows worked time, lateness, shortfall, additional time, debt recovery, provisional overtime, warnings, and deductions.

### 9.2 Attendance Statuses

| Status | Meaning |
|---|---|
| Not recorded | No attendance information has been entered |
| In progress | Arrival is recorded, but the workday is not complete |
| Completed | Required attendance information is available |
| Confirmed absent | An administrator has explicitly recorded absence |
| Excused or adjusted | An approved exception affects the expected obligation |
| Needs review | Information is incomplete, conflicting, or requires a decision |

“Late” is an additional attendance flag, not a replacement for these statuses.

An employee can therefore be **Completed and Late**.

### 9.3 Calculation Timing

A late warning and its applicable deduction can be identified once arrival is recorded.

Final worked time, hour shortfall, and additional time should only be established when the workday is complete.

Missing departure information must not be treated as zero hours worked.

Future scheduled days must not create hour debt before they occur.

### 9.4 Attendance Integrity

Repeatedly saving the same record must not create duplicate warnings, deductions, or hour debt.

Corrections must update the related calculations and preserve the reason and history of the change.

---

## 10. Working-Hour Debt and Overtime

### 10.1 Business Definitions

| Term | Definition |
|---|---|
| Required working hours | Paid working time the employee is expected to complete |
| Actual worked hours | Recorded work duration after unpaid breaks |
| Working-hour shortfall | Required time not completed on a workday |
| Outstanding hour debt | Unrecovered shortfall carried within or between periods |
| Additional worked hours | Actual time above the current day’s required obligation |
| Debt-recovery hours | Additional time allocated to cover outstanding debt |
| Eligible overtime | Additional time remaining after debt is settled |

### 10.2 Daily Working-Hour Evaluation

**Actual worked hours = Actual working intervals − Unpaid breaks**

**Daily shortfall = Required working hours − Actual worked hours**, with a minimum of zero.

**Daily additional hours = Actual worked hours − Required working hours**, with a minimum of zero.

An employee who arrives late does not automatically finish the day with debt. They may complete the required hours by leaving later.

The actual completed working duration determines the final shortfall.

### 10.3 Allocation Order

Recorded work must be considered in the following order:

**Current required hours → Outstanding hour debt → Eligible overtime.**

A minute of work cannot be counted as both debt recovery and payable overtime.

### 10.4 Same-Day Examples

Assume an eight-hour obligation, a planned shift of 10:00–18:00, no unpaid breaks, and no opening debt.

| Actual attendance | Worked time | Shortfall remaining | Eligible overtime |
|---|---:|---:|---:|
| 10:30–18:00 | 7.5 hours | 0.5 hour | None |
| 10:30–18:30 | 8 hours | None | None |
| 10:30–19:00 | 8.5 hours | None | 0.5 hour |

In the second example, the extra 30 minutes after the planned departure compensate for the late arrival. They are not overtime.

In the third example, the first 30 minutes after the planned departure complete the normal obligation. Only the following 30 minutes qualify as overtime.

### 10.5 Recovering Previous Debt

Assume an employee starts the day with one outstanding hour of debt.

They are required to work eight hours and actually work ten.

| Allocation | Hours |
|---|---:|
| Complete today’s obligation | 8 |
| Recover previous debt | 1 |
| Eligible overtime | 1 |
| Closing debt | 0 |

The employee worked two additional hours, but only one is payable as overtime.

### 10.6 Monthly Reconciliation

For the proposed monthly-settlement model:

**Debt to settle = Opening debt + New shortfalls − Approved debt waivers**

**Debt recovered = The smaller of debt to settle and total additional hours**

**Eligible overtime = Total additional hours − Debt recovered**

**Closing debt = Debt to settle − Debt recovered**

All values must remain non-negative. A waiver cannot exceed the debt it is intended to resolve.

Unrecovered closing debt becomes the next month’s opening debt.

### 10.7 Grace Period Does Not Waive Required Hours

Suppose the grace period is ten minutes.

An employee arrives eight minutes late and leaves at the normal departure time.

The employee receives no late warning or late deduction, but still has an eight-minute working-hour shortfall unless the time is made up or explicitly waived.

**Being within grace prevents the lateness penalty. It does not shorten the working day.**

### 10.8 Debt Waivers

An administrator may waive identified debt for an approved business reason.

The waiver must record the employee, affected hours, reason, administrator, and date.

Debt must not disappear because the employee becomes inactive, the calendar changes, or an administrator edits a displayed balance.

### 10.9 Approved Work on a Day Off

Under the proposed baseline, approved work on a scheduled day off has no normal duty obligation for that date.

The recorded hours first settle outstanding debt. Any remaining hours become eligible overtime.

Separate rest-day or holiday premium rules are not included unless explicitly added.

---

## 11. Salary and Lateness Calculations

### 11.1 Salary Rates

**Daily salary = Contractual monthly salary ÷ Configured working-day divisor**

**Normal hourly rate = Daily salary ÷ Standard paid hours per day**

**Overtime hourly rate = Normal hourly rate × Overtime multiplier**

**Overtime pay = Eligible overtime hours × Overtime hourly rate**

The multiplier represents the total rate for an overtime hour.

For example, 1.5× means one and a half times the normal hourly rate.

### 11.2 Lateness Measurement

**Late minutes = Actual arrival − Planned arrival**, with a minimum of zero.

A qualifying late incident occurs when late minutes exceed the configured grace period.

For split shifts, lateness can be evaluated against each scheduled arrival. Under the initial daily policy, the automatic warning and deduction are capped at one per workday.

### 11.3 Late Deduction

**Late deduction = Daily salary × Configured late-deduction percentage**

This is a fixed percentage per qualifying late workday, not a per-minute calculation.

Therefore, with the same daily salary and percentage, a 15-minute late arrival and a 30-minute late arrival produce the same deduction.

Tiered or per-minute penalties require a separate business rule.

### 11.4 Separation of Consequences

A qualifying late arrival can create three separate outcomes:

| Outcome | What it represents |
|---|---|
| Working-hour debt | Required working time that remains incomplete |
| Late deduction | The configured financial consequence of the late incident |
| Warning | The recorded attendance incident |

The employee may clear the working-hour debt while the warning and late deduction remain valid.

However, the system must not automatically add another deduction for missing minutes on top of the configured lateness penalty.

### 11.5 Monthly Salary Result

**Calculated net salary = Base salary due + Overtime pay + Approved additions − Late deductions − Other approved deductions**

For a full month without an approved base adjustment, base salary due equals the employee’s contractual monthly salary.

Partial-month employment, unpaid absence, and other base adjustments require an explicit approved treatment.

Time already removed from the paid working obligation through an unpaid-absence adjustment should not simultaneously remain as recoverable hour debt.

---

## 12. Warning Management

### 12.1 Automatic Warnings

A qualifying late arrival creates an automatic warning linked to the attendance record.

The warning should show the employee, work date, planned arrival, actual arrival, late minutes, applied grace period, reason, and related deduction.

Warnings must remain available in the employee’s history.

### 12.2 Custom Warnings

Administrators can select **Actions → Add Warning** from an employee row or profile.

A custom warning requires a title, incident date, and reason. Optional notes can provide supporting context.

A custom warning contributes to the warning count according to the restaurant’s configuration.

It does not automatically create a salary deduction or working-hour debt.

### 12.3 Warning Threshold

The threshold should be expressed as:

**“Flag employee at ___ warnings.”**

If the value is three, the limit is reached when the employee has three valid warnings within the counting period.

The threshold applies separately to each employee.

### 12.4 Red-Dot Indicator

The employee’s name should display a red dot when the employee has at least one valid warning within the applicable counting period.

Examples:

**Ali Hassan 🔴 1/3 warnings**

**Ali Hassan 🔴 3/3 warnings · Limit reached**

Selecting the indicator opens the underlying warning details.

Current operational pages use the current warning period. Historical reports use the period being reviewed.

### 12.5 Warning Validity

Warnings can be valid or voided.

A voided warning requires a reason and no longer contributes to the threshold, but remains visible in history.

Completing owed hours does not void a warning. Acknowledging a warning also does not remove it from the count.

Reaching the threshold creates a visible management flag only. It does not automatically trigger suspension, another deduction, or dismissal.

---

## 13. Monthly Salary Review and Finalization

The monthly process follows:

**Review attendance → Resolve exceptions → Reconcile hour debt → Review earnings and deductions → Finalize the report.**

### 13.1 Report Statuses

| Status | Business meaning |
|---|---|
| Draft | Attendance or calculations remain open |
| Ready for review | Required information is complete and calculations are available |
| Finalized | The month’s approved results are protected from ordinary changes |
| Reopened | A finalized period has been explicitly reopened for correction |

All active restaurant administrators can perform these actions. There is no separate approval role.

### 13.2 Finalization Conditions

Before an employee’s salary is finalized, attendance must be complete, absences and partial-month situations must be resolved, hour debt must be reconciled, and salary adjustments must have reasons.

A final report may include closing hour debt. Finalization does not require every employee’s debt to be zero.

### 13.3 Reopening and Corrections

Reopening requires a reason.

A change affecting a previous closing debt may also affect later months’ opening balances. Those consequences must be shown for review rather than silently changing later finalized reports.

The system must preserve the original finalized result and the subsequent correction history.

---

## 14. Reports and Required Information

The Reports page must filter by **month and year**.

Additional filters should include employee, position, employee status, attendance completeness, warning-limit status, outstanding debt, and report status.

The Superadmin can also filter by restaurant.

### 14.1 Monthly Overview

The overview should display:

| Area | Summary information |
|---|---|
| Workforce | Employees included, scheduled workdays, attended days, confirmed absences |
| Attendance quality | Missing entries and unresolved records |
| Working time | Required hours, actual worked hours, additional hours |
| Hour debt | Opening debt, new shortfalls, recovered hours, waived hours, closing debt |
| Overtime | Eligible overtime hours and overtime amount |
| Lateness | Qualifying late workdays and recorded late minutes |
| Warnings | Automatic warnings, custom warnings, employees at the threshold |
| Salary | Base salary due, additions, deductions, calculated net salary |

Open-month results must be labelled **Draft** or **Month-to-date**.

Projected full-month salary must not be presented as a finalized amount.

### 14.2 Employee Monthly Summary

There should be one row per employee, with expandable details.

| Data group | Required information |
|---|---|
| Identity | Employee reference, full name, position, employment status |
| Salary basis | Contractual monthly salary, base salary due, daily rate, hourly rate |
| Attendance | Scheduled days, attended days, absences, days off, incomplete records |
| Working time | Required hours and actual worked hours |
| Hour debt | Opening balance, new shortfalls, recovery, waivers, closing balance |
| Additional time | Total additional hours before debt recovery |
| Overtime | Eligible hours, multiplier, applicable rate, amount |
| Lateness | Qualifying incidents and late minutes |
| Deductions | Late deductions, other deductions, total deductions |
| Warnings | Automatic count, custom count, valid total, threshold status |
| Final result | Calculated net salary and report status |

Employees who worked during the selected month must remain included even if they are now inactive.

### 14.3 Daily Attendance Detail

The employee’s daily breakdown must show the work date, planned working intervals, actual intervals, unpaid breaks, required hours, worked hours, lateness, shortfall, additional time, warnings, and deductions.

Where daily debt recovery and overtime allocations are displayed during an open month, they must be identified as provisional.

The detail should also show who entered the record and the most recent correction.

### 14.4 Working-Hour Debt Detail

This view must explain where the employee’s debt came from and how it changed.

It should show the source workday, shortfall created, recovery allocated, waiver where applicable, remaining balance, and whether the balance originated in a previous month.

An administrator must be able to distinguish **hours owed**, **hours recovered**, and **hours paid as overtime** without manually reconstructing the calculation.

### 14.5 Warning and Deduction Detail

Warnings should show their type, date, reason, source, validity, counting-period treatment, and related attendance.

Deductions should show their type, reason, date, fixed amount or percentage, calculation basis, final amount, and issuing administrator or automatic source.

### 14.6 Exports

The reporting function should provide an Excel export and a printable employee salary statement.

Exports must reflect the selected filters and indicate whether the figures are draft or finalized.

---

## 15. Complete Monthly Example

Assume the following employee and configuration:

| Item | Value |
|---|---:|
| Monthly salary | $1,040 |
| Working-day divisor | 26 |
| Standard paid daily hours | 8 |
| Overtime multiplier | 1.5 |
| Late deduction percentage | 10% |
| Warning threshold | 3 |

The resulting rates are:

**Daily salary: $40**

**Normal hourly rate: $5**

**Overtime hourly rate: $7.50**

During the month, the employee has:

| Monthly activity | Value |
|---|---:|
| Opening hour debt | 2 hours |
| New working-hour shortfalls | 3.5 hours |
| Total additional worked hours | 13 hours |
| Approved debt waivers | None |
| Qualifying late incidents | 3 |
| Custom warnings | 1 |
| Other approved deduction | $8 |

### Working-Hour Reconciliation

| Calculation | Result |
|---|---:|
| Total debt to settle | 2 + 3.5 = 5.5 hours |
| Additional hours used for recovery | 5.5 hours |
| Eligible overtime | 13 − 5.5 = 7.5 hours |
| Closing debt | 0 hours |
| Overtime pay | 7.5 × $7.50 = $56.25 |

**Although the employee worked 13 additional hours, only 7.5 hours are payable overtime. The remaining 5.5 hours recover owed working time.**

### Salary Calculation

| Component | Amount |
|---|---:|
| Base salary due | $1,040.00 |
| Overtime pay | +$56.25 |
| Late deductions: 3 × 10% × $40 | −$12.00 |
| Other approved deduction | −$8.00 |
| **Calculated net salary** | **$1,076.25** |

### Warning Result

Three automatic warnings plus one custom warning produce four valid warnings.

The employee appears as:

**Ali Hassan 🔴 4/3 warnings · Limit reached**

Clearing all hour debt does not remove those warnings or the $12 late deduction.

---

## 16. Exception Handling and Business Controls

| Situation | Required treatment |
|---|---|
| Arrival or departure is missing | Mark for review; do not assume absence or zero worked hours |
| Employee arrives within grace but works fewer required hours | No late penalty; remaining shortfall becomes debt |
| Employee arrives late but completes the required hours | Apply qualifying warning and deduction; no remaining same-day debt |
| Employee has prior debt and works additional hours | Recover debt before allocating overtime |
| Attendance is corrected | Recalculate related results without duplication |
| Automatic warning was caused by incorrect attendance | Void or revise the warning and associated deduction, preserving history |
| Employee works on an approved day off | Apply the documented day-off rule, including debt recovery first |
| Employee joins or leaves mid-month | Require approved base-salary treatment before finalization |
| Confirmed unpaid absence | Resolve its salary and working-hour treatment explicitly |
| Employee becomes inactive with debt | Preserve the balance for settlement review |
| Salary settings change | Apply the effective-period rules; preserve historical calculations |
| Warning threshold is reached | Show the limit flag; do not invent another consequence |

Time calculations should use minutes, allowing partial-hour recovery and overtime.

Monetary amounts should follow the restaurant currency’s precision. Report totals must sum the same monetary amounts shown in their supporting detail.

---

## 17. Business Records and Accountability

The system must retain restaurant information, administrator records, employee and salary history, configuration history, assigned schedules, actual attendance, working-hour debt movements, warnings, salary adjustments, monthly results, and change history.

Every record belongs to a specific restaurant.

Financial results should be traceable to the attendance, rule, or adjustment that produced them.

### Required Change History

For material changes, the system should retain who performed the action, when it occurred, what changed, and the reason where required.

This includes attendance corrections, schedule changes affecting completed work, debt waivers, manual deductions, warning cancellations, configuration changes, administrator deactivation, and report reopening.

Historical business records should not disappear through ordinary deletion.

---

## 18. Business Acceptance Criteria

The system is ready for business acceptance when the following outcomes are demonstrated:

| Area | Acceptance requirement |
|---|---|
| Restaurant separation | Administrators can only access their own restaurant |
| Administrator model | All active restaurant administrators have equal capabilities |
| Bulk scheduling | Multiple employees and dates can be scheduled without repetitive individual entry |
| Attendance | Planned and actual working times remain separate |
| Same-day recovery | Time used to complete the normal obligation is not overtime |
| Outstanding debt | Additional time settles existing debt before becoming payable overtime |
| Monthly reconciliation | Final overtime reflects the full month’s shortfalls and additional hours |
| Debt continuity | Unrecovered debt carries forward or is explicitly waived |
| Lateness | Grace-period boundaries and daily deduction rules operate consistently |
| Warnings | Automatic and custom warnings persist and display the correct red-dot count |
| Corrections | Repeated saves and edits do not duplicate financial or warning consequences |
| Salary reporting | Each result can be traced to rates, attendance, debt recovery, and adjustments |
| Historical integrity | Finalized reports do not change silently |
| Exceptions | Incomplete attendance and unresolved salary situations remain visible before finalization |

### Final Business Principle

**The system must distinguish attendance compliance from working-time fulfillment and salary payment.**

An employee may be late, receive a warning, recover the missed hours, and later earn overtime. Each outcome must be recorded separately, with overtime becoming payable only after the required work and outstanding hour debt have been covered.