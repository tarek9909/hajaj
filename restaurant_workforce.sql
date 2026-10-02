-- Restaurant Workforce: initial schema, MySQL 8.4.
-- Run once against a new database. This script does not drop existing data.
-- Every application connection must also set time_zone = '+00:00'.
-- Durations are minutes; money is DECIMAL; IDs are returned as strings by the API.
-- No login credentials or example restaurant records are seeded.

CREATE DATABASE restaurant_workforce
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE restaurant_workforce;
SET NAMES utf8mb4;
SET SESSION time_zone = '+00:00';
SET SESSION sql_mode =
  'STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- 1. Restaurants and authentication

CREATE TABLE restaurants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200),
  contact_mobile VARCHAR(30),
  contact_email VARCHAR(254),
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency_decimal_places TINYINT UNSIGNED NOT NULL DEFAULT 2,
  timezone VARCHAR(64) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  payroll_start_month DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_restaurant_status (status, name),
  CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CHECK (currency_decimal_places BETWEEN 0 AND 4),
  CHECK (DAYOFMONTH(payroll_start_month) = 1),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE admin_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED,
  account_kind ENUM('SUPERADMIN','RESTAURANT_ADMIN') NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  email_normalized VARCHAR(254) COLLATE utf8mb4_0900_as_cs NOT NULL,
  mobile VARCHAR(30),
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin,
  password_setup_required BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  last_login_at DATETIME(3),
  created_by BIGINT UNSIGNED,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_email (email_normalized),
  KEY ix_admin_restaurant_status (restaurant_id, status),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK ((account_kind = 'SUPERADMIN' AND restaurant_id IS NULL)
      OR (account_kind = 'RESTAURANT_ADMIN' AND restaurant_id IS NOT NULL)),
  CHECK (password_setup_required IN (0,1)),
  CHECK (password_setup_required = 1 OR password_hash IS NOT NULL),
  CHECK (email_normalized = LOWER(TRIM(email_normalized))),
  CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_account_id BIGINT UNSIGNED NOT NULL,
  token_hash BINARY(32) NOT NULL,
  csrf_token_hash BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  idle_expires_at DATETIME(3) NOT NULL,
  absolute_expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (token_hash),
  KEY ix_session_account (admin_account_id, revoked_at),
  KEY ix_session_expiry (absolute_expires_at),
  FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at)
) ENGINE=InnoDB;

CREATE TABLE account_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_account_id BIGINT UNSIGNED NOT NULL,
  purpose ENUM('PASSWORD_SETUP','PASSWORD_RESET') NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_token (token_hash),
  KEY ix_account_token_expiry (expires_at),
  FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id),
  CHECK (expires_at > created_at)
) ENGINE=InnoDB;

-- 2. Versioned configuration and employees
-- Corrections use a higher revision_no, not UPDATE of an earlier version.

CREATE TABLE restaurant_policy_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  effective_from_month DATE NOT NULL,
  revision_no INT UNSIGNED NOT NULL DEFAULT 1,
  salary_working_day_divisor SMALLINT UNSIGNED NOT NULL,
  standard_daily_minutes SMALLINT UNSIGNED NOT NULL,
  overtime_multiplier DECIMAL(7,4) NOT NULL,
  late_grace_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  late_deduction_percentage DECIMAL(7,4) NOT NULL DEFAULT 0,
  warning_threshold SMALLINT UNSIGNED NOT NULL,
  warning_counting_period ENUM('CALENDAR_MONTH') NOT NULL DEFAULT 'CALENDAR_MONTH',
  custom_warnings_count_by_default BOOLEAN NOT NULL DEFAULT TRUE,
  debt_settlement_mode ENUM('MONTHLY') NOT NULL DEFAULT 'MONTHLY',
  carry_debt_forward BOOLEAN NOT NULL DEFAULT TRUE,
  reason VARCHAR(500) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_policy_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_policy_revision (restaurant_id, effective_from_month, revision_no),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  CHECK (DAYOFMONTH(effective_from_month) = 1),
  CHECK (revision_no > 0),
  CHECK (salary_working_day_divisor BETWEEN 1 AND 31),
  CHECK (standard_daily_minutes BETWEEN 1 AND 1440),
  CHECK (overtime_multiplier >= 1),
  CHECK (late_grace_minutes <= 1440),
  CHECK (late_deduction_percentage BETWEEN 0 AND 100),
  CHECK (warning_threshold > 0),
  CHECK (custom_warnings_count_by_default IN (0,1)),
  CHECK (carry_debt_forward = 1),
  CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB;

CREATE TABLE positions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_position_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_position_name (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE deduction_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  calculation_method ENUM('FIXED','DAILY_PERCENTAGE') NOT NULL,
  default_value DECIMAL(18,4) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deduction_type_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_deduction_type_name (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (default_value >= 0),
  CHECK (calculation_method <> 'DAILY_PERCENTAGE' OR default_value <= 100),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE shift_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_template_name (restaurant_id, name),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE shift_template_intervals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  shift_template_id BIGINT UNSIGNED NOT NULL,
  sequence_number SMALLINT UNSIGNED NOT NULL,
  start_local_time TIME NOT NULL,
  start_day_offset TINYINT UNSIGNED NOT NULL DEFAULT 0,
  end_local_time TIME NOT NULL,
  end_day_offset TINYINT UNSIGNED NOT NULL DEFAULT 0,
  planned_unpaid_break_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_interval (restaurant_id, shift_template_id, sequence_number),
  FOREIGN KEY (restaurant_id, shift_template_id) REFERENCES shift_templates (restaurant_id, id),
  CHECK (sequence_number > 0),
  CHECK (start_local_time >= '00:00:00' AND start_local_time < '24:00:00'),
  CHECK (end_local_time >= '00:00:00' AND end_local_time < '24:00:00'),
  CHECK (SECOND(start_local_time) = 0 AND SECOND(end_local_time) = 0),
  CHECK (start_day_offset <= 1 AND end_day_offset <= 1),
  CHECK (end_day_offset * 86400 + TIME_TO_SEC(end_local_time)
       > start_day_offset * 86400 + TIME_TO_SEC(start_local_time)),
  CHECK (planned_unpaid_break_minutes * 60
       < end_day_offset * 86400 + TIME_TO_SEC(end_local_time)
         - start_day_offset * 86400 - TIME_TO_SEC(start_local_time))
) ENGINE=InnoDB;

CREATE TABLE employees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_number VARCHAR(50) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  mobile VARCHAR(30) NOT NULL,
  position_id BIGINT UNSIGNED NOT NULL,
  employment_start_date DATE NOT NULL,
  employment_end_date DATE,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_employee_number (restaurant_id, employee_number),
  KEY ix_employee_list (restaurant_id, status, full_name),
  KEY ix_employee_mobile (restaurant_id, mobile),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (restaurant_id, position_id) REFERENCES positions (restaurant_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (employment_end_date IS NULL OR employment_end_date >= employment_start_date),
  CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
  CHECK (CHAR_LENGTH(TRIM(mobile)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE employee_salary_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  effective_from_month DATE NOT NULL,
  revision_no INT UNSIGNED NOT NULL DEFAULT 1,
  monthly_salary DECIMAL(18,4) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_salary_employee_id (restaurant_id, employee_id, id),
  UNIQUE KEY uq_salary_revision (restaurant_id, employee_id, effective_from_month, revision_no),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  CHECK (DAYOFMONTH(effective_from_month) = 1),
  CHECK (revision_no > 0),
  CHECK (monthly_salary >= 0),
  CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB;

-- 3. Payroll periods, dated schedules, and attendance

CREATE TABLE payroll_periods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  month_start DATE NOT NULL,
  status ENUM('DRAFT','READY_FOR_REVIEW','FINALIZED','REOPENED') NOT NULL DEFAULT 'DRAFT',
  source_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  current_calculation_run_id BIGINT UNSIGNED,
  active_finalized_run_id BIGINT UNSIGNED,
  finalized_by BIGINT UNSIGNED,
  finalized_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_period_month (restaurant_id, month_start),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (finalized_by) REFERENCES admin_accounts (id),
  CHECK (DAYOFMONTH(month_start) = 1),
  CHECK (source_revision > 0 AND row_version > 0),
  CHECK ((status = 'FINALIZED' AND active_finalized_run_id IS NOT NULL
          AND current_calculation_run_id IS NOT NULL
          AND current_calculation_run_id = active_finalized_run_id
          AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL)
      OR (status <> 'FINALIZED' AND active_finalized_run_id IS NULL
          AND finalized_by IS NULL AND finalized_at IS NULL))
) ENGINE=InnoDB;

CREATE TABLE schedule_days (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  payroll_month DATE NOT NULL,
  day_type ENUM('WORK','OFF','EXCUSED') NOT NULL,
  source_template_id BIGINT UNSIGNED,
  policy_version_id BIGINT UNSIGNED NOT NULL,
  required_minutes SMALLINT UNSIGNED NOT NULL,
  timezone_snapshot VARCHAR(64) NOT NULL,
  exception_reason VARCHAR(500),
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedule_employee_date (restaurant_id, employee_id, work_date),
  UNIQUE KEY uq_schedule_employee_id (restaurant_id, employee_id, id),
  UNIQUE KEY uq_schedule_identity_date (restaurant_id, employee_id, id, work_date),
  KEY ix_schedule_calendar (restaurant_id, work_date, employee_id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (restaurant_id, payroll_month) REFERENCES payroll_periods (restaurant_id, month_start),
  FOREIGN KEY (restaurant_id, policy_version_id) REFERENCES restaurant_policy_versions (restaurant_id, id),
  FOREIGN KEY (restaurant_id, source_template_id) REFERENCES shift_templates (restaurant_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (work_date >= payroll_month AND work_date < DATE_ADD(payroll_month, INTERVAL 1 MONTH)),
  CHECK (required_minutes <= 1440),
  CHECK ((day_type = 'WORK' AND required_minutes > 0)
      OR (day_type IN ('OFF','EXCUSED') AND required_minutes = 0)),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE schedule_intervals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  schedule_day_id BIGINT UNSIGNED NOT NULL,
  sequence_number SMALLINT UNSIGNED NOT NULL,
  planned_start_at DATETIME(3) NOT NULL,
  planned_end_at DATETIME(3) NOT NULL,
  planned_unpaid_break_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedule_interval_sequence (restaurant_id, schedule_day_id, sequence_number),
  UNIQUE KEY uq_schedule_interval_context (restaurant_id, employee_id, schedule_day_id, id),
  KEY ix_schedule_overlap (restaurant_id, employee_id, planned_start_at, planned_end_at),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id)
    REFERENCES schedule_days (restaurant_id, employee_id, id),
  CHECK (sequence_number > 0),
  CHECK (planned_end_at > planned_start_at),
  CHECK (SECOND(planned_start_at) = 0 AND MICROSECOND(planned_start_at) = 0),
  CHECK (SECOND(planned_end_at) = 0 AND MICROSECOND(planned_end_at) = 0),
  CHECK (planned_unpaid_break_minutes < TIMESTAMPDIFF(MINUTE, planned_start_at, planned_end_at))
) ENGINE=InnoDB;

CREATE TABLE attendance_days (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  schedule_day_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  status ENUM('NOT_RECORDED','IN_PROGRESS','COMPLETED','CONFIRMED_ABSENT','EXCUSED','NEEDS_REVIEW')
    NOT NULL DEFAULT 'NOT_RECORDED',
  additional_work_approved BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_date (restaurant_id, employee_id, work_date),
  UNIQUE KEY uq_attendance_employee_id (restaurant_id, employee_id, id),
  UNIQUE KEY uq_attendance_schedule_context (restaurant_id, employee_id, schedule_day_id, id),
  UNIQUE KEY uq_attendance_identity_date (restaurant_id, employee_id, id, work_date),
  KEY ix_attendance_daily (restaurant_id, work_date, status),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id, work_date)
    REFERENCES schedule_days (restaurant_id, employee_id, id, work_date),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  CHECK (additional_work_approved IN (0,1)),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE attendance_intervals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  schedule_day_id BIGINT UNSIGNED NOT NULL,
  attendance_day_id BIGINT UNSIGNED NOT NULL,
  schedule_interval_id BIGINT UNSIGNED,
  sequence_number SMALLINT UNSIGNED NOT NULL,
  check_in_at DATETIME(3) NOT NULL,
  check_out_at DATETIME(3),
  unpaid_break_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_interval_sequence (restaurant_id, attendance_day_id, sequence_number),
  KEY ix_attendance_overlap (restaurant_id, employee_id, check_in_at, check_out_at),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id, attendance_day_id)
    REFERENCES attendance_days (restaurant_id, employee_id, schedule_day_id, id),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id, schedule_interval_id)
    REFERENCES schedule_intervals (restaurant_id, employee_id, schedule_day_id, id),
  CHECK (sequence_number > 0),
  CHECK (check_out_at IS NULL OR check_out_at > check_in_at),
  CHECK (SECOND(check_in_at) = 0 AND MICROSECOND(check_in_at) = 0),
  CHECK (check_out_at IS NULL OR (SECOND(check_out_at) = 0 AND MICROSECOND(check_out_at) = 0)),
  CHECK (check_out_at IS NULL OR unpaid_break_minutes <= TIMESTAMPDIFF(MINUTE, check_in_at, check_out_at))
) ENGINE=InnoDB;

-- 4. Warnings, deductions, and workday exceptions

CREATE TABLE warnings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  origin ENUM('AUTOMATIC_LATE','CUSTOM') NOT NULL,
  automatic_attendance_day_id BIGINT UNSIGNED,
  incident_date DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  late_minutes INT UNSIGNED,
  system_qualifies BOOLEAN NOT NULL DEFAULT TRUE,
  counts_toward_limit BOOLEAN NOT NULL DEFAULT TRUE,
  admin_voided BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason VARCHAR(500),
  voided_by BIGINT UNSIGNED,
  voided_at DATETIME(3),
  created_by BIGINT UNSIGNED,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warning_employee_id (restaurant_id, employee_id, id),
  UNIQUE KEY uq_automatic_warning (restaurant_id, automatic_attendance_day_id),
  KEY ix_warning_month (restaurant_id, incident_date, employee_id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id, automatic_attendance_day_id, incident_date)
    REFERENCES attendance_days (restaurant_id, employee_id, id, work_date),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (voided_by) REFERENCES admin_accounts (id),
  CHECK ((origin = 'AUTOMATIC_LATE' AND automatic_attendance_day_id IS NOT NULL AND late_minutes IS NOT NULL)
      OR (origin = 'CUSTOM' AND automatic_attendance_day_id IS NULL AND late_minutes IS NULL
          AND created_by IS NOT NULL AND system_qualifies = 1)),
  CHECK (system_qualifies IN (0,1) AND counts_toward_limit IN (0,1) AND admin_voided IN (0,1)),
  CHECK ((admin_voided = 0 AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
      OR (admin_voided = 1 AND void_reason IS NOT NULL AND CHAR_LENGTH(TRIM(void_reason)) > 0
          AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK (CHAR_LENGTH(TRIM(title)) > 0 AND CHAR_LENGTH(TRIM(reason)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE late_penalties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  attendance_day_id BIGINT UNSIGNED NOT NULL,
  policy_version_id BIGINT UNSIGNED NOT NULL,
  salary_version_id BIGINT UNSIGNED NOT NULL,
  qualifies BOOLEAN NOT NULL,
  late_minutes INT UNSIGNED NOT NULL,
  daily_salary_basis DECIMAL(18,8) NOT NULL,
  deduction_percentage DECIMAL(7,4) NOT NULL,
  calculated_amount DECIMAL(18,4) NOT NULL,
  source_attendance_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_penalty_day (restaurant_id, attendance_day_id),
  UNIQUE KEY uq_penalty_employee_id (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, employee_id, attendance_day_id)
    REFERENCES attendance_days (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, policy_version_id) REFERENCES restaurant_policy_versions (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id, salary_version_id)
    REFERENCES employee_salary_versions (restaurant_id, employee_id, id),
  CHECK (qualifies IN (0,1)),
  CHECK (daily_salary_basis >= 0 AND calculated_amount >= 0),
  CHECK (deduction_percentage BETWEEN 0 AND 100),
  CHECK (qualifies = 1 OR calculated_amount = 0),
  CHECK (source_attendance_version > 0)
) ENGINE=InnoDB;

CREATE TABLE salary_adjustments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  payroll_month DATE NOT NULL,
  work_date DATE,
  category ENUM('BASE_ADJUSTMENT','ADDITION','DEDUCTION') NOT NULL,
  direction ENUM('INCREASE','DECREASE') NOT NULL,
  deduction_type_id BIGINT UNSIGNED,
  calculation_method ENUM('FIXED','DAILY_PERCENTAGE') NOT NULL,
  adjustment_value DECIMAL(18,4) NOT NULL,
  reason TEXT NOT NULL,
  status ENUM('ACTIVE','VOID') NOT NULL DEFAULT 'ACTIVE',
  void_reason VARCHAR(500),
  voided_by BIGINT UNSIGNED,
  voided_at DATETIME(3),
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_adjustment_employee_id (restaurant_id, employee_id, id),
  KEY ix_adjustment_month (restaurant_id, payroll_month, employee_id, status),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (restaurant_id, payroll_month) REFERENCES payroll_periods (restaurant_id, month_start),
  FOREIGN KEY (restaurant_id, deduction_type_id) REFERENCES deduction_types (restaurant_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (voided_by) REFERENCES admin_accounts (id),
  CHECK (adjustment_value > 0),
  CHECK (calculation_method <> 'DAILY_PERCENTAGE' OR adjustment_value <= 100),
  CHECK ((category = 'ADDITION' AND direction = 'INCREASE')
      OR (category = 'DEDUCTION' AND direction = 'DECREASE') OR category = 'BASE_ADJUSTMENT'),
  CHECK (deduction_type_id IS NULL OR category = 'DEDUCTION'),
  CHECK ((status = 'ACTIVE' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
      OR (status = 'VOID' AND void_reason IS NOT NULL AND CHAR_LENGTH(TRIM(void_reason)) > 0
          AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

CREATE TABLE workday_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  schedule_day_id BIGINT UNSIGNED NOT NULL,
  exception_type ENUM('REDUCED_OBLIGATION','PAID_EXCUSED','UNPAID_ABSENCE') NOT NULL,
  required_minutes_override SMALLINT UNSIGNED NOT NULL,
  related_salary_adjustment_id BIGINT UNSIGNED,
  reason TEXT NOT NULL,
  status ENUM('ACTIVE','VOID') NOT NULL DEFAULT 'ACTIVE',
  void_reason VARCHAR(500),
  voided_by BIGINT UNSIGNED,
  voided_at DATETIME(3),
  active_schedule_day_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN schedule_day_id ELSE NULL END) STORED,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_active_workday_exception (restaurant_id, active_schedule_day_id),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id)
    REFERENCES schedule_days (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, employee_id, related_salary_adjustment_id)
    REFERENCES salary_adjustments (restaurant_id, employee_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (voided_by) REFERENCES admin_accounts (id),
  CHECK (required_minutes_override <= 1440),
  CHECK ((exception_type = 'REDUCED_OBLIGATION')
      OR (exception_type = 'PAID_EXCUSED' AND required_minutes_override = 0)
      OR (exception_type = 'UNPAID_ABSENCE' AND required_minutes_override = 0
          AND related_salary_adjustment_id IS NOT NULL)),
  CHECK ((status = 'ACTIVE' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
      OR (status = 'VOID' AND void_reason IS NOT NULL AND CHAR_LENGTH(TRIM(void_reason)) > 0
          AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

-- 5. Hour-debt sources and explicit waivers

CREATE TABLE hour_debt_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  source_type ENUM('ATTENDANCE_SHORTFALL','OPENING_IMPORT') NOT NULL,
  attendance_day_id BIGINT UNSIGNED,
  origin_work_date DATE NOT NULL,
  opening_month DATE,
  imported_minutes INT UNSIGNED,
  import_reference VARCHAR(120) COLLATE utf8mb4_0900_as_cs,
  reason TEXT,
  created_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_debt_source_employee_id (restaurant_id, employee_id, id),
  UNIQUE KEY uq_debt_source_attendance (restaurant_id, attendance_day_id),
  UNIQUE KEY uq_debt_import_reference (restaurant_id, import_reference),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id, attendance_day_id, origin_work_date)
    REFERENCES attendance_days (restaurant_id, employee_id, id, work_date),
  FOREIGN KEY (restaurant_id, opening_month) REFERENCES payroll_periods (restaurant_id, month_start),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  CHECK ((source_type = 'ATTENDANCE_SHORTFALL' AND attendance_day_id IS NOT NULL
          AND opening_month IS NULL AND imported_minutes IS NULL AND import_reference IS NULL)
      OR (source_type = 'OPENING_IMPORT' AND attendance_day_id IS NULL
          AND opening_month IS NOT NULL AND imported_minutes IS NOT NULL AND imported_minutes > 0
          AND import_reference IS NOT NULL AND reason IS NOT NULL
          AND CHAR_LENGTH(TRIM(reason)) > 0 AND created_by IS NOT NULL))
) ENGINE=InnoDB;

CREATE TABLE debt_waivers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  debt_source_id BIGINT UNSIGNED NOT NULL,
  effective_month DATE NOT NULL,
  minutes INT UNSIGNED NOT NULL,
  reason TEXT NOT NULL,
  status ENUM('ACTIVE','VOID') NOT NULL DEFAULT 'ACTIVE',
  void_reason VARCHAR(500),
  voided_by BIGINT UNSIGNED,
  voided_at DATETIME(3),
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_waiver_source_context (restaurant_id, employee_id, debt_source_id, id),
  KEY ix_waiver_month (restaurant_id, effective_month, employee_id, status),
  FOREIGN KEY (restaurant_id, employee_id, debt_source_id)
    REFERENCES hour_debt_sources (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, effective_month) REFERENCES payroll_periods (restaurant_id, month_start),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (updated_by) REFERENCES admin_accounts (id),
  FOREIGN KEY (voided_by) REFERENCES admin_accounts (id),
  CHECK (minutes > 0),
  CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CHECK ((status = 'ACTIVE' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
      OR (status = 'VOID' AND void_reason IS NOT NULL AND CHAR_LENGTH(TRIM(void_reason)) > 0
          AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK (row_version > 0)
) ENGINE=InnoDB;

-- 6. Immutable calculation runs and payroll snapshots

CREATE TABLE calculation_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  payroll_period_id BIGINT UNSIGNED NOT NULL,
  previous_payroll_period_id BIGINT UNSIGNED,
  previous_finalized_run_id BIGINT UNSIGNED,
  input_revision BIGINT UNSIGNED NOT NULL,
  engine_version VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_hash BINARY(32) NOT NULL,
  input_snapshot JSON NOT NULL,
  as_of_at DATETIME(3) NOT NULL,
  status ENUM('BUILDING','COMPLETE','OBSOLETE','FAILED') NOT NULL DEFAULT 'BUILDING',
  error_text TEXT,
  created_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_run_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_run_period_id (restaurant_id, payroll_period_id, id),
  KEY ix_run_revision (restaurant_id, payroll_period_id, input_revision),
  FOREIGN KEY (restaurant_id, payroll_period_id) REFERENCES payroll_periods (restaurant_id, id),
  FOREIGN KEY (restaurant_id, previous_payroll_period_id, previous_finalized_run_id)
    REFERENCES calculation_runs (restaurant_id, payroll_period_id, id),
  FOREIGN KEY (created_by) REFERENCES admin_accounts (id),
  CHECK ((previous_payroll_period_id IS NULL AND previous_finalized_run_id IS NULL)
      OR (previous_payroll_period_id IS NOT NULL AND previous_finalized_run_id IS NOT NULL)),
  CHECK (input_revision > 0),
  CHECK (JSON_TYPE(input_snapshot) = 'OBJECT'),
  CHECK ((status = 'BUILDING' AND completed_at IS NULL)
      OR (status <> 'BUILDING' AND completed_at IS NOT NULL))
) ENGINE=InnoDB;

ALTER TABLE payroll_periods
  ADD CONSTRAINT fk_period_current_run
    FOREIGN KEY (restaurant_id, id, current_calculation_run_id)
    REFERENCES calculation_runs (restaurant_id, payroll_period_id, id),
  ADD CONSTRAINT fk_period_final_run
    FOREIGN KEY (restaurant_id, id, active_finalized_run_id)
    REFERENCES calculation_runs (restaurant_id, payroll_period_id, id);

CREATE TABLE payroll_employee_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  previous_finalized_result_id BIGINT UNSIGNED,
  policy_version_id BIGINT UNSIGNED,
  salary_version_id BIGINT UNSIGNED,
  employee_number_snapshot VARCHAR(50) NOT NULL,
  full_name_snapshot VARCHAR(200) NOT NULL,
  position_name_snapshot VARCHAR(120) NOT NULL,
  employee_snapshot JSON NOT NULL,
  policy_snapshot JSON NOT NULL,
  salary_snapshot JSON NOT NULL,
  currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency_decimal_places TINYINT UNSIGNED NOT NULL,
  contractual_monthly_salary DECIMAL(18,4),
  daily_rate DECIMAL(18,8),
  hourly_rate DECIMAL(18,8),
  overtime_hourly_rate DECIMAL(18,8),
  scheduled_days SMALLINT UNSIGNED NOT NULL,
  attended_days SMALLINT UNSIGNED NOT NULL,
  absent_days SMALLINT UNSIGNED NOT NULL,
  days_off SMALLINT UNSIGNED NOT NULL,
  incomplete_days SMALLINT UNSIGNED NOT NULL,
  required_minutes INT UNSIGNED NOT NULL,
  resolved_required_minutes INT UNSIGNED NOT NULL,
  worked_minutes INT UNSIGNED NOT NULL,
  regular_minutes INT UNSIGNED NOT NULL,
  opening_debt_minutes INT UNSIGNED NOT NULL,
  new_shortfall_minutes INT UNSIGNED NOT NULL,
  waived_minutes INT UNSIGNED NOT NULL,
  recovered_minutes INT UNSIGNED NOT NULL,
  closing_debt_minutes INT UNSIGNED NOT NULL,
  additional_minutes INT UNSIGNED NOT NULL,
  eligible_overtime_minutes INT UNSIGNED NOT NULL,
  late_incident_count SMALLINT UNSIGNED NOT NULL,
  late_minutes INT UNSIGNED NOT NULL,
  automatic_warning_count SMALLINT UNSIGNED NOT NULL,
  custom_warning_count SMALLINT UNSIGNED NOT NULL,
  valid_warning_count SMALLINT UNSIGNED NOT NULL,
  counted_warning_count SMALLINT UNSIGNED NOT NULL,
  warning_threshold SMALLINT UNSIGNED,
  base_salary_due DECIMAL(18,4),
  overtime_amount DECIMAL(18,4),
  addition_amount DECIMAL(18,4),
  late_deduction_amount DECIMAL(18,4),
  other_deduction_amount DECIMAL(18,4),
  net_salary DECIMAL(18,4),
  blockers JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_result_run (restaurant_id, calculation_run_id, employee_id),
  UNIQUE KEY uq_employee_result_identity (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id) REFERENCES calculation_runs (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id, previous_finalized_result_id)
    REFERENCES payroll_employee_results (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, policy_version_id) REFERENCES restaurant_policy_versions (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id, salary_version_id)
    REFERENCES employee_salary_versions (restaurant_id, employee_id, id),
  CHECK (currency_decimal_places BETWEEN 0 AND 4),
  CHECK (contractual_monthly_salary >= 0 AND daily_rate >= 0 AND hourly_rate >= 0 AND overtime_hourly_rate >= 0),
  CHECK (resolved_required_minutes <= required_minutes),
  CHECK (worked_minutes = regular_minutes + additional_minutes),
  CHECK (resolved_required_minutes = regular_minutes + new_shortfall_minutes),
  CHECK (additional_minutes = recovered_minutes + eligible_overtime_minutes),
  CHECK (opening_debt_minutes + new_shortfall_minutes = waived_minutes + recovered_minutes + closing_debt_minutes),
  CHECK (eligible_overtime_minutes = 0 OR closing_debt_minutes = 0),
  CHECK (valid_warning_count = automatic_warning_count + custom_warning_count),
  CHECK (counted_warning_count <= valid_warning_count AND warning_threshold > 0),
  CHECK (overtime_amount >= 0 AND addition_amount >= 0 AND late_deduction_amount >= 0 AND other_deduction_amount >= 0),
  CHECK (net_salary = base_salary_due + overtime_amount + addition_amount - late_deduction_amount - other_deduction_amount),
  CHECK (JSON_LENGTH(blockers) > 0 OR (policy_version_id IS NOT NULL AND salary_version_id IS NOT NULL
         AND contractual_monthly_salary IS NOT NULL AND daily_rate IS NOT NULL AND hourly_rate IS NOT NULL
         AND overtime_hourly_rate IS NOT NULL AND warning_threshold IS NOT NULL
         AND base_salary_due IS NOT NULL AND base_salary_due >= 0 AND overtime_amount IS NOT NULL
         AND addition_amount IS NOT NULL AND late_deduction_amount IS NOT NULL
         AND other_deduction_amount IS NOT NULL AND net_salary IS NOT NULL AND net_salary >= 0
         AND incomplete_days = 0)),
  CHECK (JSON_TYPE(employee_snapshot) = 'OBJECT' AND JSON_TYPE(policy_snapshot) = 'OBJECT'
         AND JSON_TYPE(salary_snapshot) = 'OBJECT' AND JSON_TYPE(blockers) = 'ARRAY')
) ENGINE=InnoDB;

CREATE TABLE payroll_daily_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  schedule_day_id BIGINT UNSIGNED NOT NULL,
  attendance_day_id BIGINT UNSIGNED,
  work_date DATE NOT NULL,
  planned_intervals_snapshot JSON NOT NULL,
  actual_intervals_snapshot JSON NOT NULL,
  attendance_status ENUM('OFF','NOT_RECORDED','IN_PROGRESS','COMPLETED','CONFIRMED_ABSENT','EXCUSED','NEEDS_REVIEW') NOT NULL,
  is_resolved BOOLEAN NOT NULL,
  required_minutes SMALLINT UNSIGNED NOT NULL,
  worked_minutes INT UNSIGNED,
  regular_minutes INT UNSIGNED,
  late_minutes INT UNSIGNED,
  shortfall_minutes INT UNSIGNED,
  additional_minutes INT UNSIGNED,
  recovered_minutes INT UNSIGNED,
  eligible_overtime_minutes INT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_result_date (restaurant_id, calculation_run_id, employee_id, work_date),
  UNIQUE KEY uq_daily_result_context (restaurant_id, calculation_run_id, employee_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id)
    REFERENCES payroll_employee_results (restaurant_id, calculation_run_id, employee_id),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id, work_date)
    REFERENCES schedule_days (restaurant_id, employee_id, id, work_date),
  FOREIGN KEY (restaurant_id, employee_id, schedule_day_id, attendance_day_id)
    REFERENCES attendance_days (restaurant_id, employee_id, schedule_day_id, id),
  CHECK (is_resolved IN (0,1)),
  CHECK (required_minutes <= 1440),
  CHECK ((is_resolved = 0 AND worked_minutes IS NULL AND regular_minutes IS NULL
          AND shortfall_minutes IS NULL AND additional_minutes IS NULL
          AND recovered_minutes IS NULL AND eligible_overtime_minutes IS NULL)
      OR (is_resolved = 1 AND worked_minutes IS NOT NULL AND regular_minutes IS NOT NULL
          AND shortfall_minutes IS NOT NULL AND additional_minutes IS NOT NULL
          AND recovered_minutes IS NOT NULL AND eligible_overtime_minutes IS NOT NULL)),
  CHECK (worked_minutes = regular_minutes + additional_minutes),
  CHECK (required_minutes = regular_minutes + shortfall_minutes),
  CHECK (shortfall_minutes = 0 OR additional_minutes = 0),
  CHECK (additional_minutes = recovered_minutes + eligible_overtime_minutes),
  CHECK (JSON_TYPE(planned_intervals_snapshot) = 'ARRAY' AND JSON_TYPE(actual_intervals_snapshot) = 'ARRAY')
) ENGINE=InnoDB;

CREATE TABLE debt_lot_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  debt_source_id BIGINT UNSIGNED NOT NULL,
  source_snapshot JSON NOT NULL,
  opening_minutes INT UNSIGNED NOT NULL,
  new_minutes INT UNSIGNED NOT NULL,
  waived_minutes INT UNSIGNED NOT NULL,
  recovered_minutes INT UNSIGNED NOT NULL,
  closing_minutes INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_debt_lot_source (restaurant_id, calculation_run_id, employee_id, debt_source_id),
  UNIQUE KEY uq_debt_lot_context (restaurant_id, calculation_run_id, employee_id, id),
  UNIQUE KEY uq_debt_lot_source_context (restaurant_id, calculation_run_id, employee_id, debt_source_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id)
    REFERENCES payroll_employee_results (restaurant_id, calculation_run_id, employee_id),
  FOREIGN KEY (restaurant_id, employee_id, debt_source_id)
    REFERENCES hour_debt_sources (restaurant_id, employee_id, id),
  CHECK (opening_minutes + new_minutes = waived_minutes + recovered_minutes + closing_minutes),
  CHECK (JSON_TYPE(source_snapshot) = 'OBJECT')
) ENGINE=InnoDB;

CREATE TABLE debt_recovery_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  additional_time_daily_result_id BIGINT UNSIGNED NOT NULL,
  debt_lot_result_id BIGINT UNSIGNED NOT NULL,
  allocated_minutes INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_pair (restaurant_id, calculation_run_id, additional_time_daily_result_id, debt_lot_result_id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id, additional_time_daily_result_id)
    REFERENCES payroll_daily_results (restaurant_id, calculation_run_id, employee_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id, debt_lot_result_id)
    REFERENCES debt_lot_results (restaurant_id, calculation_run_id, employee_id, id),
  CHECK (allocated_minutes > 0)
) ENGINE=InnoDB;

CREATE TABLE debt_waiver_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  debt_source_id BIGINT UNSIGNED NOT NULL,
  debt_waiver_id BIGINT UNSIGNED NOT NULL,
  debt_lot_result_id BIGINT UNSIGNED NOT NULL,
  applied_minutes INT UNSIGNED NOT NULL,
  waiver_snapshot JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_waiver_application (restaurant_id, calculation_run_id, debt_waiver_id),
  FOREIGN KEY (restaurant_id, employee_id, debt_source_id, debt_waiver_id)
    REFERENCES debt_waivers (restaurant_id, employee_id, debt_source_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id, debt_source_id, debt_lot_result_id)
    REFERENCES debt_lot_results (restaurant_id, calculation_run_id, employee_id, debt_source_id, id),
  CHECK (applied_minutes > 0),
  CHECK (JSON_TYPE(waiver_snapshot) = 'OBJECT')
) ENGINE=InnoDB;

CREATE TABLE payroll_warning_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  warning_id BIGINT UNSIGNED NOT NULL,
  origin ENUM('AUTOMATIC_LATE','CUSTOM') NOT NULL,
  incident_date DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  reason TEXT NOT NULL,
  late_minutes INT UNSIGNED,
  is_valid BOOLEAN NOT NULL,
  counts_toward_limit BOOLEAN NOT NULL,
  warning_snapshot JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warning_result (restaurant_id, calculation_run_id, warning_id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id)
    REFERENCES payroll_employee_results (restaurant_id, calculation_run_id, employee_id),
  FOREIGN KEY (restaurant_id, employee_id, warning_id)
    REFERENCES warnings (restaurant_id, employee_id, id),
  CHECK (is_valid IN (0,1) AND counts_toward_limit IN (0,1)),
  CHECK (JSON_TYPE(warning_snapshot) = 'OBJECT')
) ENGINE=InnoDB;

CREATE TABLE payroll_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  line_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  line_type ENUM('BASE_SALARY','BASE_ADJUSTMENT','OVERTIME','LATE_DEDUCTION','ADDITION','OTHER_DEDUCTION') NOT NULL,
  salary_adjustment_id BIGINT UNSIGNED,
  late_penalty_id BIGINT UNSIGNED,
  payroll_daily_result_id BIGINT UNSIGNED,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(18,8) NOT NULL,
  unit ENUM('MONTH','DAY','HOUR','ITEM') NOT NULL,
  rate_snapshot DECIMAL(18,8) NOT NULL,
  signed_amount DECIMAL(18,4) NOT NULL,
  source_snapshot JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_line_key (restaurant_id, calculation_run_id, employee_id, line_key),
  UNIQUE KEY uq_line_adjustment (restaurant_id, calculation_run_id, salary_adjustment_id),
  UNIQUE KEY uq_line_penalty (restaurant_id, calculation_run_id, late_penalty_id),
  UNIQUE KEY uq_line_overtime_day (restaurant_id, calculation_run_id, payroll_daily_result_id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id)
    REFERENCES payroll_employee_results (restaurant_id, calculation_run_id, employee_id),
  FOREIGN KEY (restaurant_id, employee_id, salary_adjustment_id)
    REFERENCES salary_adjustments (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, employee_id, late_penalty_id)
    REFERENCES late_penalties (restaurant_id, employee_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id, payroll_daily_result_id)
    REFERENCES payroll_daily_results (restaurant_id, calculation_run_id, employee_id, id),
  CHECK ((line_type = 'BASE_SALARY' AND line_key = 'BASE'
          AND salary_adjustment_id IS NULL AND late_penalty_id IS NULL AND payroll_daily_result_id IS NULL)
      OR (line_type = 'OVERTIME' AND payroll_daily_result_id IS NOT NULL
          AND salary_adjustment_id IS NULL AND late_penalty_id IS NULL)
      OR (line_type = 'LATE_DEDUCTION' AND late_penalty_id IS NOT NULL
          AND salary_adjustment_id IS NULL AND payroll_daily_result_id IS NULL)
      OR (line_type IN ('BASE_ADJUSTMENT','ADDITION','OTHER_DEDUCTION') AND salary_adjustment_id IS NOT NULL
          AND late_penalty_id IS NULL AND payroll_daily_result_id IS NULL)),
  CHECK ((line_type IN ('BASE_SALARY','OVERTIME','ADDITION') AND signed_amount >= 0)
      OR (line_type IN ('LATE_DEDUCTION','OTHER_DEDUCTION') AND signed_amount <= 0)
      OR line_type = 'BASE_ADJUSTMENT'),
  CHECK (quantity >= 0 AND rate_snapshot >= 0),
  CHECK (JSON_TYPE(source_snapshot) = 'OBJECT')
) ENGINE=InnoDB;

-- 7. Payroll state history, audit, jobs, and exports

CREATE TABLE payroll_period_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  payroll_period_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED,
  event_type ENUM('CALCULATED','FINALIZED','REOPENED') NOT NULL,
  actor_id BIGINT UNSIGNED,
  reason TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_period_event_history (restaurant_id, payroll_period_id, id),
  FOREIGN KEY (restaurant_id, payroll_period_id) REFERENCES payroll_periods (restaurant_id, id),
  FOREIGN KEY (restaurant_id, payroll_period_id, calculation_run_id)
    REFERENCES calculation_runs (restaurant_id, payroll_period_id, id),
  FOREIGN KEY (actor_id) REFERENCES admin_accounts (id),
  CHECK (event_type <> 'REOPENED' OR (reason IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0)),
  CHECK (event_type = 'CALCULATED' OR actor_id IS NOT NULL),
  CHECK (calculation_run_id IS NOT NULL)
) ENGINE=InnoDB;

CREATE TABLE audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED,
  actor_id BIGINT UNSIGNED,
  actor_kind ENUM('SUPERADMIN','RESTAURANT_ADMIN','SYSTEM') NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  reason TEXT,
  before_values JSON,
  after_values JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_restaurant_time (restaurant_id, created_at, id),
  KEY ix_audit_entity (restaurant_id, entity_type, entity_id, id),
  KEY ix_audit_actor (actor_id, created_at),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (actor_id) REFERENCES admin_accounts (id),
  CHECK ((actor_kind = 'SYSTEM' AND actor_id IS NULL)
      OR (actor_kind <> 'SYSTEM' AND actor_id IS NOT NULL)),
  CHECK (actor_kind <> 'RESTAURANT_ADMIN' OR restaurant_id IS NOT NULL)
) ENGINE=InnoDB;

CREATE TABLE jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED,
  job_type ENUM('PAYROLL_RECALCULATE','REPORT_EXPORT','ACCOUNT_EMAIL') NOT NULL,
  deduplication_hash BINARY(32) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
  attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token BINARY(16),
  locked_by VARCHAR(128),
  lease_expires_at DATETIME(3),
  started_at DATETIME(3),
  finished_at DATETIME(3),
  error_text TEXT,
  requested_by BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_tenant_id (restaurant_id, id),
  UNIQUE KEY uq_job_deduplication (deduplication_hash),
  KEY ix_job_claim (status, available_at, id),
  KEY ix_job_lease (status, lease_expires_at),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (requested_by) REFERENCES admin_accounts (id),
  CHECK (max_attempts > 0 AND attempt_count <= max_attempts),
  CHECK (job_type = 'ACCOUNT_EMAIL' OR restaurant_id IS NOT NULL),
  CHECK ((status = 'RUNNING' AND lease_token IS NOT NULL AND locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'RUNNING' AND lease_token IS NULL AND locked_by IS NULL AND lease_expires_at IS NULL)),
  CHECK (JSON_TYPE(payload) = 'OBJECT')
) ENGINE=InnoDB;

CREATE TABLE idempotency_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED,
  admin_account_id BIGINT UNSIGNED NOT NULL,
  http_method VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint_path VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash BINARY(32) NOT NULL,
  status ENUM('PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PROCESSING',
  response_status SMALLINT UNSIGNED,
  response_body JSON,
  lease_expires_at DATETIME(3),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency_request (admin_account_id, http_method, endpoint_path, idempotency_key),
  KEY ix_idempotency_expiry (expires_at),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants (id),
  FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id),
  CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  CHECK (status = 'PROCESSING' OR response_status IS NOT NULL),
  CHECK (expires_at > created_at)
) ENGINE=InnoDB;

CREATE TABLE export_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurant_id BIGINT UNSIGNED NOT NULL,
  payroll_period_id BIGINT UNSIGNED NOT NULL,
  calculation_run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED,
  report_type ENUM('MONTHLY_SUMMARY','EMPLOYEE_STATEMENT','ATTENDANCE','DEBT','WARNINGS') NOT NULL,
  file_type ENUM('XLSX','CSV','PDF') NOT NULL,
  filters_snapshot JSON NOT NULL,
  status ENUM('QUEUED','PROCESSING','READY','FAILED','EXPIRED') NOT NULL DEFAULT 'QUEUED',
  job_id BIGINT UNSIGNED,
  requested_by BIGINT UNSIGNED NOT NULL,
  storage_key VARCHAR(512),
  file_sha256 BINARY(32),
  file_size_bytes BIGINT UNSIGNED,
  error_text TEXT,
  expires_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_export_tenant_id (restaurant_id, id),
  KEY ix_export_history (restaurant_id, requested_by, created_at),
  KEY ix_export_expiry (status, expires_at),
  FOREIGN KEY (restaurant_id, payroll_period_id, calculation_run_id)
    REFERENCES calculation_runs (restaurant_id, payroll_period_id, id),
  FOREIGN KEY (restaurant_id, calculation_run_id, employee_id)
    REFERENCES payroll_employee_results (restaurant_id, calculation_run_id, employee_id),
  FOREIGN KEY (restaurant_id, job_id) REFERENCES jobs (restaurant_id, id),
  FOREIGN KEY (requested_by) REFERENCES admin_accounts (id),
  CHECK (report_type <> 'EMPLOYEE_STATEMENT' OR employee_id IS NOT NULL),
  CHECK (status <> 'READY' OR (storage_key IS NOT NULL AND file_sha256 IS NOT NULL
         AND file_size_bytes IS NOT NULL AND expires_at IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (JSON_TYPE(filters_snapshot) = 'OBJECT')
) ENGINE=InnoDB;

CREATE TABLE schema_migrations (
  version VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description VARCHAR(255) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB;

-- 8. Read-only reporting projections
-- These views are not authorization boundaries. Always filter restaurant_id.

CREATE SQL SECURITY INVOKER VIEW v_warning_monthly_counts AS
SELECT
  restaurant_id,
  employee_id,
  DATE_SUB(incident_date, INTERVAL DAYOFMONTH(incident_date) - 1 DAY) AS month_start,
  SUM(origin = 'AUTOMATIC_LATE') AS automatic_warning_count,
  SUM(origin = 'CUSTOM') AS custom_warning_count,
  COUNT(*) AS valid_warning_count,
  SUM(counts_toward_limit) AS counted_warning_count
FROM warnings
WHERE system_qualifies = 1 AND admin_voided = 0
GROUP BY restaurant_id, employee_id,
  DATE_SUB(incident_date, INTERVAL DAYOFMONTH(incident_date) - 1 DAY);

CREATE SQL SECURITY INVOKER VIEW v_current_payroll_summary AS
SELECT
  p.id AS payroll_period_id,
  p.month_start,
  p.status AS period_status,
  p.finalized_at,
  p.finalized_by,
  r.completed_at AS calculated_at,
  r.input_revision,
  p.source_revision,
  CASE WHEN r.input_revision <> p.source_revision
    OR (r.previous_payroll_period_id IS NOT NULL
        AND (previous_period.status <> 'FINALIZED'
             OR NOT (previous_period.active_finalized_run_id <=> r.previous_finalized_run_id)))
    THEN 1 ELSE 0 END AS is_stale,
  CASE WHEN p.status = 'FINALIZED' THEN 0 ELSE 1 END AS is_provisional,
  CASE WHEN e.counted_warning_count >= e.warning_threshold THEN 1 ELSE 0 END AS warning_limit_reached,
  JSON_LENGTH(e.blockers) AS blocker_count,
  e.*
FROM payroll_periods p
JOIN calculation_runs r
  ON r.restaurant_id = p.restaurant_id AND r.payroll_period_id = p.id
 AND r.id = p.current_calculation_run_id AND r.status = 'COMPLETE'
JOIN payroll_employee_results e
  ON e.restaurant_id = r.restaurant_id AND e.calculation_run_id = r.id
LEFT JOIN payroll_periods previous_period
  ON previous_period.restaurant_id = r.restaurant_id
 AND previous_period.id = r.previous_payroll_period_id;

CREATE SQL SECURITY INVOKER VIEW v_finalized_payroll_summary AS
SELECT * FROM v_current_payroll_summary
WHERE period_status = 'FINALIZED' AND is_stale = 0;

CREATE SQL SECURITY INVOKER VIEW v_current_debt_details AS
SELECT
  p.restaurant_id,
  p.month_start,
  p.period_status,
  p.is_stale,
  p.employee_id,
  p.full_name_snapshot,
  d.calculation_run_id,
  d.debt_source_id,
  s.source_type,
  s.origin_work_date,
  d.opening_minutes,
  d.new_minutes,
  d.waived_minutes,
  d.recovered_minutes,
  d.closing_minutes
FROM v_current_payroll_summary p
JOIN debt_lot_results d
  ON d.restaurant_id = p.restaurant_id AND d.calculation_run_id = p.calculation_run_id
 AND d.employee_id = p.employee_id
JOIN hour_debt_sources s
  ON s.restaurant_id = d.restaurant_id AND s.employee_id = d.employee_id AND s.id = d.debt_source_id;


-- 9. Write guards for historical records
-- Build each result set with INSERTs, then close its run.
-- Corrections create a NEW run; snapshots are never updated or deleted.
-- The shared lock prevents a result insert racing a run's closure.

DELIMITER $$

CREATE PROCEDURE assert_run_is_building(
  IN p_restaurant_id BIGINT UNSIGNED,
  IN p_run_id BIGINT UNSIGNED
)
READS SQL DATA
SQL SECURITY INVOKER
BEGIN
  DECLARE v_status VARCHAR(16) DEFAULT NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_status = NULL;
  SELECT status INTO v_status
  FROM calculation_runs
  WHERE restaurant_id = p_restaurant_id AND id = p_run_id
  FOR SHARE;
  IF v_status IS NULL OR v_status <> 'BUILDING' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Results require a BUILDING calculation run';
  END IF;
END$$

CREATE TRIGGER calculation_runs_bi
BEFORE INSERT ON calculation_runs FOR EACH ROW
BEGIN
  IF NEW.status <> 'BUILDING' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A calculation run must start as BUILDING';
  END IF;
END$$

CREATE TRIGGER calculation_runs_bu
BEFORE UPDATE ON calculation_runs FOR EACH ROW
BEGIN
  IF OLD.status <> 'BUILDING' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Closed calculation runs are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.restaurant_id <> OLD.restaurant_id
     OR NEW.payroll_period_id <> OLD.payroll_period_id
     OR NOT (NEW.previous_payroll_period_id <=> OLD.previous_payroll_period_id)
     OR NOT (NEW.previous_finalized_run_id <=> OLD.previous_finalized_run_id)
     OR NEW.input_revision <> OLD.input_revision
     OR NEW.engine_version <> OLD.engine_version
     OR NEW.input_hash <> OLD.input_hash
     OR NOT (NEW.input_snapshot <=> OLD.input_snapshot)
     OR NEW.as_of_at <> OLD.as_of_at
     OR NEW.created_at <> OLD.created_at
     OR NOT (NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Calculation inputs are immutable';
  END IF;
END$$

CREATE TRIGGER calculation_runs_bd
BEFORE DELETE ON calculation_runs FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Calculation history cannot be deleted'$$

CREATE TRIGGER payroll_employee_results_bi
BEFORE INSERT ON payroll_employee_results FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER payroll_employee_results_bu
BEFORE UPDATE ON payroll_employee_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER payroll_employee_results_bd
BEFORE DELETE ON payroll_employee_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER payroll_daily_results_bi
BEFORE INSERT ON payroll_daily_results FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER payroll_daily_results_bu
BEFORE UPDATE ON payroll_daily_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER payroll_daily_results_bd
BEFORE DELETE ON payroll_daily_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER debt_lot_results_bi
BEFORE INSERT ON debt_lot_results FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER debt_lot_results_bu
BEFORE UPDATE ON debt_lot_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER debt_lot_results_bd
BEFORE DELETE ON debt_lot_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER debt_recovery_allocations_bi
BEFORE INSERT ON debt_recovery_allocations FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER debt_recovery_allocations_bu
BEFORE UPDATE ON debt_recovery_allocations FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER debt_recovery_allocations_bd
BEFORE DELETE ON debt_recovery_allocations FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER debt_waiver_applications_bi
BEFORE INSERT ON debt_waiver_applications FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER debt_waiver_applications_bu
BEFORE UPDATE ON debt_waiver_applications FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER debt_waiver_applications_bd
BEFORE DELETE ON debt_waiver_applications FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER payroll_warning_results_bi
BEFORE INSERT ON payroll_warning_results FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER payroll_warning_results_bu
BEFORE UPDATE ON payroll_warning_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER payroll_warning_results_bd
BEFORE DELETE ON payroll_warning_results FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER payroll_lines_bi
BEFORE INSERT ON payroll_lines FOR EACH ROW
CALL assert_run_is_building(NEW.restaurant_id, NEW.calculation_run_id)$$

CREATE TRIGGER payroll_lines_bu
BEFORE UPDATE ON payroll_lines FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots are append-only'$$

CREATE TRIGGER payroll_lines_bd
BEFORE DELETE ON payroll_lines FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll snapshots cannot be deleted'$$

CREATE TRIGGER restaurant_policy_versions_bu
BEFORE UPDATE ON restaurant_policy_versions FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records are append-only'$$

CREATE TRIGGER restaurant_policy_versions_bd
BEFORE DELETE ON restaurant_policy_versions FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be deleted'$$

CREATE TRIGGER employee_salary_versions_bu
BEFORE UPDATE ON employee_salary_versions FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records are append-only'$$

CREATE TRIGGER employee_salary_versions_bd
BEFORE DELETE ON employee_salary_versions FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be deleted'$$

CREATE TRIGGER hour_debt_sources_bu
BEFORE UPDATE ON hour_debt_sources FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records are append-only'$$

CREATE TRIGGER hour_debt_sources_bd
BEFORE DELETE ON hour_debt_sources FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be deleted'$$

CREATE TRIGGER payroll_period_events_bu
BEFORE UPDATE ON payroll_period_events FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records are append-only'$$

CREATE TRIGGER payroll_period_events_bd
BEFORE DELETE ON payroll_period_events FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be deleted'$$

CREATE TRIGGER audit_events_bu
BEFORE UPDATE ON audit_events FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records are append-only'$$

CREATE TRIGGER audit_events_bd
BEFORE DELETE ON audit_events FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be deleted'$$

DELIMITER ;

INSERT INTO schema_migrations (version, description)
VALUES ('001_initial_schema', 'Restaurant workforce initial MySQL 8.4 schema');

-- No sample users are inserted. Create the first Superadmin through a
-- backend bootstrap command using an Argon2id password hash.
-- All restaurant-owned queries must be scoped by restaurant_id.
-- Application writes must use transactions, authorization, row_version
-- checks, payroll source revisions, and the agreed finalization rules.
