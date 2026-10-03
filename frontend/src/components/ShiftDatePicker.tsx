import React, { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import {
  Calendar,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertCircle,
} from 'lucide-react';
import {
  currentMonth,
  monthStart,
  monthEnd,
  shiftMonth,
  weekStart,
  weekEnd,
  shiftWeekRange,
  generateMonthOptions,
  generateWeekOptions,
  MonthOption,
  WeekOption,
} from '../lib/format';

export type ShiftDateMode = 'MONTHLY' | 'WEEKLY' | 'CUSTOM';

export interface ShiftDatePickerProps {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
  contextMonth?: string;
}

export const ShiftDatePicker: React.FC<ShiftDatePickerProps> = ({
  startDate,
  endDate,
  onChange,
  contextMonth,
}) => {
  // Determine initial mode based on current startDate and endDate
  const initialMode = useMemo<ShiftDateMode>(() => {
    if (!startDate || !endDate) return 'MONTHLY';
    const month = startDate.slice(0, 7);
    if (startDate === monthStart(month) && endDate === monthEnd(month)) {
      return 'MONTHLY';
    }
    const mon = weekStart(startDate);
    const sun = weekEnd(startDate);
    if (startDate === mon && endDate === sun) {
      return 'WEEKLY';
    }
    return 'CUSTOM';
  }, []);

  const [mode, setMode] = useState<ShiftDateMode>(initialMode);

  // Month list for dropdown
  const monthOptions = useMemo<MonthOption[]>(() => {
    const center = contextMonth || startDate?.slice(0, 7) || currentMonth();
    const list = generateMonthOptions(center, 8, 12);
    const activeMonth = startDate?.slice(0, 7);
    if (activeMonth && !list.some((o) => o.value === activeMonth)) {
      const dt = DateTime.fromFormat(activeMonth, 'yyyy-MM');
      if (dt.isValid) {
        list.unshift({
          value: activeMonth,
          label: `${dt.toFormat('LLLL yyyy')}${activeMonth === currentMonth() ? ' (Current Month)' : ''}`,
          startDate: monthStart(activeMonth),
          endDate: monthEnd(activeMonth),
          isCurrent: activeMonth === currentMonth(),
        });
      }
    }
    return list;
  }, [contextMonth, startDate]);

  // Week list for dropdown
  const weekOptions = useMemo<WeekOption[]>(() => {
    const center = startDate || DateTime.now().toISODate()!;
    const list = generateWeekOptions(center, 10, 16);
    const curVal = `${startDate}_${endDate}`;
    if (startDate && endDate && !list.some((o) => o.value === curVal)) {
      const d1 = DateTime.fromISO(startDate);
      const d2 = DateTime.fromISO(endDate);
      if (d1.isValid && d2.isValid) {
        const sameYear = d1.year === d2.year;
        const rangeText = sameYear
          ? `${d1.toFormat('LLL dd')} – ${d2.toFormat('LLL dd, yyyy')}`
          : `${d1.toFormat('LLL dd, yyyy')} – ${d2.toFormat('LLL dd, yyyy')}`;
        list.unshift({
          value: curVal,
          label: `Week ${d1.weekNumber}: ${rangeText}`,
          weekNumber: d1.weekNumber,
          year: d1.weekYear,
          startDate,
          endDate,
          isCurrent: false,
        });
      }
    }
    return list;
  }, [startDate, endDate]);

  // Handle mode switches
  const handleModeChange = (newMode: ShiftDateMode) => {
    setMode(newMode);
    if (newMode === 'MONTHLY') {
      const targetMonth = startDate?.slice(0, 7) || contextMonth || currentMonth();
      onChange(monthStart(targetMonth), monthEnd(targetMonth));
    } else if (newMode === 'WEEKLY') {
      const baseDate = startDate || DateTime.now().toISODate()!;
      onChange(weekStart(baseDate), weekEnd(baseDate));
    }
  };

  // Monthly navigation
  const currentSelectedMonth = startDate?.slice(0, 7) || currentMonth();
  const handleMonthSelect = (m: string) => {
    onChange(monthStart(m), monthEnd(m));
  };
  const handleMonthShift = (delta: number) => {
    const nextM = shiftMonth(currentSelectedMonth, delta);
    onChange(monthStart(nextM), monthEnd(nextM));
  };

  // Weekly navigation
  const currentWeekVal = `${startDate}_${endDate}`;
  const handleWeekSelect = (val: string) => {
    const [start, end] = val.split('_');
    if (start && end) {
      onChange(start, end);
    }
  };
  const handleWeekShift = (delta: number) => {
    const { startDate: newStart, endDate: newEnd } = shiftWeekRange(startDate, delta);
    onChange(newStart, newEnd);
  };

  // Duration calculation
  const totalDays = useMemo(() => {
    const d1 = DateTime.fromISO(startDate);
    const d2 = DateTime.fromISO(endDate);
    if (!d1.isValid || !d2.isValid || d2 < d1) return 0;
    return Math.round(d2.diff(d1, 'days').days) + 1;
  }, [startDate, endDate]);

  const isValidCustomRange = useMemo(() => {
    if (!startDate || !endDate) return false;
    const d1 = DateTime.fromISO(startDate);
    const d2 = DateTime.fromISO(endDate);
    return d1.isValid && d2.isValid && d2 >= d1;
  }, [startDate, endDate]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Mode Tabs */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <label className="form-label" style={{ marginBottom: 0 }}>
            Schedule Period Mode
          </label>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Choose generation timeframe
          </span>
        </div>

        <div className="segmented" style={{ width: '100%', display: 'flex' }}>
          <button
            type="button"
            className={mode === 'MONTHLY' ? 'active' : ''}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.5rem',
            }}
            onClick={() => handleModeChange('MONTHLY')}
          >
            <Calendar size={14} />
            <span>Monthly</span>
          </button>
          <button
            type="button"
            className={mode === 'WEEKLY' ? 'active' : ''}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.5rem',
            }}
            onClick={() => handleModeChange('WEEKLY')}
          >
            <CalendarDays size={14} />
            <span>Weekly</span>
          </button>
          <button
            type="button"
            className={mode === 'CUSTOM' ? 'active' : ''}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.5rem',
            }}
            onClick={() => handleModeChange('CUSTOM')}
          >
            <CalendarRange size={14} />
            <span>Custom Range</span>
          </button>
        </div>
      </div>

      {/* MONTHLY PICKER */}
      {mode === 'MONTHLY' && (
        <div
          style={{
            padding: '0.85rem',
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border-light)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Select Month
            </span>
            {currentSelectedMonth !== currentMonth() && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                onClick={() => handleMonthSelect(currentMonth())}
              >
                Current Month
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-icon"
              title="Previous Month"
              onClick={() => handleMonthShift(-1)}
            >
              <ChevronLeft size={16} />
            </button>

            <select
              className="select"
              style={{ flex: 1, fontWeight: 550 }}
              value={currentSelectedMonth}
              onChange={(e) => handleMonthSelect(e.target.value)}
            >
              {monthOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-secondary btn-sm btn-icon"
              title="Next Month"
              onClick={() => handleMonthShift(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Active Range Preview Chip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.4rem 0.65rem',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
              <Clock size={13} />
              <span>Full Month Range:</span>
            </div>
            <div style={{ fontWeight: 600, color: 'var(--primary)' }}>
              {startDate} <span style={{ color: 'var(--text-subtle)' }}>→</span> {endDate} ({totalDays} days)
            </div>
          </div>
        </div>
      )}

      {/* WEEKLY PICKER */}
      {mode === 'WEEKLY' && (
        <div
          style={{
            padding: '0.85rem',
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border-light)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Select Week (Monday – Sunday)
            </span>
            {weekStart(startDate) !== weekStart() && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                onClick={() => onChange(weekStart(), weekEnd())}
              >
                Current Week
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-icon"
              title="Previous Week"
              onClick={() => handleWeekShift(-1)}
            >
              <ChevronLeft size={16} />
            </button>

            <select
              className="select"
              style={{ flex: 1, fontWeight: 550 }}
              value={currentWeekVal}
              onChange={(e) => handleWeekSelect(e.target.value)}
            >
              {weekOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-secondary btn-sm btn-icon"
              title="Next Week"
              onClick={() => handleWeekShift(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Active Range Preview Chip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.4rem 0.65rem',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
              <Clock size={13} />
              <span>Week Range:</span>
            </div>
            <div style={{ fontWeight: 600, color: 'var(--primary)' }}>
              {startDate} <span style={{ color: 'var(--text-subtle)' }}>→</span> {endDate} (7 days)
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM RANGE PICKER */}
      {mode === 'CUSTOM' && (
        <div
          style={{
            padding: '0.85rem',
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border-light)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
          }}
        >
          <div className="grid-2" style={{ gap: '0.75rem', marginBottom: 0 }}>
            <div>
              <label className="form-label" style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                From Date
              </label>
              <input
                type="date"
                className="input"
                required
                value={startDate}
                onChange={(e) => onChange(e.target.value, endDate)}
              />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                To Date
              </label>
              <input
                type="date"
                className="input"
                required
                value={endDate}
                onChange={(e) => onChange(startDate, e.target.value)}
              />
            </div>
          </div>

          {/* Range Validation or Summary */}
          {!isValidCustomRange ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                color: 'var(--status-danger)',
                fontSize: '0.75rem',
              }}
            >
              <AlertCircle size={14} />
              <span>Start date must be before or equal to End date.</span>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.4rem 0.65rem',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.75rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)' }}>
                <Clock size={13} />
                <span>Selected Span:</span>
              </div>
              <div style={{ fontWeight: 600, color: 'var(--primary)' }}>
                {totalDays} {totalDays === 1 ? 'day' : 'days'} selected
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
