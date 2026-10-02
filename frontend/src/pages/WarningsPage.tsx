import { usePeriod } from '../context/PeriodContext';
import { todayIso } from '../lib/format';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warningsApi, employeesApi } from '../lib/api';
import {
  Plus,
  Ban,
  AlertCircle,
  Clock,
  ShieldAlert,
} from 'lucide-react';

export const WarningsPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const { month: selectedMonth } = usePeriod();
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [voidingWarning, setVoidingWarning] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Custom Warning Form
  const [customForm, setCustomForm] = useState({
    employeeId: '',
    incidentDate: todayIso(),
    title: '',
    reason: '',
    countsTowardLimit: true,
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId, 'ACTIVE'),
  });

  const { data: warningsData, isLoading } = useQuery({
    queryKey: ['warnings', restaurantId, selectedMonth],
    queryFn: () => warningsApi.list(restaurantId, selectedMonth),
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof customForm) => warningsApi.createCustom(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['warnings', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setShowCustomModal(false);
      setCustomForm({
        employeeId: '',
        incidentDate: todayIso(),
        title: '',
        reason: '',
        countsTowardLimit: true,
      });
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to issue custom warning');
    },
  });

  const voidMutation = useMutation({
    mutationFn: (data: { warningId: string; voidReason: string; expectedVersion: number }) =>
      warningsApi.voidWarning(restaurantId, data.warningId, {
        voidReason: data.voidReason,
        expectedVersion: data.expectedVersion,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['warnings', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setVoidingWarning(null);
      setVoidReason('');
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to void warning');
    },
  });

  const threshold = warningsData?.threshold ?? 3;
  const warningsList = warningsData?.warnings ?? [];
  const countsMap = warningsData?.employeeWarningCounts ?? {};

  const employeesAtLimit = Object.entries(countsMap).filter(([_, stats]) => stats.limitReached);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Warnings
          </h1>
          <p className="page-subtitle">
            Automated lateness penalties, custom administrative warnings, and monthly threshold limits.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => { setModalError(null); setShowCustomModal(true); }}>
            <Plus size={16} />
            <span>Issue Custom Warning</span>
          </button>
        </div>
      </div>

      {/* Threshold Limit Alert Bar */}
      {employeesAtLimit.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            padding: '1rem 1.25rem',
            backgroundColor: 'var(--status-danger-bg)',
            border: '1px solid var(--status-danger-border)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: '1.75rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--status-danger-text)', fontSize: '0.9rem' }}>
            <ShieldAlert size={20} />
            <span>Warning Threshold Exceeded Alert (Monthly Limit: {threshold})</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.25rem' }}>
            {employeesAtLimit.map(([empId, stats]) => {
              const emp = employees.find((e) => e.id === empId);
              return (
                <div key={empId} className="warning-dot-limit" style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }}>
                  {emp?.fullName || `Employee #${empId}`}: {stats.counted}/{threshold} warnings · Limit reached
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Warnings Table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Origin</th>
                <th>Title / Offense</th>
                <th>Details / Reason</th>
                <th>Threshold Count</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                    Loading warnings ledger...
                  </td>
                </tr>
              ) : warningsList.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No warnings recorded for {selectedMonth}. Excellent discipline!
                  </td>
                </tr>
              ) : (
                warningsList.map((w) => {
                  const empCounts = countsMap[w.employeeId];
                  const isLimitHit = empCounts?.limitReached;

                  return (
                    <tr key={w.id} style={{ opacity: w.adminVoided ? 0.6 : 1 }}>
                      <td className="mono" style={{ fontSize: '0.8125rem' }}>
                        {w.incidentDate}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{w.fullName}</div>
                        <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {w.employeeNumber}
                        </div>
                      </td>
                      <td>
                        {w.origin === 'AUTOMATIC_LATE' ? (
                          <span className="badge badge-warning">
                            <Clock size={12} />
                            <span>Auto Late ({w.lateMinutes}m)</span>
                          </span>
                        ) : (
                          <span className="badge badge-info">Custom Admin</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{w.title}</td>
                      <td style={{ fontSize: '0.8125rem', color: 'var(--text-main)', maxWidth: '280px' }}>
                        <div>{w.reason}</div>
                        {w.adminVoided && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--status-danger)', marginTop: 4 }}>
                            Void reason: {w.voidReason}
                          </div>
                        )}
                      </td>
                      <td>
                        {w.countsTowardLimit ? (
                          <span className={isLimitHit ? 'warning-dot-limit' : 'badge badge-neutral'}>
                            Counts ({empCounts?.counted || 1}/{threshold})
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Excluded</span>
                        )}
                      </td>
                      <td>
                        {w.adminVoided ? (
                          <span className="badge badge-danger">Voided</span>
                        ) : (
                          <span className="badge badge-success">Active</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!w.adminVoided && (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ color: 'var(--status-danger)' }}
                            onClick={() => {
                              setModalError(null);
                              setVoidReason('');
                              setVoidingWarning(w);
                            }}
                          >
                            <Ban size={14} />
                            <span>Void</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Issue Custom Warning Modal */}
      {showCustomModal && (
        <div className="modal-backdrop" onClick={() => setShowCustomModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Issue Custom Disciplinary Warning</h2>
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
                createMutation.mutate(customForm);
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Employee</label>
                  <select
                    className="select"
                    required
                    value={customForm.employeeId}
                    onChange={(e) => setCustomForm({ ...customForm, employeeId: e.target.value })}
                  >
                    <option value="">Select employee...</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName} ({emp.employeeNumber})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Incident Date</label>
                    <input
                      type="date"
                      className="input mono"
                      required
                      value={customForm.incidentDate}
                      onChange={(e) => setCustomForm({ ...customForm, incidentDate: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Warning Title / Summary</label>
                    <input
                      type="text"
                      className="input"
                      required
                      placeholder="e.g. Uniform Non-compliance"
                      value={customForm.title}
                      onChange={(e) => setCustomForm({ ...customForm, title: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Detailed Factual Reason</label>
                  <textarea
                    className="textarea"
                    rows={3}
                    required
                    placeholder="Provide objective facts of the incident observed..."
                    value={customForm.reason}
                    onChange={(e) => setCustomForm({ ...customForm, reason: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={customForm.countsTowardLimit}
                      onChange={(e) => setCustomForm({ ...customForm, countsTowardLimit: e.target.checked })}
                    />
                    <span>Counts toward monthly warning threshold limit ({threshold})</span>
                  </label>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCustomModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Recording...' : 'Issue Warning'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Void Warning Modal */}
      {voidingWarning && (
        <div className="modal-backdrop" onClick={() => setVoidingWarning(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Void Warning Record</h2>
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
                voidMutation.mutate({
                  warningId: voidingWarning.id,
                  voidReason,
                  expectedVersion: voidingWarning.rowVersion,
                });
              }}
            >
              <p style={{ fontSize: '0.875rem', color: 'var(--text-main)', marginBottom: '1rem' }}>
                Are you sure you want to void warning <strong>"{voidingWarning.title}"</strong> for{' '}
                <strong>{voidingWarning.fullName}</strong>? This action is immutable and logged in the audit ledger.
              </p>

              <div className="form-group">
                <label className="form-label">Mandatory Void Justification</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="Explain why this warning is being voided (e.g. Excused emergency proof provided)..."
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setVoidingWarning(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-danger" disabled={voidMutation.isPending}>
                  {voidMutation.isPending ? 'Voiding...' : 'Confirm Void Warning'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
