import { nextMonthStart } from '../lib/format';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, restaurantApi } from '../lib/api';
import {
  Scale,
  Briefcase,
  Layers,
  Clock,
  Shield,
  Plus,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'POLICY' | 'POSITIONS' | 'DEDUCTIONS' | 'TEMPLATES' | 'ADMINS'>('POLICY');
  const [modalType, setModalType] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Policy Form
  const [policyForm, setPolicyForm] = useState({
    effectiveFromMonth: nextMonthStart(),
    salaryWorkingDayDivisor: 26,
    standardDailyMinutes: 480,
    overtimeMultiplier: 1.5,
    lateGraceMinutes: 10,
    lateDeductionPercentage: 10,
    warningThreshold: 3,
    customWarningsCountByDefault: true,
    reason: 'Quarterly policy revision',
  });

  // Position Form
  const [positionTitle, setPositionTitle] = useState('');

  // Deduction Type Form
  const [deductionForm, setDeductionForm] = useState({
    name: '',
    calculationMethod: 'FIXED' as 'FIXED' | 'DAILY_PERCENTAGE',
    defaultValue: 10,
  });

  // Admin Form
  const [adminForm, setAdminForm] = useState({
    fullName: '',
    email: '',
    mobile: '',
    password: '',
  });

  const { data: restaurant } = useQuery({
    queryKey: ['restaurant-info', restaurantId],
    queryFn: () => restaurantApi.getProfile(restaurantId),
  });

  const { data: policies = [] } = useQuery({
    queryKey: ['policies', restaurantId],
    queryFn: () => configApi.getPolicies(restaurantId),
  });

  const { data: positions = [] } = useQuery({
    queryKey: ['positions', restaurantId],
    queryFn: () => configApi.getPositions(restaurantId),
  });

  const { data: deductions = [] } = useQuery({
    queryKey: ['deduction-types', restaurantId],
    queryFn: () => configApi.getDeductionTypes(restaurantId),
  });

  const { data: templates = [] } = useQuery({
    queryKey: ['shift-templates', restaurantId],
    queryFn: () => configApi.getShiftTemplates(restaurantId),
  });

  const { data: admins = [] } = useQuery({
    queryKey: ['administrators', restaurantId],
    queryFn: () => configApi.getAdministrators(restaurantId),
  });

  // Mutations
  const createPolicyMutation = useMutation({
    mutationFn: (data: typeof policyForm) => configApi.createPolicyVersion(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies', restaurantId] });
      setModalType(null);
    },
    onError: (err: any) => setModalError(err.message || 'Failed to enact policy version'),
  });

  const createPositionMutation = useMutation({
    mutationFn: (name: string) => configApi.createPosition(restaurantId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions', restaurantId] });
      setPositionTitle('');
      setModalType(null);
    },
    onError: (err: any) => setModalError(err.message || 'Failed to create position'),
  });

  const createDeductionMutation = useMutation({
    mutationFn: (data: typeof deductionForm) => configApi.createDeductionType(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deduction-types', restaurantId] });
      setModalType(null);
    },
    onError: (err: any) => setModalError(err.message || 'Failed to create deduction type'),
  });

  const createAdminMutation = useMutation({
    mutationFn: (data: typeof adminForm) => configApi.createAdministrator(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['administrators', restaurantId] });
      setAdminForm({ fullName: '', email: '', mobile: '', password: '' });
      setModalType(null);
    },
    onError: (err: any) => setModalError(err.message || 'Failed to add administrator'),
  });

  const toggleAdminStatusMutation = useMutation({
    mutationFn: ({ adminId, status, version }: { adminId: string; status: 'ACTIVE' | 'INACTIVE'; version: number }) =>
      configApi.updateAdminStatus(restaurantId, adminId, status, version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['administrators', restaurantId] });
      setModalError(null);
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to change administrator status');
    },
  });

  return (
    <div>
      <div style={{ marginBottom: '1.75rem' }}>
        <h1 className="page-title">
          Settings & policy
        </h1>
        <p className="page-subtitle">
          Versioned business rules, shift catalogs, job positions, and administrator access control.
        </p>
      </div>

      {modalError && !modalType && (
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
          <span>{modalError}</span>
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          borderBottom: '1px solid var(--border-light)',
          marginBottom: '1.5rem',
          overflowX: 'auto',
        }}
      >
        <button
          className={`btn ${activeTab === 'POLICY' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('POLICY')}
        >
          <Scale size={16} />
          <span>Operational Policies ({policies.length})</span>
        </button>
        <button
          className={`btn ${activeTab === 'POSITIONS' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('POSITIONS')}
        >
          <Briefcase size={16} />
          <span>Positions ({positions.length})</span>
        </button>
        <button
          className={`btn ${activeTab === 'DEDUCTIONS' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('DEDUCTIONS')}
        >
          <Layers size={16} />
          <span>Deduction Types ({deductions.length})</span>
        </button>
        <button
          className={`btn ${activeTab === 'TEMPLATES' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('TEMPLATES')}
        >
          <Clock size={16} />
          <span>Shift Templates ({templates.length})</span>
        </button>
        <button
          className={`btn ${activeTab === 'ADMINS' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('ADMINS')}
        >
          <Shield size={16} />
          <span>Administrators ({admins.length})</span>
        </button>
      </div>

      {/* Tab 1: Policies */}
      {activeTab === 'POLICY' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Append-Only Policy Version History</h2>
            <button className="btn btn-primary btn-sm" onClick={() => { setModalError(null); setModalType('POLICY'); }}>
              <Plus size={14} />
              <span>Enact New Policy Version</span>
            </button>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-container" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Rev #</th>
                    <th>Effective Month</th>
                    <th>Salary Divisor</th>
                    <th>Daily Hours</th>
                    <th>Overtime Rate</th>
                    <th>Grace Period</th>
                    <th>Late Penalty</th>
                    <th>Warning Limit</th>
                    <th>Reason / Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        v{p.revisionNo}
                      </td>
                      <td className="mono">{p.effectiveFromMonth}</td>
                      <td className="tabular-nums mono">{p.salaryWorkingDayDivisor} days</td>
                      <td className="tabular-nums mono">{p.standardDailyMinutes / 60}h ({p.standardDailyMinutes}m)</td>
                      <td className="tabular-nums mono" style={{ fontWeight: 600 }}>{p.overtimeMultiplier}x</td>
                      <td className="tabular-nums mono">{p.lateGraceMinutes} mins</td>
                      <td className="tabular-nums mono" style={{ color: 'var(--status-danger)' }}>{p.lateDeductionPercentage}%</td>
                      <td className="tabular-nums mono" style={{ fontWeight: 600 }}>{p.warningThreshold} warnings</td>
                      <td style={{ fontSize: '0.8125rem' }}>{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Positions */}
      {activeTab === 'POSITIONS' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Kitchen & Floor Job Positions</h2>
            <button className="btn btn-primary btn-sm" onClick={() => { setModalError(null); setModalType('POSITION'); }}>
              <Plus size={14} />
              <span>Add Position</span>
            </button>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-container" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Position Title</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos) => (
                    <tr key={pos.id}>
                      <td style={{ fontWeight: 600 }}>{pos.name}</td>
                      <td>
                        <span className={`badge ${pos.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                          {pos.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Deduction Types */}
      {activeTab === 'DEDUCTIONS' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Custom Deduction Types</h2>
            <button className="btn btn-primary btn-sm" onClick={() => { setModalError(null); setModalType('DEDUCTION'); }}>
              <Plus size={14} />
              <span>Add Deduction Type</span>
            </button>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-container" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Deduction Name</th>
                    <th>Calculation Method</th>
                    <th>Default Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {deductions.map((d) => (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 600 }}>{d.name}</td>
                      <td><span className="badge badge-neutral">{d.calculationMethod}</span></td>
                      <td className="tabular-nums mono">
                        {d.calculationMethod === 'FIXED' ? `${restaurant?.currencyCode} ${d.defaultValue}` : `${d.defaultValue}%`}
                      </td>
                      <td>
                        <span className={`badge ${d.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                          {d.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Shift Templates */}
      {activeTab === 'TEMPLATES' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Configured Shift Templates</h2>
          </div>

          <div className="grid-2">
            {templates.map((tmpl) => (
              <div key={tmpl.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>{tmpl.name}</h3>
                  <span className="badge badge-info">{tmpl.intervals?.length || 1} Interval(s)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8125rem' }}>
                  {tmpl.intervals?.map((inv: any, i: number) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                      <span>Interval #{inv.sequenceNumber}:</span>
                      <strong className="mono">
                        {inv.startLocalTime?.slice(0, 5)} - {inv.endLocalTime?.slice(0, 5)}
                        {inv.endDayOffset > 0 && ' (+1d)'} (Break: {inv.plannedUnpaidBreakMinutes}m)
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab 5: Administrators & Last Admin Protection */}
      {activeTab === 'ADMINS' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Restaurant Administrators</h2>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                Protected by Last-Active-Administrator invariant (cannot deactivate the only active operator).
              </p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { setModalError(null); setModalType('ADMIN'); }}>
              <Plus size={14} />
              <span>Add Administrator</span>
            </button>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-container" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Full Name</th>
                    <th>Email Address</th>
                    <th>Mobile</th>
                    <th>Status</th>
                    <th>Last Active</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.map((adm) => (
                    <tr key={adm.id}>
                      <td style={{ fontWeight: 600 }}>{adm.fullName}</td>
                      <td className="mono">{adm.email}</td>
                      <td className="mono">{adm.mobile || '-'}</td>
                      <td>
                        <span className={`badge ${adm.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                          {adm.status === 'ACTIVE' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                          <span>{adm.status}</span>
                        </span>
                      </td>
                      <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {adm.lastLoginAt ? new Date(adm.lastLoginAt).toLocaleString() : 'Never'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={toggleAdminStatusMutation.isPending}
                          onClick={() => {
                            setModalError(null);
                            toggleAdminStatusMutation.mutate({
                              adminId: adm.id,
                              status: adm.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              version: adm.rowVersion,
                            });
                          }}
                        >
                          {adm.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Enact Policy Modal */}
      {modalType === 'POLICY' && (
        <div className="modal-backdrop" onClick={() => setModalType(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Enact New Policy Version</h2>
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
            <form onSubmit={(e) => { e.preventDefault(); createPolicyMutation.mutate(policyForm); }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Effective From Month (Day 1)</label>
                  <input
                    type="date"
                    className="input mono"
                    required
                    value={policyForm.effectiveFromMonth}
                    onChange={(e) => setPolicyForm({ ...policyForm, effectiveFromMonth: e.target.value })}
                  />
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Salary Divisor (Days)</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={policyForm.salaryWorkingDayDivisor}
                      onChange={(e) => setPolicyForm({ ...policyForm, salaryWorkingDayDivisor: Number(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Overtime Multiplier</label>
                    <input
                      type="number"
                      step="0.05"
                      className="input"
                      required
                      value={policyForm.overtimeMultiplier}
                      onChange={(e) => setPolicyForm({ ...policyForm, overtimeMultiplier: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Grace Period (Minutes)</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={policyForm.lateGraceMinutes}
                      onChange={(e) => setPolicyForm({ ...policyForm, lateGraceMinutes: Number(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Late Penalty (%)</label>
                    <input
                      type="number"
                      step="1"
                      className="input"
                      required
                      value={policyForm.lateDeductionPercentage}
                      onChange={(e) => setPolicyForm({ ...policyForm, lateDeductionPercentage: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Monthly Warning Limit</label>
                  <input
                    type="number"
                    className="input"
                    required
                    value={policyForm.warningThreshold}
                    onChange={(e) => setPolicyForm({ ...policyForm, warningThreshold: Number(e.target.value) })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Enactment Reason</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    required
                    value={policyForm.reason}
                    onChange={(e) => setPolicyForm({ ...policyForm, reason: e.target.value })}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModalType(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createPolicyMutation.isPending}>Enact Version</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Position Modal */}
      {modalType === 'POSITION' && (
        <div className="modal-backdrop" onClick={() => setModalType(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Create Job Position</h2>
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
            <form onSubmit={(e) => { e.preventDefault(); createPositionMutation.mutate(positionTitle); }}>
              <div className="form-group">
                <label className="form-label">Position Title</label>
                <input
                  type="text"
                  className="input"
                  required
                  placeholder="e.g. Pastry Chef"
                  value={positionTitle}
                  onChange={(e) => setPositionTitle(e.target.value)}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModalType(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createPositionMutation.isPending}>Add Position</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Deduction Type Modal */}
      {modalType === 'DEDUCTION' && (
        <div className="modal-backdrop" onClick={() => setModalType(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Create Deduction Type</h2>
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
            <form onSubmit={(e) => { e.preventDefault(); createDeductionMutation.mutate(deductionForm); }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Deduction Name</label>
                  <input
                    type="text"
                    className="input"
                    required
                    placeholder="e.g. Broken Crockery, Uniform Replacement"
                    value={deductionForm.name}
                    onChange={(e) => setDeductionForm({ ...deductionForm, name: e.target.value })}
                  />
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Calculation Method</label>
                    <select
                      className="select"
                      value={deductionForm.calculationMethod}
                      onChange={(e) => setDeductionForm({ ...deductionForm, calculationMethod: e.target.value as any })}
                    >
                      <option value="FIXED">Fixed Amount</option>
                      <option value="DAILY_PERCENTAGE">Daily Percentage (%)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Default Value</label>
                    <input
                      type="number"
                      step="0.01"
                      className="input tabular-nums"
                      required
                      value={deductionForm.defaultValue}
                      onChange={(e) => setDeductionForm({ ...deductionForm, defaultValue: Number(e.target.value) })}
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModalType(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createDeductionMutation.isPending}>Create Type</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Admin Modal */}
      {modalType === 'ADMIN' && (
        <div className="modal-backdrop" onClick={() => setModalType(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Add Restaurant Administrator</h2>
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
            <form onSubmit={(e) => { e.preventDefault(); createAdminMutation.mutate(adminForm); }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input
                    type="text"
                    className="input"
                    required
                    placeholder="e.g. Rachel Adams"
                    value={adminForm.fullName}
                    onChange={(e) => setAdminForm({ ...adminForm, fullName: e.target.value })}
                  />
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Email Address</label>
                    <input
                      type="email"
                      className="input"
                      required
                      placeholder="rachel@restaurant.com"
                      value={adminForm.email}
                      onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Mobile</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="+1 555 987 6543"
                      value={adminForm.mobile}
                      onChange={(e) => setAdminForm({ ...adminForm, mobile: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Initial Password</label>
                  <input
                    type="password"
                    className="input"
                    required
                    minLength={8}
                    placeholder="Min 8 characters"
                    value={adminForm.password}
                    onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModalType(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createAdminMutation.isPending}>Add Administrator</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
