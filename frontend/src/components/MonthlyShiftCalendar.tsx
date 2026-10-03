import React, { useState, useMemo, useEffect } from 'react';
import { DateTime } from 'luxon';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  User,
  Clock,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { schedulingApi, BatchScheduleAssignment } from '../lib/api';
import { currentMonth, monthLabel, shiftMonth } from '../lib/format';

export interface MonthlyShiftCalendarProps {
  restaurantId: string;
  selectedMonth: string;
  onMonthChange: (month: string) => void;
  employees: Array<{ id: string; fullName: string; employeeNumber: string }>;
  templates: Array<{
    id: string;
    name: string;
    intervals?: Array<{ startLocalTime?: string; endLocalTime?: string }>;
  }>;
  schedules: Array<{
    id: string;
    employeeId: string;
    workDate: string;
    dayType: 'WORK' | 'OFF' | 'EXCUSED';
    sourceTemplateId: string | null;
    templateName: string | null;
  }>;
}

interface DayState {
  dayType: 'WORK' | 'OFF' | 'CLEAR';
  shiftTemplateId?: string | null;
}

export const MonthlyShiftCalendar: React.FC<MonthlyShiftCalendarProps> = ({
  restaurantId,
  selectedMonth,
  onMonthChange,
  employees,
  templates,
  schedules,
}) => {
  const queryClient = useQueryClient();

  // Selected Employee (defaults to first employee)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>(() => {
    return employees[0]?.id || '';
  });

  useEffect(() => {
    if ((!selectedEmployeeId || !employees.some((e) => e.id === selectedEmployeeId)) && employees[0]) {
      setSelectedEmployeeId(employees[0].id);
    }
  }, [employees, selectedEmployeeId]);

  // Map of date (YYYY-MM-DD) -> DayState for current employee
  const [localSchedule, setLocalSchedule] = useState<Record<string, DayState>>({});
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Quick preset tool state
  const [presetWorkdayTemplate, setPresetWorkdayTemplate] = useState<string>('');

  // Days in selected month
  const [yearStr, monthStr] = selectedMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);

  const daysInMonth = useMemo(() => {
    return new Date(year, month, 0).getDate();
  }, [year, month]);

  // First day of month weekday (1 = Mon ... 7 = Sun in Luxon)
  const startWeekday = useMemo(() => {
    const firstDay = DateTime.fromISO(`${selectedMonth}-01T00:00:00`);
    return firstDay.isValid ? firstDay.weekday : 1;
  }, [selectedMonth]);

  // Synchronize local schedule with server schedules when employee or schedules change
  useEffect(() => {
    if (!selectedEmployeeId) return;

    const initial: Record<string, DayState> = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = d < 10 ? `0${d}` : `${d}`;
      const dateKey = `${selectedMonth}-${dStr}`;
      const found = schedules.find((s) => s.employeeId === selectedEmployeeId && s.workDate === dateKey);

      if (found) {
        initial[dateKey] = {
          dayType: found.dayType === 'OFF' ? 'OFF' : 'WORK',
          shiftTemplateId: found.sourceTemplateId || null,
        };
      } else {
        initial[dateKey] = {
          dayType: 'CLEAR',
          shiftTemplateId: null,
        };
      }
    }
    setLocalSchedule(initial);
    setSuccessMsg(null);
    setErrorMsg(null);
  }, [selectedEmployeeId, schedules, selectedMonth, daysInMonth]);

  // Single cell mutation (instant live save)
  const cellMutation = useMutation({
    mutationFn: async ({ dateKey, value }: { dateKey: string; value: string }) => {
      const dayType = value === 'OFF' ? 'OFF' : value === 'CLEAR' || value === '' ? 'CLEAR' : 'WORK';
      const shiftTemplateId = dayType === 'WORK' ? value : null;
      return schedulingApi.batchSchedule(restaurantId, {
        assignments: [{ employeeId: selectedEmployeeId, workDate: dateKey, dayType, shiftTemplateId }],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules', restaurantId] });
      queryClient.invalidateQueries({ queryKey: ['schedules-range', restaurantId] });
      setSuccessMsg('Shift updated');
      setTimeout(() => setSuccessMsg(null), 2500);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || 'Failed to update shift');
    },
  });

  // Batch Save mutation (for presets or multi-save)
  const saveMutation = useMutation({
    mutationFn: async (assignments: BatchScheduleAssignment[]) => {
      return schedulingApi.batchSchedule(restaurantId, { assignments });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['schedules', restaurantId] });
      queryClient.invalidateQueries({ queryKey: ['schedules-range', restaurantId] });
      setSuccessMsg(res.message || 'Shifts updated successfully');
      setTimeout(() => setSuccessMsg(null), 4000);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || 'Failed to save shifts');
    },
  });

  const handleDayChange = (dateKey: string, value: string) => {
    setSuccessMsg(null);
    setErrorMsg(null);
    setLocalSchedule((prev) => {
      const next = { ...prev };
      if (value === 'OFF') {
        next[dateKey] = { dayType: 'OFF', shiftTemplateId: null };
      } else if (value === 'CLEAR' || value === '') {
        next[dateKey] = { dayType: 'CLEAR', shiftTemplateId: null };
      } else {
        next[dateKey] = { dayType: 'WORK', shiftTemplateId: value };
      }
      return next;
    });
    // Immediately persist to backend so Weekly, Monthly, and Matrix stay in perfect sync!
    cellMutation.mutate({ dateKey, value });
  };

  const handleApplyPreset = (type: 'WORKDAYS' | 'WEEKENDS' | 'CLEAR') => {
    if (!selectedEmployeeId) return;
    setSuccessMsg(null);
    setErrorMsg(null);

    const assignments: BatchScheduleAssignment[] = [];
    const nextLocal = { ...localSchedule };

    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = d < 10 ? `0${d}` : `${d}`;
      const dateKey = `${selectedMonth}-${dStr}`;
      const dt = DateTime.fromISO(`${dateKey}T00:00:00`);
      const isWeekend = dt.weekday === 6 || dt.weekday === 7;

      if (type === 'WORKDAYS' && !isWeekend && presetWorkdayTemplate) {
        nextLocal[dateKey] = { dayType: 'WORK', shiftTemplateId: presetWorkdayTemplate };
        assignments.push({
          employeeId: selectedEmployeeId,
          workDate: dateKey,
          dayType: 'WORK',
          shiftTemplateId: presetWorkdayTemplate,
        });
      } else if (type === 'WEEKENDS' && isWeekend) {
        nextLocal[dateKey] = { dayType: 'OFF', shiftTemplateId: null };
        assignments.push({
          employeeId: selectedEmployeeId,
          workDate: dateKey,
          dayType: 'OFF',
          shiftTemplateId: null,
        });
      } else if (type === 'CLEAR') {
        nextLocal[dateKey] = { dayType: 'CLEAR', shiftTemplateId: null };
        assignments.push({
          employeeId: selectedEmployeeId,
          workDate: dateKey,
          dayType: 'CLEAR',
          shiftTemplateId: null,
        });
      }
    }

    setLocalSchedule(nextLocal);
    if (assignments.length > 0) {
      saveMutation.mutate(assignments);
    }
  };

  // Employee flip
  const currentEmpIndex = employees.findIndex((e) => e.id === selectedEmployeeId);
  const handleShiftEmployee = (delta: number) => {
    if (employees.length === 0) return;
    const nextIdx = (currentEmpIndex + delta + employees.length) % employees.length;
    const nextEmp = employees[nextIdx];
    if (nextEmp) {
      setSelectedEmployeeId(nextEmp.id);
    }
  };

  // Schedule statistics for this month
  const stats = useMemo(() => {
    let workDays = 0;
    let offDays = 0;
    let unassigned = 0;

    Object.values(localSchedule).forEach((d) => {
      if (d.dayType === 'WORK') workDays++;
      else if (d.dayType === 'OFF') offDays++;
      else unassigned++;
    });

    return { workDays, offDays, unassigned };
  }, [localSchedule]);

  const currentEmp = employees.find((e) => e.id === selectedEmployeeId);

  // Month navigation
  const handleMonthShift = (delta: number) => {
    onMonthChange(shiftMonth(selectedMonth, delta));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Top Header Card */}
      <div
        className="card"
        style={{
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          {/* Employee Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'var(--primary-light)',
                color: 'var(--primary)',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              <User size={20} />
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                Staff Member Calendar
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-icon"
                  title="Previous Employee"
                  onClick={() => handleShiftEmployee(-1)}
                  disabled={employees.length <= 1}
                >
                  <ChevronLeft size={15} />
                </button>

                <select
                  className="select"
                  style={{
                    minWidth: '220px',
                    fontWeight: 650,
                    fontSize: '0.9rem',
                    padding: '0.35rem 0.65rem',
                  }}
                  value={selectedEmployeeId}
                  onChange={(e) => setSelectedEmployeeId(e.target.value)}
                >
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.fullName} ({emp.employeeNumber})
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-icon"
                  title="Next Employee"
                  onClick={() => handleShiftEmployee(1)}
                  disabled={employees.length <= 1}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* Month Stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-icon"
                title="Previous Month"
                onClick={() => handleMonthShift(-1)}
              >
                <ChevronLeft size={16} />
              </button>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.35rem 0.85rem',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-light)',
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 650,
                  fontSize: '0.875rem',
                  minWidth: '150px',
                  justifyContent: 'center',
                }}
              >
                <Calendar size={16} color="var(--primary)" />
                <span>{monthLabel(selectedMonth)}</span>
              </div>

              <button
                type="button"
                className="btn btn-secondary btn-sm btn-icon"
                title="Next Month"
                onClick={() => handleMonthShift(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            {selectedMonth !== currentMonth() && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onMonthChange(currentMonth())}
              >
                Today
              </button>
            )}
          </div>

          {/* Live Sync Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {cellMutation.isPending || saveMutation.isPending ? (
              <span className="badge badge-info" style={{ fontSize: '0.75rem' }}>
                Syncing with backend...
              </span>
            ) : (
              <span className="badge badge-success" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                <CheckCircle2 size={13} />
                <span>Live Synced</span>
              </span>
            )}
          </div>
        </div>

        {/* Quick Batch Bar */}
        <div
          style={{
            padding: '0.65rem 0.9rem',
            backgroundColor: 'var(--bg-surface-subtle)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.75rem',
            fontSize: '0.8125rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Quick Fill for {currentEmp?.fullName}:</span>

            <select
              className="select"
              style={{ width: 'auto', padding: '0.25rem 0.65rem', fontSize: '0.75rem' }}
              value={presetWorkdayTemplate}
              onChange={(e) => setPresetWorkdayTemplate(e.target.value)}
            >
              <option value="">Choose Template...</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!presetWorkdayTemplate}
              onClick={() => handleApplyPreset('WORKDAYS')}
            >
              Fill Mon–Fri
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleApplyPreset('WEEKENDS')}
            >
              Set Weekends OFF
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--status-danger)' }}
              onClick={() => handleApplyPreset('CLEAR')}
            >
              Clear All Days
            </button>
          </div>

          {/* Stats Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.75rem' }}>
            <div>
              Working: <strong style={{ color: 'var(--primary)' }}>{stats.workDays}</strong>
            </div>
            <div>
              Day Off: <strong style={{ color: 'var(--text-muted)' }}>{stats.offDays}</strong>
            </div>
            <div>
              Unassigned: <strong style={{ color: 'var(--text-subtle)' }}>{stats.unassigned}</strong>
            </div>
          </div>
        </div>

        {/* Feedback Alerts */}
        {successMsg && (
          <div
            style={{
              padding: '0.5rem 0.75rem',
              backgroundColor: 'var(--status-success-bg)',
              color: 'var(--status-success-text)',
              border: '1px solid var(--status-success-border)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.8125rem',
            }}
          >
            <CheckCircle2 size={16} />
            <span>{successMsg}</span>
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              padding: '0.5rem 0.75rem',
              backgroundColor: 'var(--status-danger-bg)',
              color: 'var(--status-danger-text)',
              border: '1px solid var(--status-danger-border)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.8125rem',
            }}
          >
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Monthly Calendar Grid */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Calendar Day Header */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            backgroundColor: 'var(--bg-surface-subtle)',
            borderBottom: '1px solid var(--border-light)',
          }}
        >
          {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((dayName, idx) => (
            <div
              key={dayName}
              style={{
                padding: '0.65rem 0.5rem',
                textAlign: 'center',
                fontWeight: 650,
                fontSize: '0.8125rem',
                color: idx >= 5 ? 'var(--status-danger-text)' : 'var(--text-muted)',
                backgroundColor: idx >= 5 ? 'rgba(196, 43, 43, 0.04)' : undefined,
                borderRight: idx < 6 ? '1px solid var(--border-light)' : undefined,
              }}
            >
              {dayName}
            </div>
          ))}
        </div>

        {/* Calendar Cells Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            backgroundColor: 'var(--border-light)',
            gap: '1px',
          }}
        >
          {/* Empty prefix cells before 1st day of month */}
          {Array.from({ length: startWeekday - 1 }).map((_, i) => (
            <div
              key={`empty-${i}`}
              style={{
                backgroundColor: 'var(--bg-surface-subtle)',
                opacity: 0.5,
                minHeight: '105px',
              }}
            />
          ))}

          {/* Month Day Cells */}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const dayNum = i + 1;
            const dStr = dayNum < 10 ? `0${dayNum}` : `${dayNum}`;
            const dateKey = `${selectedMonth}-${dStr}`;
            const dayState = localSchedule[dateKey] || { dayType: 'CLEAR', shiftTemplateId: null };

            // Weekday check
            const dateObj = DateTime.fromISO(`${dateKey}T00:00:00`);
            const isWeekend = dateObj.weekday === 6 || dateObj.weekday === 7;
            const isToday = dateKey === DateTime.now().toISODate();

            // Find current template
            const selectedTemplate = templates.find((t) => t.id === dayState.shiftTemplateId);

            // Styling based on day state
            let cellBg = 'var(--bg-surface)';
            let borderColor = 'transparent';
            let tagColor = 'var(--text-subtle)';
            let tagText = 'Unassigned';

            if (dayState.dayType === 'OFF') {
              cellBg = 'var(--bg-surface-subtle)';
              tagColor = 'var(--text-muted)';
              tagText = 'Day Off';
            } else if (dayState.dayType === 'WORK') {
              if (selectedTemplate?.name.includes('Morning') || selectedTemplate?.name.includes('Main')) {
                cellBg = 'var(--primary-soft)';
                borderColor = 'var(--primary)';
                tagColor = 'var(--primary)';
              } else if (selectedTemplate?.name.includes('Evening')) {
                cellBg = 'var(--accent-light)';
                borderColor = 'var(--accent)';
                tagColor = 'var(--accent)';
              } else if (selectedTemplate?.name.includes('Split')) {
                cellBg = 'var(--status-warning-bg)';
                borderColor = 'var(--status-warning)';
                tagColor = 'var(--status-warning)';
              } else {
                cellBg = 'var(--status-info-bg)';
                borderColor = 'var(--status-info)';
                tagColor = 'var(--status-info)';
              }
              tagText = selectedTemplate?.name || 'Work Day';
            }

            return (
              <div
                key={dateKey}
                style={{
                  backgroundColor: cellBg,
                  minHeight: '115px',
                  padding: '0.6rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  borderTop: borderColor !== 'transparent' ? `3px solid ${borderColor}` : '3px solid transparent',
                  position: 'relative',
                  transition: 'background-color 0.15s ease',
                }}
              >
                {/* Cell Header: Day Number + Tag */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.45rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: '0.95rem',
                        color: isToday ? 'var(--primary)' : isWeekend ? 'var(--status-danger)' : 'var(--text-main)',
                      }}
                    >
                      {dayNum}
                    </span>
                    {isToday && (
                      <span
                        className="badge badge-success"
                        style={{ fontSize: '0.62rem', padding: '0.05rem 0.35rem' }}
                      >
                        Today
                      </span>
                    )}
                  </div>

                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontWeight: 650,
                      color: tagColor,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {tagText}
                  </span>
                </div>

                {/* Dropdown inside the date */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <select
                    className="select"
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.3rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      fontWeight: 600,
                      backgroundColor: 'var(--bg-surface)',
                    }}
                    value={dayState.dayType === 'OFF' ? 'OFF' : dayState.shiftTemplateId || ''}
                    onChange={(e) => handleDayChange(dateKey, e.target.value)}
                  >
                    <option value="">-- No Shift --</option>
                    <option value="OFF">Day Off (OFF)</option>
                    <optgroup label="Shift Templates">
                      {templates.map((tmpl) => {
                        const start = tmpl.intervals?.[0]?.startLocalTime?.slice(0, 5) || '';
                        const end = tmpl.intervals?.[0]?.endLocalTime?.slice(0, 5) || '';
                        const timeSpan = start && end ? ` (${start} - ${end})` : '';
                        return (
                          <option key={tmpl.id} value={tmpl.id}>
                            {tmpl.name}{timeSpan}
                          </option>
                        );
                      })}
                    </optgroup>
                  </select>

                  {/* Time preview badge if work */}
                  {selectedTemplate?.intervals?.[0] && dayState.dayType === 'WORK' && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        fontSize: '0.68rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <Clock size={11} />
                      <span>
                        {selectedTemplate.intervals[0].startLocalTime?.slice(0, 5)} - {selectedTemplate.intervals[0].endLocalTime?.slice(0, 5)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
