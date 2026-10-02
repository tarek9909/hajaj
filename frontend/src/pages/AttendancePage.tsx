import { todayIso } from '../lib/format';
import { DateTime } from 'luxon';
import { useRestaurant } from '../hooks/useRestaurant';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from '../lib/api';
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Edit,
  AlertTriangle,
} from 'lucide-react';

export const AttendancePage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();
  const { restaurant } = useRestaurant();
  const tz = restaurant?.timezone || 'UTC';

  // Clock times are entered and shown in the restaurant's timezone, stored as UTC instants
  const toLocalInput = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm");
  const toClock = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat('HH:mm');
  const toInstant = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO() as string;

  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [editingDay, setEditingDay] = useState<any | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Edit Form State
  const [formState, setFormState] = useState({
    status: 'COMPLETED' as any,
    additionalWorkApproved: false,
    notes: '',
    intervals: [
      {
        sequenceNumber: 1,
        checkInAt: '',
        checkOutAt: '',
        unpaidBreakMinutes: 30,
      },
    ],
  });

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
    const intv = day.actualIntervals?.[0] || {
      checkInAt: planned?.plannedStartAt ?? null,
      checkOutAt: planned?.plannedEndAt ?? null,
      unpaidBreakMinutes: planned?.plannedUnpaidBreakMinutes ?? 30,
    };

    setFormState({
      status: day.status === 'NOT_RECORDED' ? 'COMPLETED' : day.status,
      additionalWorkApproved: Boolean(day.additionalWorkApproved),
      notes: day.notes || '',
      intervals: [
        {
          sequenceNumber: 1,
          checkInAt: intv.checkInAt ? toLocalInput(intv.checkInAt) : `${selectedDate}T08:00`,
          checkOutAt: intv.checkOutAt ? toLocalInput(intv.checkOutAt) : `${selectedDate}T16:30`,
          unpaidBreakMinutes: intv.unpaidBreakMinutes ?? 30,
        },
      ],
    });
  };

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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Attendance
          </h1>
          <p className="page-subtitle">
            Verify check-in/out times, approve extra hours, and trigger automatic debt/lateness evaluations.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Work Date:</span>
          <input
            type="date"
            className="input mono"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={{ width: 'auto', padding: '0.4rem 0.75rem' }}
          />
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
                <th>Extra Work Approval</th>
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
                    No shifts scheduled for {selectedDate}. Use Shift Schedules to assign staff.
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
                  const workedMins =
                    act?.checkInAt && act?.checkOutAt
                      ? Math.max(
                          0,
                          Math.floor(DateTime.fromISO(act.checkOutAt).diff(DateTime.fromISO(act.checkInAt), 'minutes').minutes) -
                            (act.unpaidBreakMinutes || 0)
                        )
                      : 0;

                  return (
                    <tr key={record.attendanceDayId || record.scheduleDayId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{record.fullName}</div>
                        <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {record.employeeNumber}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: '0.8125rem' }}>
                          Required: <strong>{record.requiredMinutes} mins</strong> ({record.requiredMinutes / 60}h)
                        </div>
                        <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {record.dayType === 'WORK' ? 'Scheduled Shift' : record.dayType}
                        </div>
                      </td>
                      <td>
                        {act?.checkInAt ? (
                          <div className="mono" style={{ fontSize: '0.8125rem' }}>
                            {toClock(act.checkInAt)} -{' '}
                            {act.checkOutAt ? toClock(act.checkOutAt) : 'Ongoing'}
                            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                              (Break: {act.unpaidBreakMinutes || 0}m)
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-subtle)', fontSize: '0.8125rem' }}>No clock data</span>
                        )}
                      </td>
                      <td className="tabular-nums">
                        {workedMins > 0 ? (
                          <span style={{ fontWeight: 600, color: workedMins < record.requiredMinutes ? 'var(--status-danger)' : 'var(--status-success)' }}>
                            {workedMins} mins
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
                          <span className="badge badge-success">Approved</span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Unapproved</span>
                        )}
                      </td>
                      <td>{getStatusBadge(record.status)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => openEditModal(record)}
                        >
                          <Edit size={14} />
                          <span>Record Times</span>
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

      {/* Record Attendance Modal */}
      {editingDay && (
        <div className="modal-backdrop" onClick={() => setEditingDay(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Record Attendance</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {editingDay.fullName} · Work Date: {selectedDate}
                </p>
              </div>
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

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setModalError(null);
                updateMutation.mutate({
                  dayId: editingDay.attendanceDayId ?? `by-schedule/${editingDay.scheduleDayId}`,
                  payload: {
                    status: formState.status,
                    additionalWorkApproved: formState.additionalWorkApproved,
                    notes: formState.notes,
                    expectedVersion: editingDay.rowVersion ?? 0,
                    intervals: formState.intervals.map((i) => ({
                      sequenceNumber: i.sequenceNumber,
                      checkInAt: toInstant(i.checkInAt),
                      checkOutAt: i.checkOutAt ? toInstant(i.checkOutAt) : null,
                      unpaidBreakMinutes: Number(i.unpaidBreakMinutes),
                    })),
                  },
                });
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Day Attendance Status</label>
                  <select
                    className="select"
                    value={formState.status}
                    onChange={(e) => setFormState({ ...formState, status: e.target.value })}
                  >
                    <option value="COMPLETED">Completed Shift</option>
                    <option value="IN_PROGRESS">In Progress (Currently clocked in)</option>
                    <option value="CONFIRMED_ABSENT">Confirmed Absent (Unexcused)</option>
                    <option value="EXCUSED">Excused Absence</option>
                  </select>
                </div>

                {formState.status === 'COMPLETED' && (
                  <>
                    <div className="grid-2">
                      <div className="form-group">
                        <label className="form-label">Actual Check-in Time</label>
                        <input
                          type="datetime-local"
                          className="input mono"
                          required
                          value={formState.intervals[0]?.checkInAt}
                          onChange={(e) => {
                            const newInt = [...formState.intervals];
                            const first = newInt[0];
                            if (first) {
                              newInt[0] = { ...first, checkInAt: e.target.value };
                              setFormState({ ...formState, intervals: newInt });
                            }
                          }}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Actual Check-out Time</label>
                        <input
                          type="datetime-local"
                          className="input mono"
                          required
                          value={formState.intervals[0]?.checkOutAt}
                          onChange={(e) => {
                            const newInt = [...formState.intervals];
                            const first = newInt[0];
                            if (first) {
                              newInt[0] = { ...first, checkOutAt: e.target.value };
                              setFormState({ ...formState, intervals: newInt });
                            }
                          }}
                        />
                      </div>
                    </div>

                    <div className="grid-2">
                      <div className="form-group">
                        <label className="form-label">Unpaid Break (Minutes)</label>
                        <input
                          type="number"
                          className="input tabular-nums"
                          value={formState.intervals[0]?.unpaidBreakMinutes}
                          onChange={(e) => {
                            const newInt = [...formState.intervals];
                            const first = newInt[0];
                            if (first) {
                              newInt[0] = { ...first, unpaidBreakMinutes: Number(e.target.value) };
                              setFormState({ ...formState, intervals: newInt });
                            }
                          }}
                        />
                      </div>

                      <div className="form-group" style={{ justifyContent: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>
                          <input
                            type="checkbox"
                            checked={formState.additionalWorkApproved}
                            onChange={(e) => setFormState({ ...formState, additionalWorkApproved: e.target.checked })}
                          />
                          <span>Approve Additional Working Time</span>
                        </label>
                        <span className="form-hint">Enables debt recovery and overtime calculation.</span>
                      </div>
                    </div>
                  </>
                )}

                <div className="form-group">
                  <label className="form-label">Operational Notes</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    placeholder="Optional notes or reason for deviation..."
                    value={formState.notes}
                    onChange={(e) => setFormState({ ...formState, notes: e.target.value })}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setEditingDay(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={updateMutation.isPending}>
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
