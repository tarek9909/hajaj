import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { schedulingApi, configApi, employeesApi } from '../lib/api';
import {
  Sparkles,
  AlertCircle,
} from 'lucide-react';

export const SchedulingPage: React.FC = () => {
  const { restaurantId = '1' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const [selectedMonth, setSelectedMonth] = useState('2026-09');
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [previewResult, setPreviewResult] = useState<any | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Bulk Generator State
  const [bulkForm, setBulkForm] = useState({
    employeeIds: [] as string[],
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    shiftTemplateId: '',
    dayType: 'WORK' as 'WORK' | 'OFF',
    overwriteExisting: true,
  });

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

  const previewMutation = useMutation({
    mutationFn: (data: typeof bulkForm) => schedulingApi.previewBulk(restaurantId, data),
    onSuccess: (res) => {
      setPreviewResult(res);
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to preview schedule generation');
    },
  });

  const commitMutation = useMutation({
    mutationFn: (data: typeof bulkForm) => schedulingApi.commitBulk(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules', restaurantId, selectedMonth] });
      setShowBulkModal(false);
      setPreviewResult(null);
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to commit schedules');
    },
  });

  // Calculate days in month
  const [yearStr, monthStr] = selectedMonth.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monthStr), 0).getDate();
  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Map schedules by employeeId_workDate
  const scheduleMap = new Map<string, any>();
  schedules.forEach((s) => {
    scheduleMap.set(`${s.employeeId}_${s.workDate}`, s);
  });

  const handleSelectAllEmployees = () => {
    if (bulkForm.employeeIds.length === employees.length) {
      setBulkForm({ ...bulkForm, employeeIds: [] });
    } else {
      setBulkForm({ ...bulkForm, employeeIds: employees.map((e) => e.id) });
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
            Shift Scheduling Matrix
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Monthly calendar grid of planned shifts, interval requirements, and multi-staff bulk assignment.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Month:</span>
            <input
              type="month"
              className="input"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              style={{ width: 'auto', padding: '0.4rem 0.6rem' }}
            />
          </div>

          <button className="btn btn-primary" onClick={() => { setModalError(null); setPreviewResult(null); setShowBulkModal(true); }}>
            <Sparkles size={16} />
            <span>Bulk Shift Generator</span>
          </button>
        </div>
      </div>

      {/* Grid Legend */}
      <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Shift Legend:</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: '#0f766e' }} />
          <span>Morning (08:00 - 16:30, 480m)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: '#4338ca' }} />
          <span>Evening (16:00 - 00:30, 480m)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: '#b45309' }} />
          <span>Split Lunch/Dinner (480m)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: '#e2e8f0', border: '1px solid #cbd5e1' }} />
          <span>Day Off (0m)</span>
        </div>
      </div>

      {/* Matrix Table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-container" style={{ border: 'none', maxHeight: '70vh' }}>
          <table className="table" style={{ fontSize: '0.75rem' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr>
                <th style={{ minWidth: 160, position: 'sticky', left: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>
                  Employee
                </th>
                {dayNumbers.map((d) => {
                  const dStr = d < 10 ? `0${d}` : `${d}`;
                  const dateObj = new Date(`${selectedMonth}-${dStr}T00:00:00Z`);
                  const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });
                  const isWeekend = dateObj.getUTCDay() === 0;

                  return (
                    <th
                      key={d}
                      style={{
                        textAlign: 'center',
                        minWidth: 40,
                        padding: '0.4rem 0.2rem',
                        backgroundColor: isWeekend ? '#fee2e2' : undefined,
                        color: isWeekend ? '#991b1b' : undefined,
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

                      let bg = '#f8fafc';
                      let label = '-';
                      let color = '#94a3b8';

                      if (cell) {
                        if (cell.dayType === 'OFF') {
                          bg = '#e2e8f0';
                          label = 'OFF';
                          color = '#64748b';
                        } else if (cell.templateName?.includes('Morning') || cell.templateName?.includes('Main')) {
                          bg = '#ccfbf1';
                          label = 'MORN';
                          color = '#0f766e';
                        } else if (cell.templateName?.includes('Evening')) {
                          bg = '#e0e7ff';
                          label = 'EVE';
                          color = '#4338ca';
                        } else if (cell.templateName?.includes('Split')) {
                          bg = '#fef3c7';
                          label = 'SPLIT';
                          color = '#b45309';
                        } else {
                          bg = '#dbeafe';
                          label = 'WORK';
                          color = '#1e40af';
                        }
                      }

                      return (
                        <td
                          key={d}
                          style={{
                            textAlign: 'center',
                            padding: '0.25rem',
                            borderRight: '1px solid #f1f5f9',
                          }}
                        >
                          <div
                            style={{
                              backgroundColor: bg,
                              color: color,
                              fontWeight: 700,
                              fontSize: '0.68rem',
                              padding: '0.35rem 0.1rem',
                              borderRadius: 4,
                            }}
                          >
                            {label}
                          </div>
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

      {/* Bulk Shift Generator Modal */}
      {showBulkModal && (
        <div className="modal-backdrop" onClick={() => setShowBulkModal(false)}>
          <div className="modal-content" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Bulk Shift Generator</h2>
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
                  color: '#991b1b',
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
                previewMutation.mutate(bulkForm);
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                    <label className="form-label" style={{ marginBottom: 0 }}>
                      Select Employees ({bulkForm.employeeIds.length} of {employees.length})
                    </label>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                      onClick={handleSelectAllEmployees}
                    >
                      {bulkForm.employeeIds.length === employees.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div
                    style={{
                      maxHeight: '130px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-light)',
                      borderRadius: 'var(--radius-md)',
                      padding: '0.5rem',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, 1fr)',
                      gap: '0.35rem',
                    }}
                  >
                    {employees.map((emp) => (
                      <label key={emp.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8125rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={bulkForm.employeeIds.includes(emp.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setBulkForm({ ...bulkForm, employeeIds: [...bulkForm.employeeIds, emp.id] });
                            } else {
                              setBulkForm({ ...bulkForm, employeeIds: bulkForm.employeeIds.filter((id) => id !== emp.id) });
                            }
                          }}
                        />
                        <span>{emp.fullName}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">From Date</label>
                    <input
                      type="date"
                      className="input"
                      required
                      value={bulkForm.startDate}
                      onChange={(e) => setBulkForm({ ...bulkForm, startDate: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">To Date</label>
                    <input
                      type="date"
                      className="input"
                      required
                      value={bulkForm.endDate}
                      onChange={(e) => setBulkForm({ ...bulkForm, endDate: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Day Classification</label>
                    <select
                      className="select"
                      value={bulkForm.dayType}
                      onChange={(e) => setBulkForm({ ...bulkForm, dayType: e.target.value as any })}
                    >
                      <option value="WORK">Working Day</option>
                      <option value="OFF">Day Off</option>
                    </select>
                  </div>

                  {bulkForm.dayType === 'WORK' && (
                    <div className="form-group">
                      <label className="form-label">Shift Template</label>
                      <select
                        className="select"
                        required
                        value={bulkForm.shiftTemplateId}
                        onChange={(e) => setBulkForm({ ...bulkForm, shiftTemplateId: e.target.value })}
                      >
                        <option value="">Select template...</option>
                        {templates.map((tmpl) => (
                          <option key={tmpl.id} value={tmpl.id}>
                            {tmpl.name} ({tmpl.intervals?.[0]?.startLocalTime?.slice(0, 5)} - {tmpl.intervals?.[0]?.endLocalTime?.slice(0, 5)})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Preview Results Box */}
                {previewResult && (
                  <div
                    style={{
                      padding: '0.85rem',
                      backgroundColor: 'var(--status-info-bg)',
                      border: '1px solid var(--status-info-border)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '0.8125rem',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: '#1e3a8a', marginBottom: '0.25rem' }}>
                      Generation Plan Ready
                    </div>
                    <div>
                      Target shifts to write: <strong>{previewResult.totalDaysToGenerate} days</strong>
                    </div>
                    <div>
                      Existing schedule conflicts / overwrites: <strong>{previewResult.conflictCount}</strong>
                    </div>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowBulkModal(false)}>
                  Cancel
                </button>
                {!previewResult ? (
                  <button
                    type="submit"
                    className="btn btn-secondary"
                    disabled={previewMutation.isPending || bulkForm.employeeIds.length === 0}
                  >
                    {previewMutation.isPending ? 'Analyzing Plan...' : 'Preview Plan'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={commitMutation.isPending}
                    onClick={() => commitMutation.mutate(bulkForm)}
                  >
                    {commitMutation.isPending ? 'Committing Shifts...' : 'Commit Generated Shifts'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
