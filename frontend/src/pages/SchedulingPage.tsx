import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { schedulingApi, configApi, employeesApi } from '../lib/api';
import { usePeriod } from '../context/PeriodContext';
import {
  Calendar,
  CalendarDays,
  Users,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
} from 'lucide-react';
import { currentMonth, monthLabel, shiftMonth, weekStart, todayIso } from '../lib/format';
import { MonthlyShiftCalendar } from '../components/MonthlyShiftCalendar';
import { WeeklyShiftSchedule } from '../components/WeeklyShiftSchedule';

export const SchedulingPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const { month: selectedMonth, setMonth } = usePeriod();
  const [viewMode, setViewMode] = useState<'WEEKLY' | 'CALENDAR' | 'MATRIX'>('WEEKLY');
  const [activeWeekStart, setActiveWeekStart] = useState<string>(() => weekStart(todayIso()));
  const [cellFeedback, setCellFeedback] = useState<string | null>(null);

  const handleWeekChange = (newWeekStart: string) => {
    setActiveWeekStart(newWeekStart);
    const weekMonth = newWeekStart.slice(0, 7);
    if (weekMonth !== selectedMonth) {
      setMonth(weekMonth);
    }
  };

  const handleMonthChange = (newMonth: string) => {
    setMonth(newMonth);
    setActiveWeekStart(weekStart(`${newMonth}-01`));
  };

  const { data: employees = [] } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId, 'ACTIVE'),
  });

  const { data: templates = [] } = useQuery({
    queryKey: ['shift-templates', restaurantId],
    queryFn: () => configApi.getShiftTemplates(restaurantId),
  });

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules', restaurantId, selectedMonth],
    queryFn: () => schedulingApi.getCalendar(restaurantId, selectedMonth),
  });

  // Calculate days in month for Matrix view
  const [yearStr, monthStr] = selectedMonth.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monthStr), 0).getDate();
  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Map schedules by employeeId_workDate
  const scheduleMap = new Map<string, any>();
  schedules.forEach((s) => {
    scheduleMap.set(`${s.employeeId}_${s.workDate}`, s);
  });

  const handleQuickCellChange = async (employeeId: string, workDate: string, value: string) => {
    try {
      const dayType = value === 'OFF' ? 'OFF' : value === '' ? 'CLEAR' : 'WORK';
      const shiftTemplateId = dayType === 'WORK' ? value : null;
      await schedulingApi.batchSchedule(restaurantId, {
        assignments: [{ employeeId, workDate, dayType, shiftTemplateId }],
      });
      queryClient.invalidateQueries({ queryKey: ['schedules', restaurantId] });
      queryClient.invalidateQueries({ queryKey: ['schedules-range', restaurantId] });
      setCellFeedback(`Shift updated for ${workDate}`);
      setTimeout(() => setCellFeedback(null), 2500);
    } catch (err: any) {
      alert(err.message || 'Failed to update schedule');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Schedule
          </h1>
          <p className="page-subtitle">
            Single source of truth scheduling: interactive Weekly schedule, Monthly calendar, and Staff Matrix grid synced in real-time.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="segmented">
            <button
              type="button"
              className={viewMode === 'WEEKLY' ? 'active' : ''}
              onClick={() => setViewMode('WEEKLY')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <CalendarDays size={15} />
              <span>Weekly Schedule</span>
            </button>
            <button
              type="button"
              className={viewMode === 'CALENDAR' ? 'active' : ''}
              onClick={() => setViewMode('CALENDAR')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <Calendar size={15} />
              <span>Monthly Calendar</span>
            </button>
            <button
              type="button"
              className={viewMode === 'MATRIX' ? 'active' : ''}
              onClick={() => setViewMode('MATRIX')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <Users size={15} />
              <span>Staff Matrix Grid</span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'WEEKLY' ? (
        <WeeklyShiftSchedule
          restaurantId={restaurantId}
          employees={employees}
          templates={templates}
          selectedWeekStart={activeWeekStart}
          onWeekChange={handleWeekChange}
        />
      ) : viewMode === 'CALENDAR' ? (
        <MonthlyShiftCalendar
          restaurantId={restaurantId}
          selectedMonth={selectedMonth}
          onMonthChange={handleMonthChange}
          employees={employees}
          templates={templates}
          schedules={schedules}
        />
      ) : (
        <>
          {/* Matrix Month Navigation & Controls Card */}
          <div
            className="card"
            style={{
              padding: '0.85rem 1.25rem',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm btn-icon"
                title="Previous Month"
                onClick={() => handleMonthChange(shiftMonth(selectedMonth, -1))}
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
                onClick={() => handleMonthChange(shiftMonth(selectedMonth, 1))}
              >
                <ChevronRight size={16} />
              </button>

              {selectedMonth !== currentMonth() && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleMonthChange(currentMonth())}
                >
                  Current Month
                </button>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {cellFeedback && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    fontSize: '0.75rem',
                    color: 'var(--status-success-text)',
                    fontWeight: 600,
                  }}
                >
                  <CheckCircle2 size={14} />
                  <span>{cellFeedback}</span>
                </div>
              )}
              <span className="badge badge-success" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <CheckCircle2 size={13} />
                <span>Live Synced</span>
              </span>
            </div>
          </div>

          {/* Grid Legend */}
          <div
            className="card"
            style={{
              padding: '0.75rem 1.25rem',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '1.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              Shift Legend:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: 'var(--primary)' }} />
              <span>Morning Shift</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: 'var(--accent)' }} />
              <span>Evening Shift</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: 'var(--status-warning)' }} />
              <span>Split Shift</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  backgroundColor: 'var(--border-light)',
                  border: '1px solid var(--border-strong)',
                }}
              />
              <span>Day Off (OFF)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>Select dropdown in any cell to change live.</span>
            </div>
          </div>

          {/* Matrix Table */}
          <div className="card" style={{ padding: 0 }}>
            <div className="table-container" style={{ border: 'none', maxHeight: '70vh' }}>
              <table className="table" style={{ fontSize: '0.75rem' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                  <tr>
                    <th
                      style={{
                        minWidth: 160,
                        position: 'sticky',
                        left: 0,
                        zIndex: 20,
                        backgroundColor: 'var(--bg-surface-subtle)',
                      }}
                    >
                      Employee
                    </th>
                    {dayNumbers.map((d) => {
                      const dStr = d < 10 ? `0${d}` : `${d}`;
                      const dateObj = new Date(`${selectedMonth}-${dStr}T00:00:00Z`);
                      const dayName = dateObj.toLocaleDateString('en-US', {
                        weekday: 'narrow',
                        timeZone: 'UTC',
                      });
                      const isWeekend = dateObj.getUTCDay() === 0;

                      return (
                        <th
                          key={d}
                          style={{
                            textAlign: 'center',
                            minWidth: 42,
                            padding: '0.4rem 0.2rem',
                            backgroundColor: isWeekend ? 'var(--status-danger-bg)' : undefined,
                            color: isWeekend ? 'var(--status-danger-text)' : undefined,
                          }}
                        >
                          <div>{dayName}</div>
                          <div style={{ fontWeight: 700 }}>{d}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={daysInMonth + 1} style={{ textAlign: 'center', padding: '2rem' }}>
                        Loading schedules...
                      </td>
                    </tr>
                  ) : employees.length === 0 ? (
                    <tr>
                      <td colSpan={daysInMonth + 1} style={{ textAlign: 'center', padding: '2rem' }}>
                        No active employees configured.
                      </td>
                    </tr>
                  ) : (
                    employees.map((emp) => (
                      <tr key={emp.id}>
                        <td
                          style={{
                            position: 'sticky',
                            left: 0,
                            backgroundColor: '#fff',
                            zIndex: 5,
                            fontWeight: 600,
                            borderRight: '1px solid var(--border-light)',
                          }}
                        >
                          <div>{emp.fullName}</div>
                          <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                            {emp.employeeNumber}
                          </div>
                        </td>

                        {dayNumbers.map((d) => {
                          const dStr = d < 10 ? `0${d}` : `${d}`;
                          const workDate = `${selectedMonth}-${dStr}`;
                          const cell = scheduleMap.get(`${emp.id}_${workDate}`);

                          let bg = 'var(--bg-surface-subtle)';
                          let label = '-';
                          let color = 'var(--text-subtle)';

                          if (cell) {
                            if (cell.dayType === 'OFF') {
                              bg = 'var(--border-light)';
                              label = 'OFF';
                              color = 'var(--text-muted)';
                            } else if (cell.templateName?.includes('Morning') || cell.templateName?.includes('Main')) {
                              bg = 'var(--primary-light)';
                              label = 'MORN';
                              color = 'var(--primary)';
                            } else if (cell.templateName?.includes('Evening')) {
                              bg = 'var(--accent-light)';
                              label = 'EVE';
                              color = 'var(--accent)';
                            } else if (cell.templateName?.includes('Split')) {
                              bg = 'var(--status-warning-bg)';
                              label = 'SPLIT';
                              color = 'var(--status-warning)';
                            } else {
                              bg = 'var(--status-info-bg)';
                              label = 'WORK';
                              color = 'var(--status-info-text)';
                            }
                          }

                          return (
                            <td
                              key={d}
                              style={{
                                textAlign: 'center',
                                padding: '0.15rem',
                                borderRight: '1px solid var(--border-subtle)',
                              }}
                            >
                              <select
                                style={{
                                  backgroundColor: bg,
                                  color: color,
                                  fontWeight: 700,
                                  fontSize: '0.68rem',
                                  padding: '0.35rem 0.05rem',
                                  borderRadius: 4,
                                  border: '1px solid transparent',
                                  width: '100%',
                                  cursor: 'pointer',
                                  textAlign: 'center',
                                  appearance: 'none',
                                  outline: 'none',
                                }}
                                value={cell?.dayType === 'OFF' ? 'OFF' : cell?.sourceTemplateId || ''}
                                onChange={(e) => handleQuickCellChange(emp.id, workDate, e.target.value)}
                                title={`${emp.fullName} - ${workDate}: ${cell?.templateName || label}`}
                              >
                                <option value="">-</option>
                                <option value="OFF">OFF</option>
                                {templates.map((tmpl) => (
                                  <option key={tmpl.id} value={tmpl.id}>
                                    {tmpl.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
