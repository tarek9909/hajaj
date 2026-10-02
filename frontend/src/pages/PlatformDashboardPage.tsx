import { currentMonth } from '../lib/format';
import { Modal, Alert } from '../components/ui';
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { platformApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import {
  Building2,
  Plus,
  Users,
  Shield,
  ArrowRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from 'lucide-react';

export const PlatformDashboardPage: React.FC = () => {
  const { setActiveRestaurantId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [showModal, setShowModal] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Form State for Onboarding
  const [formData, setFormData] = useState({
    name: '',
    contactName: '',
    contactMobile: '',
    contactEmail: '',
    currencyCode: 'USD',
    currencyDecimalPlaces: 2,
    timezone: 'UTC',
    payrollStartMonth: `${currentMonth()}-01`,
    initialPolicy: {
      salaryWorkingDayDivisor: 26,
      standardDailyMinutes: 480,
      overtimeMultiplier: 1.5,
      lateGraceMinutes: 10,
      lateDeductionPercentage: 10,
      warningThreshold: 3,
      customWarningsCountByDefault: true,
      reason: 'Standard launch policy',
    },
    initialAdmin: {
      fullName: '',
      email: '',
      mobile: '',
      password: '',
    },
  });

  const [handoff, setHandoff] = useState<{ restaurantId: string; link: string } | null>(null);

  const { data: restaurants = [], isLoading } = useQuery({
    queryKey: ['platform-restaurants'],
    queryFn: () => platformApi.listRestaurants(),
  });

  const onboardMutation = useMutation({
    mutationFn: (data: typeof formData) => {
      const { password, ...admin } = data.initialAdmin;
      return platformApi.onboardRestaurant({ ...data, initialAdmin: password ? { ...admin, password } : admin });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['platform-restaurants'] });
      queryClient.invalidateQueries({ queryKey: ['platform-restaurants-switcher'] });
      setShowModal(false);
      if (res.setupPath) {
        // No password was set: the admin needs this one-time link to activate the account
        setHandoff({ restaurantId: res.restaurantId, link: `${window.location.origin}${res.setupPath}` });
        return;
      }
      setActiveRestaurantId(res.restaurantId);
      navigate(`/restaurants/${res.restaurantId}/dashboard`);
    },
    onError: (err: any) => {
      setFormError(err.message || 'Failed to onboard restaurant.');
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status, version }: { id: string; status: 'ACTIVE' | 'INACTIVE'; version: number }) =>
      platformApi.updateStatus(id, status, version),
    onSuccess: () => {
      setStatusError(null);
      queryClient.invalidateQueries({ queryKey: ['platform-restaurants'] });
    },
    onError: (err: any) => {
      setStatusError(err.message || 'Failed to change restaurant status');
      queryClient.invalidateQueries({ queryKey: ['platform-restaurants'] });
    },
  });

  const totalAdmins = restaurants.reduce((sum, r) => sum + Number(r.activeAdminCount || 0), 0);
  const totalEmployees = restaurants.reduce((sum, r) => sum + Number(r.activeEmployeeCount || 0), 0);

  const handleEnterWorkspace = (id: string) => {
    setActiveRestaurantId(id);
    navigate(`/restaurants/${id}/dashboard`);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.75rem' }}>
        <div>
          <h1 className="page-title">
            Restaurants
          </h1>
          <p className="page-subtitle">
            Manage SaaS restaurant tenants, global policies, and root administrators.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setFormError(null); setShowModal(true); }}>
          <Plus size={18} />
          <span>Onboard Restaurant</span>
        </button>
      </div>

      {statusError && <Alert tone="danger" style={{ marginBottom: '1rem' }}>{statusError}</Alert>}

      {/* Metrics Row */}
      <div className="grid-3" style={{ marginBottom: '2rem' }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--primary)' }}>
            <Building2 size={24} />
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              Active Restaurants
            </span>
          </div>
          <div className="tabular-nums" style={{ fontSize: '2.25rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {restaurants.filter((r) => r.status === 'ACTIVE').length}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Total tenants configured: {restaurants.length}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--accent)' }}>
            <Shield size={24} />
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              Active Administrators
            </span>
          </div>
          <div className="tabular-nums" style={{ fontSize: '2.25rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {totalAdmins}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Multi-tenant isolated operators
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--status-success)' }}>
            <Users size={24} />
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-muted)' }}>
              Total Workforce
            </span>
          </div>
          <div className="tabular-nums" style={{ fontSize: '2.25rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {totalEmployees}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Active staff members across all locations
          </div>
        </div>
      </div>

      {/* Restaurants Table */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Provisioned Restaurant Tenants</h2>
        </div>

        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Restaurant Name</th>
                <th>Currency</th>
                <th>Timezone</th>
                <th>Admins</th>
                <th>Workforce</th>
                <th>Status</th>
                <th>Payroll Starts</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    Loading tenants...
                  </td>
                </tr>
              ) : restaurants.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No restaurants registered yet. Click Onboard Restaurant to begin.
                  </td>
                </tr>
              ) : (
                restaurants.map((rest) => (
                  <tr key={rest.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{rest.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {rest.contactName} ({rest.contactEmail || rest.contactMobile || 'No contact info'})
                      </div>
                    </td>
                    <td>
                      <span className="mono badge badge-neutral" style={{ fontWeight: 600 }}>
                        {rest.currencyCode} ({rest.currencyDecimalPlaces} dec)
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: '0.8125rem' }}>
                        {rest.timezone}
                      </span>
                    </td>
                    <td className="tabular-nums">{rest.activeAdminCount}</td>
                    <td className="tabular-nums" style={{ fontWeight: 600 }}>
                      {rest.activeEmployeeCount}
                    </td>
                    <td>
                      <span className={`badge ${rest.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                        {rest.status === 'ACTIVE' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        <span>{rest.status}</span>
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: '0.8125rem' }}>
                      {rest.payrollStartMonth}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() =>
                            statusMutation.mutate({
                              id: rest.id,
                              status: rest.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              version: rest.rowVersion,
                            })
                          }
                        >
                          {rest.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleEnterWorkspace(rest.id)}
                        >
                          <span>Enter Workspace</span>
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Onboarding Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal-content" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Onboard New Restaurant Tenant</h2>
            </div>

            {formError && (
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
                <span>{formError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setFormError(null);
                onboardMutation.mutate(formData);
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', borderBottom: '1px solid var(--border-light)', paddingBottom: '0.35rem' }}>
                  1. Restaurant Details
                </h3>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Restaurant Name</label>
                    <input
                      type="text"
                      className="input"
                      required
                      placeholder="e.g. Bella Italia"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Timezone</label>
                    <select
                      className="select"
                      value={formData.timezone}
                      onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                    >
                      <option value="UTC">UTC</option>
                      <option value="Asia/Riyadh">Asia/Riyadh (+03:00)</option>
                      <option value="America/New_York">America/New_York (EST)</option>
                      <option value="Europe/London">Europe/London (GMT/BST)</option>
                    </select>
                  </div>
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Currency Code</label>
                    <input
                      type="text"
                      className="input mono"
                      maxLength={3}
                      required
                      value={formData.currencyCode}
                      onChange={(e) => setFormData({ ...formData, currencyCode: e.target.value.toUpperCase() })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Payroll Start Month</label>
                    <input
                      type="date"
                      className="input"
                      required
                      value={formData.payrollStartMonth}
                      onChange={(e) => setFormData({ ...formData, payrollStartMonth: e.target.value })}
                    />
                  </div>
                </div>

                <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', borderBottom: '1px solid var(--border-light)', paddingBottom: '0.35rem', marginTop: '0.5rem' }}>
                  2. Initial Operational Policy
                </h3>
                <div className="grid-3">
                  <div className="form-group">
                    <label className="form-label">Divisor (Days)</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={formData.initialPolicy.salaryWorkingDayDivisor}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, salaryWorkingDayDivisor: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Daily Minutes</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={formData.initialPolicy.standardDailyMinutes}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, standardDailyMinutes: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Overtime Multiplier</label>
                    <input
                      type="number"
                      step="0.05"
                      className="input"
                      value={formData.initialPolicy.overtimeMultiplier}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, overtimeMultiplier: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="grid-3">
                  <div className="form-group">
                    <label className="form-label">Grace (Minutes)</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={formData.initialPolicy.lateGraceMinutes}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, lateGraceMinutes: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Late Penalty (%)</label>
                    <input
                      type="number"
                      step="1"
                      className="input"
                      value={formData.initialPolicy.lateDeductionPercentage}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, lateDeductionPercentage: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Warning Limit</label>
                    <input
                      type="number"
                      className="input"
                      required
                      value={formData.initialPolicy.warningThreshold}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialPolicy: { ...formData.initialPolicy, warningThreshold: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                </div>

                <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', borderBottom: '1px solid var(--border-light)', paddingBottom: '0.35rem', marginTop: '0.5rem' }}>
                  3. Primary Administrator Account
                </h3>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">Full Name</label>
                    <input
                      type="text"
                      className="input"
                      required
                      placeholder="e.g. Marco Rossi"
                      value={formData.initialAdmin.fullName}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialAdmin: { ...formData.initialAdmin, fullName: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Email Address</label>
                    <input
                      type="email"
                      className="input"
                      required
                      placeholder="admin@restaurant.com"
                      value={formData.initialAdmin.email}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          initialAdmin: { ...formData.initialAdmin, email: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Initial Password (optional)</label>
                  <input
                    type="password"
                    className="input"
                    minLength={8}
                    placeholder="Leave blank to send a secure setup link"
                    value={formData.initialAdmin.password}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        initialAdmin: { ...formData.initialAdmin, password: e.target.value },
                      })
                    }
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={onboardMutation.isPending}>
                  {onboardMutation.isPending ? 'Provisioning...' : 'Provision Tenant'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {handoff && (
        <Modal title="Share the setup link" onClose={() => setHandoff(null)}>
          <Alert tone="warning">This link is shown once and expires in 48 hours. Send it to the administrator securely.</Alert>
          <input className="input mono" readOnly value={handoff.link} onFocus={(e) => e.currentTarget.select()} />
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(handoff.link)}>Copy link</button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setActiveRestaurantId(handoff.restaurantId);
                navigate(`/restaurants/${handoff.restaurantId}/dashboard`);
              }}
            >
              Open workspace
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};
