import { usePeriod } from '../context/PeriodContext';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { payrollApi, restaurantApi } from '../lib/api';
import {
  Calculator,
  Lock,
  Unlock,
  Download,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Scale,
  RefreshCw,
} from 'lucide-react';

export const PayrollPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const { month: selectedMonth } = usePeriod();
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: restaurant } = useQuery({
    queryKey: ['restaurant-info', restaurantId],
    queryFn: () => restaurantApi.getProfile(restaurantId),
  });

  const { data: payrollData, isLoading, refetch } = useQuery({
    queryKey: ['payroll-period', restaurantId, selectedMonth],
    queryFn: () => payrollApi.getPeriodOverview(restaurantId, selectedMonth),
  });

  const { data: blockersData } = useQuery({
    queryKey: ['payroll-blockers', restaurantId, selectedMonth],
    queryFn: () => payrollApi.getBlockers(restaurantId, selectedMonth),
  });

  const recalculateMutation = useMutation({
    mutationFn: () => payrollApi.recalculate(restaurantId, selectedMonth),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-period', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-blockers', restaurantId, selectedMonth] });
      setActionError(null);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Recalculation failed');
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: () => payrollApi.finalize(restaurantId, selectedMonth),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-period', restaurantId, selectedMonth] });
      setActionError(null);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Finalization failed');
    },
  });

  const reopenMutation = useMutation({
    mutationFn: (reason: string) => payrollApi.reopen(restaurantId, selectedMonth, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll-period', restaurantId, selectedMonth] });
      setShowReopenModal(false);
      setReopenReason('');
      setActionError(null);
    },
    onError: (err: any) => {
      setActionError(err.message || 'Reopening period failed');
    },
  });

  const currency = restaurant?.currencyCode || 'USD';
  const decimals = restaurant?.currencyDecimalPlaces ?? 2;

  const period = payrollData?.period;
  const summary = payrollData?.summary;
  const employeesList = payrollData?.employees ?? [];
  const blockersCount = blockersData?.totalBlockersCount ?? 0;

  const toggleRow = (empId: string) => {
    setExpandedRows((prev) => ({ ...prev, [empId]: !prev[empId] }));
  };

  const isFinalized = period?.status === 'FINALIZED';

  return (
    <div>
      {/* Header Bar */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 className="page-title">
              Payroll
            </h1>
            <span
              className={`badge ${
                isFinalized
                  ? 'badge-success'
                  : period?.isStale
                  ? 'badge-warning'
                  : 'badge-info'
              }`}
            >
              {isFinalized ? (
                <>
                  <Lock size={12} /> Finalized
                </>
              ) : period?.isStale ? (
                <>
                  <AlertTriangle size={12} /> Stale (Recalc needed)
                </>
              ) : (
                'Calculated & Verified'
              )}
            </span>
          </div>
          <p className="page-subtitle">
            Authoritative financial calculations, immutable snapshot history, and Excel payroll exports.
          </p>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            onClick={() => refetch()}
            title="Refresh payroll data"
          >
            <RefreshCw size={15} />
          </button>

          {!isFinalized ? (
            <>
              <button
                className="btn btn-secondary"
                disabled={recalculateMutation.isPending}
                onClick={() => recalculateMutation.mutate()}
                title="Execute calculation engine across all attendance, debts, warnings, and adjustments"
              >
                <Calculator size={16} />
                <span>{recalculateMutation.isPending ? 'Calculating...' : 'Recalculate'}</span>
              </button>

              <button
                className="btn btn-primary"
                disabled={finalizeMutation.isPending || blockersCount > 0}
                onClick={() => finalizeMutation.mutate()}
                title={blockersCount > 0 ? 'Resolve blockers before finalization' : 'Lock month and freeze snapshots'}
              >
                <Lock size={16} />
                <span>{finalizeMutation.isPending ? 'Finalizing...' : 'Finalize Month'}</span>
              </button>
            </>
          ) : (
            <button
              className="btn btn-secondary"
              style={{ color: 'var(--status-warning)' }}
              onClick={() => {
                setActionError(null);
                setReopenReason('');
                setShowReopenModal(true);
              }}
            >
              <Unlock size={16} />
              <span>Reopen Month</span>
            </button>
          )}

          <a
            href={payrollApi.getExportUrl(restaurantId, selectedMonth)}
            className="btn btn-secondary"
            download
            style={{ textDecoration: 'none' }}
          >
            <Download size={16} />
            <span>Excel (.xlsx)</span>
          </a>
        </div>
      </div>

      {/* Action / Error Banner */}
      {actionError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.85rem 1.25rem',
            backgroundColor: 'var(--status-danger-bg)',
            border: '1px solid var(--status-danger-border)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--status-danger-text)',
            fontSize: '0.875rem',
            marginBottom: '1.5rem',
          }}
        >
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <span>{actionError}</span>
        </div>
      )}

      {/* Finalized Audit Pill */}
      {isFinalized && period?.finalizedAt && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.75rem 1.25rem',
            backgroundColor: 'var(--status-success-bg)',
            border: '1px solid var(--status-success-border)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--status-success)',
            fontSize: '0.8125rem',
            marginBottom: '1.5rem',
          }}
        >
          <CheckCircle2 size={16} />
          <span>
            Period officially finalized on <strong>{new Date(period.finalizedAt).toLocaleString()}</strong> by{' '}
            <strong>{period.finalizedByName || 'Administrator'}</strong>. All snapshots are immutable and locked.
          </span>
        </div>
      )}

      {/* Blockers Alert if any */}
      {blockersCount > 0 && (
        <div
          style={{
            padding: '1rem 1.25rem',
            backgroundColor: 'var(--status-danger-bg)',
            border: '1px solid var(--status-danger-border)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: '1.5rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--status-danger-text)', fontSize: '0.9rem' }}>
            <AlertTriangle size={18} />
            <span>Finalization Blocked ({blockersCount} issues detected)</span>
          </div>
          <ul style={{ paddingLeft: '1.5rem', marginTop: '0.5rem', fontSize: '0.8125rem', color: 'var(--status-danger-text)' }}>
            {blockersData?.affectedEmployees.map((ae) => (
              <li key={ae.employeeId}>
                <strong>{ae.fullName}:</strong> {ae.blockers.join('; ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Financial Summary Cards */}
      <div className="grid-4" style={{ marginBottom: '2rem' }}>
        <div className="card">
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Contractual Base Due</span>
          <div className="tabular-nums" style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.35rem' }}>
            {currency} {Number(summary?.totalBaseDue || summary?.totalContractualSalary || 0).toFixed(decimals)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Total Contract: {currency} {Number(summary?.totalContractualSalary || 0).toFixed(decimals)}
          </div>
        </div>

        <div className="card">
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Eligible Overtime Pay</span>
          <div className="tabular-nums" style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--status-success)', marginTop: '0.35rem' }}>
            +{currency} {Number(summary?.totalOvertimePay || 0).toFixed(decimals)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            After satisfying hour debt recovery
          </div>
        </div>

        <div className="card">
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>Total Deductions</span>
          <div className="tabular-nums" style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--status-danger)', marginTop: '0.35rem' }}>
            -{currency} {(Number(summary?.totalLateDeductions || 0) + Number(summary?.totalOtherDeductions || 0)).toFixed(decimals)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Late: {currency} {Number(summary?.totalLateDeductions || 0).toFixed(decimals)} · Other: {currency}{' '}
            {Number(summary?.totalOtherDeductions || 0).toFixed(decimals)}
          </div>
        </div>

        <div className="card" style={{ borderColor: 'var(--primary)', backgroundColor: 'var(--primary-soft)' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--primary)' }}>Net Payable Payroll</span>
          <div className="tabular-nums" style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--primary)', marginTop: '0.35rem' }}>
            {currency} {Number(summary?.totalNetPayable || 0).toFixed(decimals)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--primary-hover)', marginTop: '0.25rem' }}>
            {summary?.totalEmployees || 0} employees evaluated
          </div>
        </div>
      </div>

      {/* Employee Payroll Breakdown Table */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Employee Payroll Calculations</h2>
        </div>

        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Employee</th>
                <th>Base Salary</th>
                <th>Overtime Pay</th>
                <th>Late Deductions</th>
                <th>Other Deductions</th>
                <th>Net Payable</th>
                <th>Debt Settlement</th>
                <th>Conduct</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '2rem' }}>
                    Loading payroll calculations...
                  </td>
                </tr>
              ) : employeesList.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No payroll calculation runs found for {selectedMonth}. Click Recalculate to generate.
                  </td>
                </tr>
              ) : (
                employeesList.map((emp) => {
                  const isExpanded = Boolean(expandedRows[emp.employeeId]);
                  const hasDebtRecovery = Number(emp.recoveredMinutes || 0) > 0;
                  const isLimitHit = emp.warningLimitReached;

                  return (
                    <React.Fragment key={emp.employeeId}>
                      <tr>
                        <td>
                          <button
                            onClick={() => toggleRow(emp.employeeId)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                          >
                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{emp.fullNameSnapshot}</div>
                          <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {emp.employeeNumberSnapshot} · {emp.positionNameSnapshot}
                          </div>
                        </td>
                        <td className="tabular-nums mono" style={{ fontWeight: 600 }}>
                          {currency} {Number(emp.contractualMonthlySalary).toFixed(decimals)}
                        </td>
                        <td>
                          <div className="tabular-nums mono" style={{ fontWeight: 600, color: Number(emp.overtimeAmount) > 0 ? 'var(--status-success)' : 'var(--text-muted)' }}>
                            +{currency} {Number(emp.overtimeAmount).toFixed(decimals)}
                          </div>
                          {Number(emp.eligibleOvertimeMinutes) > 0 && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                              {emp.eligibleOvertimeMinutes} mins ({Number(emp.eligibleOvertimeMinutes) / 60}h)
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="tabular-nums mono" style={{ color: Number(emp.lateDeductionAmount) > 0 ? 'var(--status-danger)' : 'var(--text-muted)' }}>
                            {Number(emp.lateDeductionAmount) > 0 ? `-${currency} ${Number(emp.lateDeductionAmount).toFixed(decimals)}` : '-'}
                          </div>
                          {emp.lateIncidentCount > 0 && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                              {emp.lateIncidentCount} incidents ({emp.lateMinutes}m)
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="tabular-nums mono" style={{ color: Number(emp.otherDeductionAmount) > 0 ? 'var(--status-danger)' : 'var(--text-muted)' }}>
                            {Number(emp.otherDeductionAmount) > 0 ? `-${currency} ${Number(emp.otherDeductionAmount).toFixed(decimals)}` : '-'}
                          </div>
                        </td>
                        <td>
                          <div
                            className="tabular-nums mono"
                            style={{
                              fontSize: '1rem',
                              fontWeight: 800,
                              color: 'var(--primary)',
                              backgroundColor: 'var(--primary-soft)',
                              padding: '0.2rem 0.5rem',
                              borderRadius: 4,
                              display: 'inline-block',
                            }}
                          >
                            {currency} {Number(emp.netSalary).toFixed(decimals)}
                          </div>
                        </td>
                        <td>
                          {hasDebtRecovery ? (
                            <span className="badge badge-success" title="Debt cleared before overtime">
                              <Scale size={12} />
                              <span>{emp.recoveredMinutes}m Recovered</span>
                            </span>
                          ) : Number(emp.closingDebtMinutes || 0) > 0 ? (
                            <span className="badge badge-warning">
                              {emp.closingDebtMinutes}m Debt Open
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>No Debt</span>
                          )}
                        </td>
                        <td>
                          {isLimitHit ? (
                            <span className="warning-dot-limit">
                              🔴 {emp.countedWarningCount}/{emp.warningThreshold} Warnings
                            </span>
                          ) : emp.countedWarningCount > 0 ? (
                            <span className="badge badge-warning">
                              {emp.countedWarningCount}/{emp.warningThreshold} Warnings
                            </span>
                          ) : (
                            <span className="badge badge-success">Clean</span>
                          )}
                        </td>
                      </tr>

                      {/* Expandable Line-item details */}
                      {isExpanded && (
                        <tr style={{ backgroundColor: 'var(--bg-surface-subtle)' }}>
                          <td colSpan={9} style={{ padding: '1rem 2rem' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                              <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--primary)' }}>
                                Calculation Ledger & Debt Reconciliation for {emp.fullNameSnapshot}
                              </h4>

                              {/* Debt Reconciliation Stats */}
                              <div
                                style={{
                                  display: 'flex',
                                  gap: '1.5rem',
                                  padding: '0.65rem 1rem',
                                  backgroundColor: '#fff',
                                  border: '1px solid var(--border-light)',
                                  borderRadius: 'var(--radius-md)',
                                  fontSize: '0.75rem',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Opening Debt: </span>
                                  <strong>{emp.openingDebtMinutes || 0} mins</strong>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>New Shortfall: </span>
                                  <strong>{emp.newShortfallMinutes || 0} mins</strong>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Waived Minutes: </span>
                                  <strong style={{ color: 'var(--status-success)' }}>{emp.waivedMinutes || 0} mins</strong>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Debt Recovered: </span>
                                  <strong style={{ color: 'var(--primary)' }}>{emp.recoveredMinutes || 0} mins</strong>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Closing Debt: </span>
                                  <strong style={{ color: Number(emp.closingDebtMinutes || 0) > 0 ? 'var(--status-warning)' : 'var(--status-success)' }}>
                                    {emp.closingDebtMinutes || 0} mins
                                  </strong>
                                </div>
                              </div>

                              {/* Line Items List */}
                              {emp.lines && emp.lines.length > 0 && (
                                <div style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-md)', backgroundColor: '#fff' }}>
                                  <table className="table" style={{ fontSize: '0.75rem', margin: 0 }}>
                                    <thead>
                                      <tr>
                                        <th>Line Description</th>
                                        <th>Type</th>
                                        <th>Qty</th>
                                        <th>Unit</th>
                                        <th>Rate</th>
                                        <th style={{ textAlign: 'right' }}>Signed Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {emp.lines.map((ln: any, idx: number) => (
                                        <tr key={idx}>
                                          <td>{ln.description}</td>
                                          <td><span className="badge badge-neutral">{ln.lineType}</span></td>
                                          <td className="tabular-nums">{ln.quantity}</td>
                                          <td>{ln.unit}</td>
                                          <td className="tabular-nums mono">{currency} {Number(ln.rateSnapshot).toFixed(decimals)}</td>
                                          <td className="tabular-nums mono" style={{ textAlign: 'right', fontWeight: 700, color: Number(ln.signedAmount) >= 0 ? 'var(--status-success)' : 'var(--status-danger)' }}>
                                            {Number(ln.signedAmount) >= 0 ? '+' : ''}{currency} {Number(ln.signedAmount).toFixed(decimals)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reopen Month Modal */}
      {showReopenModal && (
        <div className="modal-backdrop" onClick={() => setShowReopenModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Reopen Finalized Payroll Period</h2>
            </div>

            {actionError && (
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
                <span>{actionError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setActionError(null);
                reopenMutation.mutate(reopenReason);
              }}
            >
              <div
                style={{
                  padding: '0.85rem',
                  backgroundColor: 'var(--status-warning-bg)',
                  border: '1px solid var(--status-warning-border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--status-warning-text)',
                  fontSize: '0.8125rem',
                  marginBottom: '1rem',
                }}
              >
                <strong>Operational Audit Warning:</strong> Reopening an already finalized period unlocks attendance and adjustments, increments the source revision, and logs an immutable audit trail.
              </div>

              <div className="form-group">
                <label className="form-label">Mandatory Business Justification</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="Explain why this finalized month is being reopened (e.g. Retroactive bonus agreement or attendance correction)..."
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowReopenModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-danger" disabled={reopenMutation.isPending}>
                  {reopenMutation.isPending ? 'Unlocking...' : 'Confirm Reopen'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
