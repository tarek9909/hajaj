import React, { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { todayIso } from '../lib/format';
import { useRestaurant } from '../hooks/useRestaurant';
import { attendanceApi } from '../lib/api';
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Edit,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Calendar,
} from 'lucide-react';

export const AttendancePage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { restaurant } = useRestaurant();
  const tz = restaurant?.timezone || 'UTC';

  // Clock format helpers in the restaurant's timezone
  const toClock = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat('HH:mm');

  const dateParam = searchParams.get('date');
  const [selectedDate, setSelectedDate] = useState<string>(dateParam || todayIso());

  useEffect(() => {
    if (dateParam && dateParam !== selectedDate) {
      setSelectedDate(dateParam);
    }
  }, [dateParam]);
  const [editingDay, setEditingDay] = useState<any | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Form State for modal
  const [formStatus, setFormStatus] = useState<string>('COMPLETED');
  const [checkInTime, setCheckInTime] = useState<string>('09:00');
  const [checkOutTime, setCheckOutTime] = useState<string>('17:00');
  const [additionalWorkApproved, setAdditionalWorkApproved] = useState<boolean>(true);
  const [notes, setNotes] = useState<string>('');

  const { data: attendanceList = [], isLoading } = useQuery({
    queryKey: ['attendance', restaurantId, selectedDate],
    queryFn: () => attendanceApi.getDaily(restaurantId, selectedDate),
  });

  const updateMutation = useMutation({
    mutationFn: (data: { dayId: string; payload: any }) =>
      attendanceApi.updateDay(restaurantId, data.dayId, data.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance', restaurantId, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      queryClient.invalidateQueries({ queryKey: ['warnings'] });
      queryClient.invalidateQueries({ queryKey: ['debt'] });
      setEditingDay(null);
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to update attendance record');
    },
  });

  const openEditModal = (day: any) => {
    setModalError(null);
    setEditingDay(day);

    const planned = day.plannedIntervals?.[0];
    const act = day.actualIntervals?.[0];

    let initIn = '09:00';
    let initOut = '17:00';

    if (act?.checkInAt) {
      initIn = toClock(act.checkInAt);
      initOut = act.checkOutAt ? toClock(act.checkOutAt) : '';
    } else if (planned?.plannedStartAt) {
      initIn = toClock(planned.plannedStartAt);
      initOut = planned.plannedEndAt ? toClock(planned.plannedEndAt) : '';
    }

    setCheckInTime(initIn);
    setCheckOutTime(initOut);
    setFormStatus(day.status === 'NOT_RECORDED' ? 'COMPLETED' : day.status);
    // Auto-approve additional hours by default
    setAdditionalWorkApproved(day.additionalWorkApproved !== undefined ? Boolean(day.additionalWorkApproved) : true);
    setNotes(day.notes || '');
  };

  const handlePrevDay = () => {
    setSelectedDate((prev) => DateTime.fromISO(prev).minus({ days: 1 }).toISODate()!);
  };

  const handleNextDay = () => {
    setSelectedDate((prev) => DateTime.fromISO(prev).plus({ days: 1 }).toISODate()!);
  };

  const handleToday = () => {
    setSelectedDate(todayIso());
  };

  const isToday = selectedDate === todayIso();
  const isPast = selectedDate < todayIso();
  const isUpcoming = selectedDate > todayIso();

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <span className="badge badge-success"><CheckCircle2 size={12} /> Completed</span>;
      case 'IN_PROGRESS':
        return <span className="badge badge-info"><Clock size={12} /> In Progress</span>;
      case 'CONFIRMED_ABSENT':
        return <span className="badge badge-danger"><XCircle size={12} /> Absent</span>;
      case 'EXCUSED':
        return <span className="badge badge-warning">Excused</span>;
      default:
        return <span className="badge badge-neutral">Not Recorded</span>;
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);

    const needsTimes = formStatus === 'COMPLETED' || formStatus === 'IN_PROGRESS';
    if (needsTimes && !checkInTime) {
      setModalError('Check-in time is required');
      return;
    }
    if (formStatus === 'COMPLETED' && !checkOutTime) {
      setModalError('Check-out time is required for completed shifts');
      return;
    }

    // Time is locked strictly to selectedDate
    const checkInInstant = checkInTime
      ? (DateTime.fromISO(`${selectedDate}T${checkInTime}`, { zone: tz }).toUTC().toISO() as string)
      : null;

    let checkOutInstant: string | null = null;
    if (checkOutTime) {
      // If check-out is before check-in, automatically treat as overnight shift on next calendar day
      const isOvernight = checkOutTime < checkInTime;
      const outDate = isOvernight
        ? DateTime.fromISO(selectedDate).plus({ days: 1 }).toISODate()!
        : selectedDate;
      checkOutInstant = DateTime.fromISO(`${outDate}T${checkOutTime}`, { zone: tz }).toUTC().toISO() as string;
    }

    const intervals =
      needsTimes && checkInInstant
        ? [
            {
              sequenceNumber: 1,
              checkInAt: checkInInstant,
              checkOutAt: checkOutInstant,
              unpaidBreakMinutes: 0, // No unpaid break
            },
          ]
        : [];

    // Target identifier: existing attendanceDayId, scheduleDayId, or by-employee for unscheduled days
    let dayId: string;
    if (editingDay.attendanceDayId) {
      dayId = String(editingDay.attendanceDayId);
    } else if (editingDay.scheduleDayId) {
      dayId = `by-schedule/${editingDay.scheduleDayId}`;
    } else {
      dayId = `by-employee/${editingDay.employeeId}?workDate=${selectedDate}`;
    }

    updateMutation.mutate({
      dayId,
      payload: {
        status: formStatus,
        additionalWorkApproved,
        notes: notes || null,
        expectedVersion: editingDay.rowVersion ?? 0,
        intervals,
      },
    });
  };

  return (
    <div>
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            Verify check-in/out times, auto-approve extra hours, and edit previous or upcoming attendance records.
          </p>
        </div>

        {/* Date Navigation Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <div className="period-picker">
              <button
                type="button"
                onClick={handlePrevDay}
                title="Previous Day"
                aria-label="Previous Day"
              >
                <ChevronLeft size={16} />
              </button>

              <button
                type="button"
                onClick={handleToday}
                className={isToday ? 'active' : ''}
                style={{
                  padding: '0.35rem 0.65rem',
                  fontSize: '0.8125rem',
                  fontWeight: isToday ? 700 : 500,
                  color: isToday ? 'var(--primary)' : undefined,
                }}
              >
                Today
              </button>

              <button
                type="button"
                onClick={handleNextDay}
                title="Next Day"
                aria-label="Next Day"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <input
                type="date"
                className="input mono"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ width: 'auto', padding: '0.4rem 0.65rem' }}
              />

              {isPast && <span className="badge badge-neutral">Past Date</span>}
              {isToday && <span className="badge badge-primary">Today</span>}
              {isUpcoming && <span className="badge badge-info">Upcoming Date</span>}
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Calendar size={13} />
            <span>{DateTime.fromISO(selectedDate).toFormat('cccc, LLLL d, yyyy')}</span>
          </div>
        </div>
      </div>

      {/* Attendance Register Table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Staff Member</th>
                <th>Shift Plan</th>
                <th>Actual Intervals</th>
                <th>Worked Time</th>
                <th>Lateness</th>
                <th>Additional Hours</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                    Loading attendance records...
                  </td>
                </tr>
              ) : attendanceList.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No staff records found for {selectedDate}.
                  </td>
                </tr>
              ) : (
                attendanceList.map((record) => {
                  const act = record.actualIntervals?.[0];
                  const plannedStart = record.plannedIntervals?.[0]?.plannedStartAt;
                  const lateMins =
                    act?.checkInAt && plannedStart
                      ? Math.max(0, Math.floor(DateTime.fromISO(act.checkInAt).diff(DateTime.fromISO(plannedStart), 'minutes').minutes))
                      : 0;

                  // Worked minutes without unpaid break deduction
                  const workedMins =
                    act?.checkInAt && act?.checkOutAt
                      ? Math.max(
                          0,
                          Math.floor(DateTime.fromISO(act.checkOutAt).diff(DateTime.fromISO(act.checkInAt), 'minutes').minutes)
                        )
                      : 0;

                  const hasRecordedAttendance = record.status !== 'NOT_RECORDED';

                  return (
                    <tr key={record.attendanceDayId || record.scheduleDayId || record.employeeId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{record.fullName}</div>
                        <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {record.employeeNumber} {record.positionName ? `· ${record.positionName}` : ''}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: '0.8125rem' }}>
                          Required: <strong>{record.requiredMinutes} mins</strong> ({record.requiredMinutes / 60}h)
                        </div>
                        <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {record.templateName || (record.scheduleDayId ? 'Scheduled Shift' : 'Unscheduled')}
                        </div>
                      </td>
                      <td>
                        {act?.checkInAt ? (
                          <div className="mono" style={{ fontSize: '0.8125rem' }}>
                            {toClock(act.checkInAt)} –{' '}
                            {act.checkOutAt ? toClock(act.checkOutAt) : 'Ongoing'}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-subtle)', fontSize: '0.8125rem' }}>No clock data</span>
                        )}
                      </td>
                      <td className="tabular-nums">
                        {workedMins > 0 ? (
                          <span
                            style={{
                              fontWeight: 600,
                              color: workedMins < record.requiredMinutes ? 'var(--status-danger)' : 'var(--status-success)',
                            }}
                          >
                            {workedMins} mins ({Math.floor(workedMins / 60)}h {workedMins % 60}m)
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>0 mins</span>
                        )}
                      </td>
                      <td>
                        {lateMins > 0 ? (
                          <span className="badge badge-danger">
                            <AlertTriangle size={12} />
                            <span>{lateMins}m late</span>
                          </span>
                        ) : (
                          <span className="badge badge-success">On Time</span>
                        )}
                      </td>
                      <td>
                        {record.additionalWorkApproved ? (
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <CheckCircle2 size={12} /> Auto-Approved
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Not Approved</span>
                        )}
                      </td>
                      <td>{getStatusBadge(record.status)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className={`btn ${hasRecordedAttendance ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                          onClick={() => openEditModal(record)}
                        >
                          {hasRecordedAttendance ? <Edit size={14} /> : <Clock size={14} />}
                          <span>{hasRecordedAttendance ? 'Edit Attendance' : 'Record Times'}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Record / Edit Attendance Modal */}
      {editingDay && (
        <div className="modal-backdrop" onClick={() => setEditingDay(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">
                  {editingDay.status !== 'NOT_RECORDED' ? 'Edit Attendance' : 'Record Attendance'}
                </h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {editingDay.fullName} ({editingDay.employeeNumber})
                </p>
              </div>
            </div>

            {/* Selected Date Anchor Display */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.65rem 0.9rem',
                backgroundColor: 'var(--bg-hover)',
                border: '1px solid var(--border-light)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.8125rem',
                marginBottom: '1rem',
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Work Date: </span>
                <strong className="mono" style={{ color: 'var(--primary)' }}>{selectedDate}</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: '0.4rem' }}>
                  ({DateTime.fromISO(selectedDate).toFormat('EEEE, LLLL d')})
                </span>
              </div>
              <span className="badge badge-neutral" style={{ fontSize: '0.7rem' }}>
                Times apply to {selectedDate}
              </span>
            </div>

            {modalError && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  backgroundColor: 'var(--status-danger-bg)',
                  border: '1px solid var(--status-danger-border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--status-danger-text)',
                  fontSize: '0.8125rem',
                  marginBottom: '1rem',
                }}
              >
                <AlertCircle size={16} />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleFormSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Day Attendance Status</label>
                  <select
                    className="select"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value)}
                  >
                    <option value="COMPLETED">Completed Shift</option>
                    <option value="IN_PROGRESS">In Progress (Currently clocked in)</option>
                    <option value="CONFIRMED_ABSENT">Confirmed Absent (Unexcused)</option>
                    <option value="EXCUSED">Excused Absence</option>
                  </select>
                </div>

                {(formStatus === 'COMPLETED' || formStatus === 'IN_PROGRESS') && (
                  <>
                    {/* Time Picker Inputs: ONLY time picker, locked to selected date */}
                    <div className="grid-2">
                      <div className="form-group">
                        <label className="form-label">Actual Check-in Time</label>
                        <input
                          type="time"
                          className="input mono"
                          required
                          value={checkInTime}
                          onChange={(e) => setCheckInTime(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">
                          Actual Check-out Time
                          {formStatus !== 'COMPLETED' && (
                            <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>
                              (Optional)
                            </span>
                          )}
                        </label>
                        <input
                          type="time"
                          className="input mono"
                          required={formStatus === 'COMPLETED'}
                          value={checkOutTime}
                          onChange={(e) => setCheckOutTime(e.target.value)}
                        />
                      </div>
                    </div>

                    {checkInTime && checkOutTime && checkOutTime < checkInTime && (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--primary)',
                          marginTop: '-0.35rem',
                          backgroundColor: 'var(--primary-light)',
                          padding: '0.4rem 0.65rem',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        * Overnight shift: check-out will be recorded on next calendar day (
                        {DateTime.fromISO(selectedDate).plus({ days: 1 }).toISODate()}).
                      </div>
                    )}

                    {/* Auto-Approve Additional Working Hours */}
                    <div
                      className="form-group"
                      style={{
                        backgroundColor: 'var(--bg-hover)',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-light)',
                      }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.55rem',
                          cursor: 'pointer',
                          fontSize: '0.8125rem',
                          fontWeight: 650,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={additionalWorkApproved}
                          onChange={(e) => setAdditionalWorkApproved(e.target.checked)}
                        />
                        <span>Auto-Approve Additional Working Hours</span>
                      </label>
                      <span className="form-hint" style={{ marginTop: '0.2rem', display: 'block', fontSize: '0.75rem' }}>
                        Overtime and additional hours worked beyond schedule are automatically approved for debt recovery.
                      </span>
                    </div>
                  </>
                )}

                <div className="form-group">
                  <label className="form-label">Operational Notes</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    placeholder="Optional notes or reason for deviation..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditingDay(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving & Evaluating...' : 'Save & Evaluate Attendance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
