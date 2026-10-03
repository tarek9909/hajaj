import React, { useState, useMemo } from 'react';
import { DateTime } from 'luxon';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Search,
  Sparkles,
} from 'lucide-react';
import { schedulingApi, BatchScheduleAssignment } from '../lib/api';
import { weekStart, weekEnd, shiftWeekRange, generateWeekOptions, todayIso } from '../lib/format';

export interface WeeklyShiftScheduleProps {
  restaurantId: string;
  employees: Array<{ id: string; fullName: string; employeeNumber: string }>;
  templates: Array<{
    id: string;
    name: string;
    intervals?: Array<{ startLocalTime?: string; endLocalTime?: string; plannedUnpaidBreakMinutes?: number }>;
  }>;
  selectedWeekStart?: string;
  onWeekChange?: (weekStart: string) => void;
}

export const WeeklyShiftSchedule: React.FC<WeeklyShiftScheduleProps> = ({
  restaurantId,
  employees,
  templates,
  selectedWeekStart: controlledWeekStart,
  onWeekChange,
}) => {
  const queryClient = useQueryClient();

  // Internal week state fallback if not controlled
  const [internalWeekStart, setInternalWeekStart] = useState<string>(() => {
    return controlledWeekStart || weekStart(todayIso());
  });

  const activeWeekStart = controlledWeekStart || internalWeekStart;

  const setActiveWeek = (newWeekStart: string) => {
    setInternalWeekStart(newWeekStart);
    if (onWeekChange) {
      onWeekChange(newWeekStart);
    }
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Quick batch fill state
  const [quickTemplateId, setQuickTemplateId] = useState<string>('');
  const [quickStaffTarget, setQuickStaffTarget] = useState<string>('ALL');

  const activeWeekEnd = useMemo(() => {
    return weekEnd(activeWeekStart);
  }, [activeWeekStart]);

  // Generate 7 days of the week (Monday through Sunday)
  const weekDays = useMemo(() => {
    const monday = DateTime.fromISO(activeWeekStart);
    const validMonday = monday.isValid ? monday : DateTime.now().startOf('week');
    const days = [];
    const today = todayIso();

    for (let i = 0; i < 7; i++) {
      const current = validMonday.plus({ days: i });
      const dateKey = current.toISODate()!;
      days.push({
        dateKey,
        dayName: current.toFormat('cccc'), // 'Monday'
        shortDay: current.toFormat('ccc'), // 'Mon'
        shortDate: current.toFormat('LLL dd'), // 'Oct 05'
        dayNumber: current.day,
        isWeekend: current.weekday === 6 || current.weekday === 7,
        isToday: dateKey === today,
      });
    }
    return days;
  }, [activeWeekStart]);

  // Dropdown options for week picker
  const weekOptions = useMemo(() => {
    const list = generateWeekOptions(todayIso(), 10, 16);
    const curVal = `${activeWeekStart}_${activeWeekEnd}`;
    if (!list.some((o) => o.value === curVal)) {
      const mon = DateTime.fromISO(activeWeekStart);
      const sun = DateTime.fromISO(activeWeekEnd);
      if (mon.isValid && sun.isValid) {
        list.unshift({
          value: curVal,
          label: `Week ${mon.weekNumber}: ${mon.toFormat('LLL dd')} – ${sun.toFormat('LLL dd, yyyy')}`,
          weekNumber: mon.weekNumber,
          year: mon.weekYear,
          startDate: activeWeekStart,
          endDate: activeWeekEnd,
          isCurrent: false,
        });
      }
    }
    return list;
  }, [activeWeekStart, activeWeekEnd]);

  // Fetch schedules for this specific week range
  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules-range', restaurantId, activeWeekStart, activeWeekEnd],
    queryFn: () => schedulingApi.getCalendarRange(restaurantId, activeWeekStart, activeWeekEnd),
  });

  // Map schedules by employeeId_workDate
  const scheduleMap = useMemo(() => {
    const map = new Map<string, any>();
    schedules.forEach((s) => {
      map.set(`${s.employeeId}_${s.workDate}`, s);
    });
    return map;
  }, [schedules]);

  // Helper to invalidate all schedule queries (single source of truth)
  const invalidateAllSchedules = () => {
    queryClient.invalidateQueries({ queryKey: ['schedules', restaurantId] });
    queryClient.invalidateQueries({ queryKey: ['schedules-range', restaurantId] });
  };

  // Mutation for single-cell change
  const cellMutation = useMutation({
    mutationFn: async ({
      employeeId,
      workDate,
      value,
    }: {
      employeeId: string;
      workDate: string;
      value: string;
    }) => {
      const dayType = value === 'OFF' ? 'OFF' : value === '' ? 'CLEAR' : 'WORK';
      const shiftTemplateId = dayType === 'WORK' ? value : null;

      return schedulingApi.batchSchedule(restaurantId, {
        assignments: [{ employeeId, workDate, dayType, shiftTemplateId }],
      });
    },
    onSuccess: () => {
      invalidateAllSchedules();
      setNotification({ type: 'success', message: 'Shift updated' });
      setTimeout(() => setNotification(null), 2500);
    },
    onError: (err: any) => {
      setNotification({ type: 'error', message: err.message || 'Failed to update shift' });
    },
  });

  // Batch pattern mutation
  const batchMutation = useMutation({
    mutationFn: async (assignments: BatchScheduleAssignment[]) => {
      return schedulingApi.batchSchedule(restaurantId, { assignments });
    },
    onSuccess: (res) => {
      invalidateAllSchedules();
      setNotification({ type: 'success', message: res.message || 'Weekly shifts updated' });
      setTimeout(() => setNotification(null), 3000);
    },
    onError: (err: any) => {
      setNotification({ type: 'error', message: err.message || 'Failed to apply weekly shifts' });
    },
  });

  const handleCellChange = (employeeId: string, workDate: string, value: string) => {
    cellMutation.mutate({ employeeId, workDate, value });
  };

  const handleWeekShift = (delta: number) => {
    const { startDate } = shiftWeekRange(activeWeekStart, delta);
    setActiveWeek(startDate);
  };

  const handleWeekSelect = (val: string) => {
    const [start] = val.split('_');
    if (start) {
      setActiveWeek(start);
    }
  };

  const handleApplyWeekPattern = (pattern: 'MON_FRI' | 'WEEKENDS_OFF' | 'CLEAR_WEEK') => {
    const targetEmployees =
      quickStaffTarget === 'ALL'
        ? employees
        : employees.filter((e) => e.id === quickStaffTarget);

    const assignments: BatchScheduleAssignment[] = [];

    targetEmployees.forEach((emp) => {
      weekDays.forEach((wd) => {
        if (pattern === 'MON_FRI' && !wd.isWeekend && quickTemplateId) {
          assignments.push({
            employeeId: emp.id,
            workDate: wd.dateKey,
            dayType: 'WORK',
            shiftTemplateId: quickTemplateId,
          });
        } else if (pattern === 'WEEKENDS_OFF' && wd.isWeekend) {
          assignments.push({
            employeeId: emp.id,
            workDate: wd.dateKey,
            dayType: 'OFF',
            shiftTemplateId: null,
          });
        } else if (pattern === 'CLEAR_WEEK') {
          assignments.push({
            employeeId: emp.id,
            workDate: wd.dateKey,
            dayType: 'CLEAR',
            shiftTemplateId: null,
          });
        }
      });
    });

    if (assignments.length > 0) {
      batchMutation.mutate(assignments);
    }
  };

  // Filtered employees
  const filteredEmployees = useMemo(() => {
    if (!searchQuery.trim()) return employees;
    const q = searchQuery.toLowerCase();
    return employees.filter(
      (e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q)
    );
  }, [employees, searchQuery]);

  // Calculate day totals (how many staff on duty)
  const dayDutyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    weekDays.forEach((wd) => {
      let count = 0;
      employees.forEach((emp) => {
        const item = scheduleMap.get(`${emp.id}_${wd.dateKey}`);
        if (item && item.dayType === 'WORK') {
          count++;
        }
      });
      counts[wd.dateKey] = count;
    });
    return counts;
  }, [weekDays, employees, scheduleMap]);

  const isCurrentWeek = activeWeekStart === weekStart(todayIso());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Week Navigation Header Card */}
      <div
        className="card"
        style={{
          padding: '1.1rem 1.35rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        {/* Left: Week Stepper & Dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--primary-light)',
              color: 'var(--primary)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <CalendarDays size={18} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
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
              style={{
                minWidth: '260px',
                fontWeight: 650,
                fontSize: '0.875rem',
                padding: '0.38rem 0.75rem',
              }}
              value={`${activeWeekStart}_${activeWeekEnd}`}
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

          {!isCurrentWeek && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setActiveWeek(weekStart(todayIso()))}
            >
              Current Week
            </button>
          )}
        </div>

        {/* Right: Search staff & status feedback */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {notification && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.25rem 0.65rem',
                borderRadius: 'var(--radius-full)',
                fontSize: '0.75rem',
                fontWeight: 600,
                backgroundColor:
                  notification.type === 'success' ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
                color:
                  notification.type === 'success' ? 'var(--status-success-text)' : 'var(--status-danger-text)',
                border:
                  notification.type === 'success'
                    ? '1px solid var(--status-success-border)'
                    : '1px solid var(--status-danger-border)',
              }}
            >
              {notification.type === 'success' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
              <span>{notification.message}</span>
            </div>
          )}

          <div style={{ position: 'relative', width: '200px' }}>
            <Search
              size={14}
              style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)' }}
            />
            <input
              type="text"
              className="input"
              style={{ paddingLeft: '2rem', padding: '0.35rem 0.65rem 0.35rem 2rem', fontSize: '0.8125rem' }}
              placeholder="Search staff..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Quick Actions & Legend Bar */}
      <div
        className="card"
        style={{
          padding: '0.75rem 1.15rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          fontSize: '0.8125rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600, color: 'var(--text-muted)' }}>
            <Sparkles size={14} color="var(--primary)" />
            <span>Quick Batch Fill:</span>
          </div>

          <select
            className="select"
            style={{ width: 'auto', padding: '0.25rem 0.65rem', fontSize: '0.75rem' }}
            value={quickStaffTarget}
            onChange={(e) => setQuickStaffTarget(e.target.value)}
          >
            <option value="ALL">All Staff ({employees.length})</option>
            <optgroup label="Individual Staff">
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </optgroup>
          </select>

          <select
            className="select"
            style={{ width: 'auto', padding: '0.25rem 0.65rem', fontSize: '0.75rem' }}
            value={quickTemplateId}
            onChange={(e) => setQuickTemplateId(e.target.value)}
          >
            <option value="">Select Shift Template...</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!quickTemplateId || batchMutation.isPending}
            onClick={() => handleApplyWeekPattern('MON_FRI')}
          >
            Fill Mon–Fri
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={batchMutation.isPending}
            onClick={() => handleApplyWeekPattern('WEEKENDS_OFF')}
          >
            Set Weekends OFF
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--status-danger)' }}
            disabled={batchMutation.isPending}
            onClick={() => handleApplyWeekPattern('CLEAR_WEEK')}
          >
            Clear Week
          </button>
        </div>

        {/* Legend pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', fontSize: '0.72rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--primary)' }} />
            <span>Morning</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--accent)' }} />
            <span>Evening</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--status-warning)' }} />
            <span>Split</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--border-light)', border: '1px solid var(--border-strong)' }} />
            <span>Off</span>
          </div>
        </div>
      </div>

      {/* Weekly Matrix Grid Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-container" style={{ border: 'none', maxHeight: '70vh' }}>
          <table className="table" style={{ fontSize: '0.75rem', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr>
                {/* Fixed Staff Column */}
                <th
                  style={{
                    minWidth: 200,
                    width: 220,
                    position: 'sticky',
                    left: 0,
                    zIndex: 20,
                    backgroundColor: 'var(--bg-surface-subtle)',
                    padding: '0.65rem 0.9rem',
                    borderBottom: '2px solid var(--border-light)',
                  }}
                >
                  <div style={{ fontWeight: 650, color: 'var(--text-main)', fontSize: '0.8125rem' }}>
                    Staff Member
                  </div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                    {filteredEmployees.length} of {employees.length} active
                  </div>
                </th>

                {/* 7 Days of the Week Columns */}
                {weekDays.map((wd) => {
                  const onDuty = dayDutyCounts[wd.dateKey] || 0;
                  return (
                    <th
                      key={wd.dateKey}
                      style={{
                        minWidth: 140,
                        textAlign: 'center',
                        padding: '0.55rem 0.4rem',
                        borderBottom: '2px solid var(--border-light)',
                        backgroundColor: wd.isWeekend
                          ? 'rgba(196, 43, 43, 0.04)'
                          : 'var(--bg-surface-subtle)',
                        borderLeft: '1px solid var(--border-light)',
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: '0.8125rem',
                          color: wd.isToday
                            ? 'var(--primary)'
                            : wd.isWeekend
                            ? 'var(--status-danger)'
                            : 'var(--text-main)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '0.35rem',
                        }}
                      >
                        <span>{wd.dayName}</span>
                        {wd.isToday && (
                          <span
                            className="badge badge-success"
                            style={{ fontSize: '0.6rem', padding: '0.05rem 0.35rem' }}
                          >
                            Today
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                        {wd.shortDate}
                      </div>

                      <div
                        style={{
                          marginTop: '0.3rem',
                          fontSize: '0.68rem',
                          color: onDuty > 0 ? 'var(--primary)' : 'var(--text-subtle)',
                          fontWeight: 600,
                        }}
                      >
                        {onDuty} on duty
                      </div>
                    </th>
                  );
                })}

                {/* Total Weekly Hours Column */}
                <th
                  style={{
                    minWidth: 90,
                    width: 100,
                    textAlign: 'center',
                    padding: '0.65rem 0.5rem',
                    borderBottom: '2px solid var(--border-light)',
                    borderLeft: '1px solid var(--border-light)',
                    backgroundColor: 'var(--bg-surface-subtle)',
                  }}
                >
                  <div style={{ fontWeight: 650, fontSize: '0.8125rem' }}>Weekly</div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 500, color: 'var(--text-muted)' }}>Hours</div>
                </th>
              </tr>
            </thead>

            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '3rem' }}>
                    <div className="row" style={{ justifyContent: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                      <span className="spinner" />
                      <span>Loading weekly schedule...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                    No staff members match your search.
                  </td>
                </tr>
              ) : (
                filteredEmployees.map((emp) => {
                  // Calculate total weekly hours for this employee
                  let totalMinutes = 0;
                  weekDays.forEach((wd) => {
                    const cell = scheduleMap.get(`${emp.id}_${wd.dateKey}`);
                    if (cell && cell.dayType === 'WORK') {
                      totalMinutes += Number(cell.requiredMinutes || 480);
                    }
                  });
                  const totalHours = (totalMinutes / 60).toFixed(1);

                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      {/* Left: Employee Info (Sticky) */}
                      <td
                        style={{
                          position: 'sticky',
                          left: 0,
                          backgroundColor: '#fff',
                          zIndex: 5,
                          padding: '0.65rem 0.9rem',
                          borderRight: '1px solid var(--border-light)',
                          verticalAlign: 'middle',
                        }}
                      >
                        <div style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '0.8125rem' }}>
                          {emp.fullName}
                        </div>
                        <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                          {emp.employeeNumber}
                        </div>
                      </td>

                      {/* 7 Day Dropdown Cells */}
                      {weekDays.map((wd) => {
                        const cell = scheduleMap.get(`${emp.id}_${wd.dateKey}`);
                        const selectedTemplateId = cell?.sourceTemplateId || '';
                        const currentTemplate = templates.find((t) => t.id === selectedTemplateId);

                        // Visual styling
                        let cellBg = 'var(--bg-surface)';
                        let borderColor = 'transparent';
                        let textColor = 'var(--text-main)';

                        if (cell) {
                          if (cell.dayType === 'OFF') {
                            cellBg = 'var(--bg-surface-subtle)';
                            textColor = 'var(--text-muted)';
                          } else if (cell.dayType === 'WORK') {
                            if (cell.templateName?.includes('Morning') || cell.templateName?.includes('Main')) {
                              cellBg = 'var(--primary-soft)';
                              borderColor = 'var(--primary)';
                              textColor = 'var(--primary)';
                            } else if (cell.templateName?.includes('Evening')) {
                              cellBg = 'var(--accent-light)';
                              borderColor = 'var(--accent)';
                              textColor = 'var(--accent)';
                            } else if (cell.templateName?.includes('Split')) {
                              cellBg = 'var(--status-warning-bg)';
                              borderColor = 'var(--status-warning)';
                              textColor = 'var(--status-warning)';
                            } else {
                              cellBg = 'var(--status-info-bg)';
                              borderColor = 'var(--status-info)';
                              textColor = 'var(--status-info)';
                            }
                          }
                        }

                        return (
                          <td
                            key={wd.dateKey}
                            style={{
                              padding: '0.35rem 0.4rem',
                              borderLeft: '1px solid var(--border-subtle)',
                              backgroundColor: cellBg,
                              borderTop: borderColor !== 'transparent' ? `2px solid ${borderColor}` : undefined,
                              verticalAlign: 'middle',
                            }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                              <select
                                className="select"
                                style={{
                                  fontSize: '0.72rem',
                                  padding: '0.3rem 0.45rem',
                                  borderRadius: 'var(--radius-sm)',
                                  fontWeight: 650,
                                  backgroundColor: 'var(--bg-surface)',
                                  color: textColor,
                                  border: '1px solid var(--border-light)',
                                }}
                                value={cell?.dayType === 'OFF' ? 'OFF' : selectedTemplateId}
                                onChange={(e) => handleCellChange(emp.id, wd.dateKey, e.target.value)}
                              >
                                <option value="">-- No Shift --</option>
                                <option value="OFF">Day Off (OFF)</option>
                                <optgroup label="Shift Templates">
                                  {templates.map((tmpl) => (
                                    <option key={tmpl.id} value={tmpl.id}>
                                      {tmpl.name}
                                    </option>
                                  ))}
                                </optgroup>
                              </select>

                              {/* Time badge if template assigned */}
                              {currentTemplate?.intervals?.[0] && cell?.dayType === 'WORK' && (
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.25rem',
                                    fontSize: '0.65rem',
                                    color: 'var(--text-muted)',
                                  }}
                                >
                                  <Clock size={10} />
                                  <span>
                                    {currentTemplate.intervals[0].startLocalTime?.slice(0, 5)} - {currentTemplate.intervals[0].endLocalTime?.slice(0, 5)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}

                      {/* Right: Total Hours */}
                      <td
                        style={{
                          textAlign: 'center',
                          padding: '0.65rem 0.5rem',
                          borderLeft: '1px solid var(--border-light)',
                          verticalAlign: 'middle',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '0.8125rem',
                            color: Number(totalHours) >= 40 ? 'var(--primary)' : 'var(--text-muted)',
                          }}
                        >
                          {totalHours}h
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
