import { usePeriod } from '../context/PeriodContext';
import { currentMonth } from '../lib/format';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adjustmentsApi, configApi, employeesApi, restaurantApi } from '../lib/api';
import {
  Plus,
  Ban,
  AlertCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';

export const AdjustmentsPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const { month: selectedMonth } = usePeriod();
  const [showAddModal, setShowAddModal] = useState(false);
  const [voidingAdj, setVoidingAdj] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Form State
  const [formState, setFormState] = useState({
    employeeId: '',
    payrollMonth: `${currentMonth()}-01`,
    workDate: '',
    category: 'DEDUCTION' as 'ADDITION' | 'DEDUCTION' | 'BASE_ADJUSTMENT',
    direction: 'DECREASE' as 'INCREASE' | 'DECREASE',
    deductionTypeId: '',
    calculationMethod: 'FIXED' as 'FIXED' | 'DAILY_PERCENTAGE',
    adjustmentValue: '',
    reason: '',
  });

  const { data: restaurant } = useQuery({
    queryKey: ['restaurant-info', restaurantId],
    queryFn: () => restaurantApi.getProfile(restaurantId),
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId, 'ACTIVE'),
  });

  const { data: deductionTypes = [] } = useQuery({
    queryKey: ['deduction-types', restaurantId],
    queryFn: () => configApi.getDeductionTypes(restaurantId),
  });

  const { data: adjustments = [], isLoading } = useQuery({
    queryKey: ['adjustments', restaurantId, selectedMonth],
    queryFn: () => adjustmentsApi.list(restaurantId, `${selectedMonth}-01`),
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof formState) =>
      adjustmentsApi.create(restaurantId, data.employeeId, {
        payrollMonth: data.payrollMonth,
        workDate: data.workDate || null,
        category: data.category,
        direction: data.direction,
        deductionTypeId: data.category === 'DEDUCTION' && data.deductionTypeId ? data.deductionTypeId : null,
        calculationMethod: data.calculationMethod,
        adjustmentValue: Number(data.adjustmentValue),
        reason: data.reason,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adjustments', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setShowAddModal(false);
      setFormState({
        employeeId: '',
        payrollMonth: `${selectedMonth}-01`,
        workDate: '',
        category: 'DEDUCTION',
        direction: 'DECREASE',
        deductionTypeId: '',
        calculationMethod: 'FIXED',
        adjustmentValue: '',
        reason: '',
      });
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to create adjustment');
    },
  });

  const voidMutation = useMutation({
    mutationFn: (data: { adjId: string; voidReason: string; expectedVersion: number }) =>
      adjustmentsApi.void(restaurantId, data.adjId, {
        voidReason: data.voidReason,
        expectedVersion: data.expectedVersion,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adjustments', restaurantId, selectedMonth] });
      queryClient.invalidateQueries({ queryKey: ['payroll-period'] });
      setVoidingAdj(null);
      setVoidReason('');
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to void adjustment');
    },
  });

  const currency = restaurant?.currencyCode || 'USD';
  const decimals = restaurant?.currencyDecimalPlaces ?? 2;

  const handleCategoryChange = (cat: 'ADDITION' | 'DEDUCTION' | 'BASE_ADJUSTMENT') => {
    let dir: 'INCREASE' | 'DECREASE' = 'INCREASE';
    if (cat === 'DEDUCTION') dir = 'DECREASE';
    setFormState({ ...formState, category: cat, direction: dir });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Adjustments
          </h1>
          <p className="page-subtitle">
            Discrete ledger adjustments: discretionary bonuses, operational deductions (till shortages, breakage), and base revisions. Automatic lateness penalties are tracked separately via attendance.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              setModalError(null);
              setFormState({ ...formState, payrollMonth: `${selectedMonth}-01` });
              setShowAddModal(true);
            }}
          >
            <Plus size={16} />
            <span>Add Adjustment</span>
          </button>
        </div>
      </div>

      {/* Adjustments Table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Category</th>
                <th>Direction</th>
                <th>Type</th>
                <th>Amount / Calculation</th>
                <th>Reason</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                    Loading adjustments...
                  </td>
                </tr>
              ) : adjustments.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No salary adjustments active for {selectedMonth}.
                  </td>
                </tr>
              ) : (
                adjustments.map((adj) => {
                  const isPositive = adj.direction === 'INCREASE';
                  return (
                    <tr key={adj.id} style={{ opacity: adj.status === 'VOID' ? 0.6 : 1 }}>
                      <td style={{ fontWeight: 600 }}>{adj.fullName}</td>
                      <td>
                        <span className="badge badge-neutral">{adj.category}</span>
                      </td>
                      <td>
                        <span
                          className={`badge ${isPositive ? 'badge-success' : 'badge-danger'}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          <span>{adj.direction}</span>
                        </span>
                      </td>
                      <td>{adj.deductionTypeName || 'General'}</td>
                      <td>
                        <span className="tabular-nums mono" style={{ fontWeight: 700, color: isPositive ? 'var(--status-success)' : 'var(--status-danger)' }}>
                          {isPositive ? '+' : '-'}
                          {adj.calculationMethod === 'FIXED'
                            ? `${currency} ${Number(adj.adjustmentValue).toFixed(decimals)}`
                            : `${adj.adjustmentValue}% daily rate`}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8125rem', maxWidth: '280px' }}>
                        <div>{adj.reason}</div>
                        {adj.status === 'VOID' && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--status-danger)', marginTop: 4 }}>
                            Void reason: {adj.voidReason}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${adj.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                          {adj.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {adj.status === 'ACTIVE' && (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ color: 'var(--status-danger)' }}
                            onClick={() => {
                              setModalError(null);
                              setVoidReason('');
                              setVoidingAdj(adj);
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

      {/* Add Adjustment Modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Create Salary Adjustment</h2>
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
                if (formState.category === 'DEDUCTION' && /^(late|lateness|late\s*penalty|late\s*deduction|late\s*arrival)$/i.test(formState.reason.trim())) {
                  setModalError('Lateness penalties are automatically calculated by the attendance engine under Operational Policy. Please do not record manual lateness deductions to avoid duplicate penalties.');
                  return;
                }
                createMutation.mutate(formState);
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {formState.category === 'DEDUCTION' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      padding: '0.65rem 0.85rem',
                      backgroundColor: 'var(--surface-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--text-muted)',
                      fontSize: '0.8rem',
                      lineHeight: 1.4,
                    }}
                  >
                    <AlertCircle size={15} style={{ color: 'var(--primary)', flexShrink: 0, marginTop: '0.1rem' }} />
                    <span>
                      <strong>Operational Deductions Only:</strong> Automatic lateness penalties are calculated directly from daily attendance records according to your Operational Policy. Use this form only for operational items like cash register shortages, equipment damage, or uniform fees.
                    </span>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Employee</label>
                  <select
                    className="select"
                    required
                    value={formState.employeeId}
                    onChange={(e) => setFormState({ ...formState, employeeId: e.target.value })}
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
                    <label className="form-label">Category</label>
                    <select
                      className="select"
                      value={formState.category}
                      onChange={(e) => handleCategoryChange(e.target.value as any)}
                    >
                      <option value="DEDUCTION">Deduction (Negative)</option>
                      <option value="ADDITION">Addition / Bonus (Positive)</option>
                      <option value="BASE_ADJUSTMENT">Base Adjustment</option>
                    </select>
                  </div>

                  {formState.category === 'BASE_ADJUSTMENT' && (
                    <div className="form-group">
                      <label className="form-label">Direction</label>
                      <select
                        className="select"
                        value={formState.direction}
                        onChange={(e) => setFormState({ ...formState, direction: e.target.value as 'INCREASE' | 'DECREASE' })}
                      >
                        <option value="INCREASE">Increase</option>
                        <option value="DECREASE">Decrease</option>
                      </select>
                    </div>
                  )}

                  {formState.category === 'DEDUCTION' && (
                    <div className="form-group">
                      <label className="form-label">Deduction Type Preset</label>
                      <select
                        className="select"
                        value={formState.deductionTypeId}
                        onChange={(e) => {
                          const selectedId = e.target.value;
                          const dt = deductionTypes.find((d) => d.id === selectedId);
                          setFormState({
                            ...formState,
                            deductionTypeId: selectedId,
                            calculationMethod: dt ? (dt.calculationMethod as any) : formState.calculationMethod,
                            adjustmentValue: dt ? String(dt.defaultValue) : formState.adjustmentValue,
                            reason: (!formState.reason && dt) ? dt.name : formState.reason,
                          });
                        }}
                      >
                        <option value="">Custom / Select preset...</option>
                        {deductionTypes.map((dt) => (
                          <option key={dt.id} value={dt.id}>
                            {dt.name} ({dt.calculationMethod === 'FIXED' ? `${currency} ${dt.defaultValue}` : `${dt.defaultValue}%`})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Calculation Method</label>
                    <select
                      className="select"
                      value={formState.calculationMethod}
                      onChange={(e) => setFormState({ ...formState, calculationMethod: e.target.value as any })}
                    >
                      <option value="FIXED">Fixed Amount ({currency})</option>
                      <option value="DAILY_PERCENTAGE">Daily Percentage (%)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      {formState.calculationMethod === 'FIXED' ? `Amount (${currency})` : 'Percentage (%)'}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      className="input tabular-nums"
                      required
                      min={0.01}
                      max={formState.calculationMethod === 'DAILY_PERCENTAGE' ? 100 : undefined}
                      placeholder={formState.calculationMethod === 'FIXED' ? '8.00' : '10'}
                      value={formState.adjustmentValue}
                      onChange={(e) => setFormState({ ...formState, adjustmentValue: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Reason / Justification</label>
                  <textarea
                    className="textarea"
                    rows={3}
                    required
                    placeholder="e.g. Till Shortfall, Broken Kitchenware, Replacement Uniform..."
                    value={formState.reason}
                    onChange={(e) => setFormState({ ...formState, reason: e.target.value })}
                  />
                  {formState.category === 'DEDUCTION' && /^(late|lateness|late\s*penalty|late\s*deduction|late\s*arrival)$/i.test(formState.reason.trim()) && (
                    <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--status-danger)' }}>
                      Lateness penalties are automatically calculated from attendance. Please do not record manual lateness deductions.
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createMutation.isPending || (formState.category === 'DEDUCTION' && /^(late|lateness|late\s*penalty|late\s*deduction|late\s*arrival)$/i.test(formState.reason.trim()))}
                >
                  {createMutation.isPending ? 'Saving...' : 'Add Adjustment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Void Adjustment Modal */}
      {voidingAdj && (
        <div className="modal-backdrop" onClick={() => setVoidingAdj(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Void Salary Adjustment</h2>
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
                  adjId: voidingAdj.id,
                  voidReason,
                  expectedVersion: voidingAdj.rowVersion,
                });
              }}
            >
              <p style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
                Are you sure you want to void adjustment <strong>"{voidingAdj.reason}"</strong> ({currency}{' '}
                {voidingAdj.adjustmentValue}) for <strong>{voidingAdj.fullName}</strong>?
              </p>

              <div className="form-group">
                <label className="form-label">Mandatory Void Justification</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="Explain why this adjustment is being revoked..."
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setVoidingAdj(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-danger" disabled={voidMutation.isPending}>
                  {voidMutation.isPending ? 'Voiding...' : 'Confirm Void'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
