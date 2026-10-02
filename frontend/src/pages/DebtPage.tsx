import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { debtApi, employeesApi } from '../lib/api';
import {
  Scale,
  Plus,
  Ban,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

export const DebtPage: React.FC = () => {
  const { restaurantId = '1' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const [selectedMonth, setSelectedMonth] = useState('2026-09');
  const [showWaiverModal, setShowWaiverModal] = useState(false);
  const [voidingWaiver, setVoidingWaiver] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Waiver Form State
  const [waiverForm, setWaiverForm] = useState({
    employeeId: '',
    debtSourceId: '',
    effectiveMonth: '2026-09-01',
    minutes: 60,
    reason: '',
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId, 'ACTIVE'),
  });

  const { data: debtData, isLoading } = useQuery({
    queryKey: ['debt', restaurantId, selectedMonth],
    queryFn: () => debtApi.list(restaurantId, selectedMonth),
  });

  const createWaiverMutation = useMutation({
    mutationFn: (data: typeof waiverForm) => debtApi.createWaiver(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['debt', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setShowWaiverModal(false);
      setWaiverForm({
        employeeId: '',
        debtSourceId: '',
        effectiveMonth: '2026-09-01',
        minutes: 60,
        reason: '',
      });
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to issue debt waiver');
    },
  });

  const voidWaiverMutation = useMutation({
    mutationFn: (data: { waiverId: string; voidReason: string; expectedVersion: number }) =>
      debtApi.voidWaiver(restaurantId, data.waiverId, {
        voidReason: data.voidReason,
        expectedVersion: data.expectedVersion,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['debt', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setVoidingWaiver(null);
      setVoidReason('');
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to void waiver');
    },
  });

  const sourcesList = debtData?.sources ?? [];
  const waiversList = debtData?.waivers ?? [];

  const employeeDebtSources = sourcesList.filter((s) => s.employeeId === waiverForm.employeeId);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
            Working-Hour Debt & Waivers Ledger
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Authoritative tracking of attendance shortfall lots, debt recovery, and official administrative waivers.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="select"
            style={{ width: 'auto' }}
          >
            <option value="2026-09">September 2026 (Open)</option>
            <option value="2026-08">August 2026 (Finalized)</option>
          </select>
          <button className="btn btn-primary" onClick={() => { setModalError(null); setShowWaiverModal(true); }}>
            <Plus size={16} />
            <span>Grant Debt Waiver</span>
          </button>
        </div>
      </div>

      {/* Governing Rule Banner */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          padding: '1.25rem 1.5rem',
          backgroundColor: '#f8fafc',
          border: '1px solid #cbd5e1',
          borderRadius: 'var(--radius-lg)',
          marginBottom: '2rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--primary)', fontSize: '0.95rem' }}>
          <Scale size={20} />
          <span>Governing Principle: "DEBT BEFORE OVERTIME"</span>
        </div>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-main)', lineHeight: 1.5 }}>
          Additional working time performed on any day must satisfy existing working-hour debt before any remaining time becomes eligible payable overtime.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            paddingTop: '0.5rem',
            borderTop: '1px solid #e2e8f0',
          }}
        >
          <div style={{ fontSize: '0.78rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>1. Recovered Minutes:</span>
            <div className="mono" style={{ color: 'var(--primary)', marginTop: 2 }}>
              min(Debt Available, Extra Minutes)
            </div>
          </div>
          <div style={{ fontSize: '0.78rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>2. Eligible Overtime:</span>
            <div className="mono" style={{ color: 'var(--accent)', marginTop: 2 }}>
              Extra Minutes - Recovered Minutes
            </div>
          </div>
          <div style={{ fontSize: '0.78rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>3. Closing Balance:</span>
            <div className="mono" style={{ color: '#b45309', marginTop: 2 }}>
              Debt Available - Recovered Minutes
            </div>
          </div>
        </div>
      </div>

      {/* Active Debt Sources Table */}
      <div className="card" style={{ padding: 0, marginBottom: '2rem' }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Working-Hour Debt Lots</h2>
        </div>

        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Origin Date</th>
                <th>Debt Source Type</th>
                <th>Original Shortfall</th>
                <th>Waived Minutes</th>
                <th>Net Debt Outstanding</th>
                <th>Waiver Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                    Loading debt lots...
                  </td>
                </tr>
              ) : sourcesList.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No outstanding hour debt lots recorded. All shifts satisfied!
                  </td>
                </tr>
              ) : (
                sourcesList.map((src) => {
                  const grossMins = src.shortfallMinutes || src.importedMinutes || 0;
                  const waivedMins = src.waivedMinutes || 0;
                  const netDebt = Math.max(0, grossMins - waivedMins);

                  return (
                    <tr key={src.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{src.fullName}</div>
                      </td>
                      <td className="mono" style={{ fontSize: '0.8125rem' }}>
                        {src.originWorkDate}
                      </td>
                      <td>
                        <span className="badge badge-neutral">
                          {src.sourceType === 'ATTENDANCE_SHORTFALL' ? 'Shift Shortfall' : 'Opening Import'}
                        </span>
                      </td>
                      <td className="tabular-nums mono" style={{ fontWeight: 600 }}>
                        {grossMins} mins
                      </td>
                      <td className="tabular-nums mono" style={{ color: waivedMins > 0 ? '#15803d' : 'var(--text-muted)' }}>
                        {waivedMins} mins
                      </td>
                      <td className="tabular-nums mono" style={{ fontWeight: 700, color: netDebt > 0 ? '#b45309' : '#15803d' }}>
                        {netDebt} mins
                      </td>
                      <td>
                        {src.hasActiveWaiver ? (
                          <span className="badge badge-success">
                            <CheckCircle2 size={12} />
                            <span>Waiver Applied</span>
                          </span>
                        ) : (
                          <span className="badge badge-warning">Unwaived</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!src.hasActiveWaiver && netDebt > 0 && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setModalError(null);
                              setWaiverForm({
                                employeeId: src.employeeId,
                                debtSourceId: src.id,
                                effectiveMonth: selectedMonth + '-01',
                                minutes: netDebt,
                                reason: 'Official operational waiver',
                              });
                              setShowWaiverModal(true);
                            }}
                          >
                            <span>Grant Waiver</span>
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

      {/* Debt Waivers History Table */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Approved Administrative Waivers</h2>
        </div>

        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Effective Month</th>
                <th>Waived Minutes</th>
                <th>Official Reason</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {waiversList.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No waivers granted for this period.
                  </td>
                </tr>
              ) : (
                waiversList.map((wv) => (
                  <tr key={wv.id} style={{ opacity: wv.status === 'VOID' ? 0.6 : 1 }}>
                    <td style={{ fontWeight: 600 }}>{wv.fullName}</td>
                    <td className="mono" style={{ fontSize: '0.8125rem' }}>
                      {wv.effectiveMonth}
                    </td>
                    <td className="tabular-nums mono" style={{ fontWeight: 600 }}>
                      {wv.minutes} mins
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>{wv.reason}</td>
                    <td>
                      <span className={`badge ${wv.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                        {wv.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {wv.status === 'ACTIVE' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ color: '#dc2626' }}
                          onClick={() => {
                            setModalError(null);
                            setVoidReason('');
                            setVoidingWaiver(wv);
                          }}
                        >
                          <Ban size={14} />
                          <span>Void Waiver</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Grant Waiver Modal */}
      {showWaiverModal && (
        <div className="modal-backdrop" onClick={() => setShowWaiverModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Grant Official Debt Waiver</h2>
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
                createWaiverMutation.mutate(waiverForm);
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Employee</label>
                  <select
                    className="select"
                    required
                    value={waiverForm.employeeId}
                    onChange={(e) => {
                      const empId = e.target.value;
                      const sources = sourcesList.filter((s) => s.employeeId === empId && !s.hasActiveWaiver);
                      setWaiverForm({
                        ...waiverForm,
                        employeeId: empId,
                        debtSourceId: sources[0]?.id || '',
                        minutes: sources[0] ? (sources[0].shortfallMinutes || sources[0].importedMinutes || 60) : 60,
                      });
                    }}
                  >
                    <option value="">Select employee...</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName} ({emp.employeeNumber})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Target Debt Lot</label>
                  <select
                    className="select"
                    required
                    value={waiverForm.debtSourceId}
                    onChange={(e) => setWaiverForm({ ...waiverForm, debtSourceId: e.target.value })}
                  >
                    <option value="">Select debt shortfall date...</option>
                    {employeeDebtSources.map((src) => (
                      <option key={src.id} value={src.id}>
                        {src.originWorkDate} — {src.shortfallMinutes || src.importedMinutes} mins shortfall
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Minutes to Waive</label>
                    <input
                      type="number"
                      className="input tabular-nums"
                      required
                      min={1}
                      value={waiverForm.minutes}
                      onChange={(e) => setWaiverForm({ ...waiverForm, minutes: Number(e.target.value) })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Effective Month</label>
                    <input
                      type="date"
                      className="input mono"
                      required
                      value={waiverForm.effectiveMonth}
                      onChange={(e) => setWaiverForm({ ...waiverForm, effectiveMonth: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Official Justification Reason</label>
                  <textarea
                    className="textarea"
                    rows={3}
                    required
                    placeholder="e.g. Medical emergency appointment verified with certified doctor note..."
                    value={waiverForm.reason}
                    onChange={(e) => setWaiverForm({ ...waiverForm, reason: e.target.value })}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowWaiverModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={createWaiverMutation.isPending || !waiverForm.debtSourceId}>
                  {createWaiverMutation.isPending ? 'Granting...' : 'Grant Official Waiver'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Void Waiver Modal */}
      {voidingWaiver && (
        <div className="modal-backdrop" onClick={() => setVoidingWaiver(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Void Debt Waiver</h2>
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
                voidWaiverMutation.mutate({
                  waiverId: voidingWaiver.id,
                  voidReason,
                  expectedVersion: voidingWaiver.rowVersion,
                });
              }}
            >
              <p style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
                Are you sure you want to void the waiver of <strong>{voidingWaiver.minutes} minutes</strong> for{' '}
                <strong>{voidingWaiver.fullName}</strong>? The debt will immediately return to the employee's active balance.
              </p>

              <div className="form-group">
                <label className="form-label">Void Reason</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="Explain why this waiver is being voided..."
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setVoidingWaiver(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-danger" disabled={voidWaiverMutation.isPending}>
                  {voidWaiverMutation.isPending ? 'Voiding...' : 'Confirm Void Waiver'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
