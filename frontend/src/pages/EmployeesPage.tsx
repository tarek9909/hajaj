import { todayIso, nextMonthStart } from '../lib/format';
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeesApi, configApi, restaurantApi } from '../lib/api';
import {
  Plus,
  Search,
  History,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from 'lucide-react';

export const EmployeesPage: React.FC = () => {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [positionFilter, setPositionFilter] = useState('ALL');

  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedEmployeeForSalary, setSelectedEmployeeForSalary] = useState<any | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Add Employee Form State
  const [addForm, setAddForm] = useState({
    employeeNumber: '',
    fullName: '',
    mobile: '',
    positionId: '',
    employmentStartDate: todayIso(),
    initialSalary: '1000.00',
    reason: 'Initial employment contract',
  });

  // New Salary Revision State
  const [salaryForm, setSalaryForm] = useState({
    effectiveFromMonth: nextMonthStart(),
    monthlySalary: '',
    reason: 'Annual salary review',
  });

  const { data: restaurant } = useQuery({
    queryKey: ['restaurant-info', restaurantId],
    queryFn: () => restaurantApi.getProfile(restaurantId),
  });

  const { data: positions = [] } = useQuery({
    queryKey: ['positions', restaurantId],
    queryFn: () => configApi.getPositions(restaurantId),
  });

  const { data: employees = [], isLoading } = useQuery({
    queryKey: ['employees', restaurantId],
    queryFn: () => employeesApi.list(restaurantId),
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof addForm) => employeesApi.create(restaurantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees', restaurantId] });
      setShowAddModal(false);
      setAddForm({
        employeeNumber: '',
        fullName: '',
        mobile: '',
        positionId: '',
        employmentStartDate: todayIso(),
        initialSalary: '1000.00',
        reason: 'Initial employment contract',
      });
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to create employee');
    },
  });

  const addSalaryMutation = useMutation({
    mutationFn: (data: typeof salaryForm) =>
      employeesApi.addSalaryRevision(restaurantId, selectedEmployeeForSalary.id, {
        effectiveFromMonth: data.effectiveFromMonth,
        monthlySalary: Number(data.monthlySalary),
        reason: data.reason,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees', restaurantId] });
      setSelectedEmployeeForSalary(null);
      setSalaryForm({ effectiveFromMonth: nextMonthStart(), monthlySalary: '', reason: 'Salary review' });
    },
    onError: (err: any) => {
      setModalError(err.message || 'Failed to record salary revision');
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status, version }: { id: string; status: 'ACTIVE' | 'INACTIVE'; version: number }) =>
      employeesApi.updateStatus(restaurantId, id, status, version),
    onSuccess: () => {
      setListError(null);
      queryClient.invalidateQueries({ queryKey: ['employees', restaurantId] });
    },
    onError: (err: any) => {
      setListError(err.message || 'Failed to change employee status');
      queryClient.invalidateQueries({ queryKey: ['employees', restaurantId] });
    },
  });

  const currency = restaurant?.currencyCode || 'USD';
  const decimals = restaurant?.currencyDecimalPlaces ?? 2;

  const filteredEmployees = employees.filter((emp) => {
    const matchesSearch =
      emp.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.employeeNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.mobile.includes(searchTerm);
    const matchesStatus = statusFilter === 'ALL' || emp.status === statusFilter;
    const matchesPosition = positionFilter === 'ALL' || emp.positionId === positionFilter;
    return matchesSearch && matchesStatus && matchesPosition;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Employees
          </h1>
          <p className="page-subtitle">
            Manage staff rosters, position assignments, and append-only salary histories.
          </p>
        </div>

        <button className="btn btn-primary" onClick={() => { setModalError(null); setShowAddModal(true); }}>
          <Plus size={18} />
          <span>Add Employee</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 240px', position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)' }} />
            <input
              type="text"
              placeholder="Search by name, number, or mobile..."
              className="input"
              style={{ paddingLeft: '2.25rem' }}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Status:</span>
            <select
              className="select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              style={{ width: 'auto' }}
            >
              <option value="ALL">All Statuses</option>
              <option value="ACTIVE">Active Staff</option>
              <option value="INACTIVE">Inactive / Resigned</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Position:</span>
            <select
              className="select"
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="ALL">All Positions</option>
              {positions.map((pos) => (
                <option key={pos.id} value={pos.id}>
                  {pos.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {listError && (
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
          <span>{listError}</span>
        </div>
      )}

      {/* Employees Table */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-container" style={{ border: 'none' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Emp #</th>
                <th>Full Name</th>
                <th>Position</th>
                <th>Mobile</th>
                <th>Start Date</th>
                <th>Monthly Base Salary</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    Loading employee directory...
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    No employees matching filter criteria.
                  </td>
                </tr>
              ) : (
                filteredEmployees.map((emp) => (
                  <tr key={emp.id}>
                    <td className="mono" style={{ fontWeight: 600, color: 'var(--primary)' }}>
                      {emp.employeeNumber}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{emp.fullName}</div>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{emp.positionName}</span>
                    </td>
                    <td className="mono" style={{ fontSize: '0.8125rem' }}>
                      {emp.mobile}
                    </td>
                    <td className="mono" style={{ fontSize: '0.8125rem' }}>
                      {emp.employmentStartDate}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span className="tabular-nums" style={{ fontWeight: 600 }}>
                          {currency} {Number(emp.monthlySalary || 0).toFixed(decimals)}
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }}
                          title="Salary Timeline & Revisions"
                          onClick={() => {
                            setModalError(null);
                            setSelectedEmployeeForSalary(emp);
                            setSalaryForm({
                              effectiveFromMonth: nextMonthStart(),
                              monthlySalary: String(emp.monthlySalary || ''),
                              reason: 'Salary adjustment',
                            });
                          }}
                        >
                          <History size={12} />
                          <span>History</span>
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${emp.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}`}>
                        {emp.status === 'ACTIVE' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        <span>{emp.status}</span>
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          updateStatusMutation.mutate({
                            id: emp.id,
                            status: emp.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                            version: emp.rowVersion,
                          })
                        }
                      >
                        {emp.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Employee Modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Add New Employee</h2>
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
                createMutation.mutate(addForm);
              }}
            >
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Employee Number</label>
                  <input
                    type="text"
                    className="input mono"
                    required
                    placeholder="e.g. EMP-106"
                    value={addForm.employeeNumber}
                    onChange={(e) => setAddForm({ ...addForm, employeeNumber: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input
                    type="text"
                    className="input"
                    required
                    placeholder="e.g. Liam Smith"
                    value={addForm.fullName}
                    onChange={(e) => setAddForm({ ...addForm, fullName: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Mobile Number</label>
                  <input
                    type="text"
                    className="input mono"
                    required
                    placeholder="+1 555 123 4567"
                    value={addForm.mobile}
                    onChange={(e) => setAddForm({ ...addForm, mobile: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Position</label>
                  <select
                    className="select"
                    required
                    value={addForm.positionId}
                    onChange={(e) => setAddForm({ ...addForm, positionId: e.target.value })}
                  >
                    <option value="">Select Position...</option>
                    {positions.map((pos) => (
                      <option key={pos.id} value={pos.id}>
                        {pos.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Start Date</label>
                  <input
                    type="date"
                    className="input"
                    required
                    value={addForm.employmentStartDate}
                    onChange={(e) => setAddForm({ ...addForm, employmentStartDate: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Monthly Base Salary ({currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input tabular-nums"
                    required
                    placeholder="1000.00"
                    value={addForm.initialSalary}
                    onChange={(e) => setAddForm({ ...addForm, initialSalary: e.target.value })}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Saving...' : 'Add Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Salary Revision Modal */}
      {selectedEmployeeForSalary && (
        <div className="modal-backdrop" onClick={() => setSelectedEmployeeForSalary(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 className="modal-title">Record Salary Revision</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {selectedEmployeeForSalary.fullName} ({selectedEmployeeForSalary.employeeNumber})
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
                addSalaryMutation.mutate(salaryForm);
              }}
            >
              <div className="form-group">
                <label className="form-label">Effective From Month (Day 1)</label>
                <input
                  type="date"
                  className="input"
                  required
                  value={salaryForm.effectiveFromMonth}
                  onChange={(e) => setSalaryForm({ ...salaryForm, effectiveFromMonth: e.target.value })}
                />
                <span className="form-hint">Salary revisions take effect on the first of the month.</span>
              </div>

              <div className="form-group">
                <label className="form-label">New Monthly Contractual Salary ({currency})</label>
                <input
                  type="number"
                  step="0.01"
                  className="input tabular-nums"
                  required
                  value={salaryForm.monthlySalary}
                  onChange={(e) => setSalaryForm({ ...salaryForm, monthlySalary: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Reason for Revision</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="e.g. Promotion to Senior Station Lead"
                  value={salaryForm.reason}
                  onChange={(e) => setSalaryForm({ ...salaryForm, reason: e.target.value })}
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setSelectedEmployeeForSalary(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={addSalaryMutation.isPending}>
                  {addSalaryMutation.isPending ? 'Committing...' : 'Commit Revision'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
