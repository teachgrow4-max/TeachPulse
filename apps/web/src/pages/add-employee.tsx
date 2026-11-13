import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateEmployeeResponse, DepartmentDto } from '@teachgrow/shared';
import { api, ApiError, messageOf } from '../lib/api';
import { Avatar, Notice } from '../components/ui/misc';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input, Select } from '../components/ui/form';
import { CopyIcon, UserPlusIcon } from '../components/ui/icons';
import { PageContainer, PageHeader } from '../components/ui/page';
import { useToast } from '../components/ui/toast';
import { SuccessMark } from '../components/scanner/scan-panels';

const ROLES = [
  { value: 'employee', label: 'Employee' },
  { value: 'attendance_operator', label: 'Attendance operator (front desk, scans QR codes)' },
  { value: 'admin', label: 'Administrator' },
] as const;

type Role = (typeof ROLES)[number]['value'];

/** Today as the person at the screen reads it, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface FormState {
  fullName: string;
  email: string;
  employeeCode: string;
  departmentId: string;
  designation: string;
  phone: string;
  joiningDate: string;
  role: Role;
}

const empty = (): FormState => ({
  fullName: '',
  email: '',
  employeeCode: '',
  departmentId: '',
  designation: '',
  phone: '',
  joiningDate: today(),
  role: 'employee',
});

/** The server names the field that is wrong (`details: [{ path, message }]`); show it next to it. */
function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const item of error.details as Array<{ path?: unknown; message?: unknown }>) {
    if (typeof item?.path === 'string' && typeof item.message === 'string' && !out[item.path]) {
      out[item.path] = item.message;
    }
  }
  return out;
}

function Created({ result, onAnother }: { result: CreateEmployeeResponse; onAnother: () => void }) {
  const toast = useToast();
  const { employee, temporaryPassword } = result;

  const copy = async () => {
    if (!temporaryPassword) return;
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      toast.show({ tone: 'success', title: 'Password copied' });
    } catch {
      toast.show({ tone: 'info', title: 'Select the password and copy it by hand' });
    }
  };

  return (
    <Card className="pop-in overflow-hidden">
      <div className="flex flex-col items-center gap-3 bg-gradient-to-b from-success-soft to-surface px-6 pb-6 pt-8 text-center">
        <SuccessMark />
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{employee.fullName} was added</h2>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono">{employee.employeeCode}</span> · {employee.email}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 border-t border-line p-5 sm:p-6">
        {temporaryPassword ? (
          <>
            <div>
              <p className="text-sm font-medium">One-time password</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code
                  data-testid="temporary-password"
                  className="select-all rounded-xl border border-line-strong bg-surface-2 px-4 py-2.5 font-mono text-base tracking-wide"
                >
                  {temporaryPassword}
                </code>
                <Button variant="outline" onClick={() => void copy()}>
                  <CopyIcon className="h-4 w-4" /> Copy
                </Button>
              </div>
            </div>
            <Notice tone="warning" title="This password is shown only once">
              Give it to {employee.fullName} now. It is not stored anywhere you can read it again.
              They sign in with {employee.email} and this password, and must choose their own
              password straight away.
            </Notice>
          </>
        ) : (
          <Notice tone="info">No temporary password was generated for this account.</Notice>
        )}

        <div>
          <Button onClick={onAnother}>
            <UserPlusIcon className="h-4 w-4" /> Add another employee
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AddEmployeePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CreateEmployeeResponse | null>(null);

  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ items: DepartmentDto[] }>('/api/admin/departments'),
    select: (data) => data.items,
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CreateEmployeeResponse>('/api/admin/employees', { method: 'POST', body }),
    onSuccess: async (created) => {
      setErrors({});
      setResult(created);
      await queryClient.invalidateQueries({ queryKey: ['qr-overview'] });
      await queryClient.invalidateQueries({ queryKey: ['employee-picker'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance-daily'] });
    },
    onError: (error) => {
      const found = fieldErrors(error);
      setErrors(found);
      if (Object.keys(found).length === 0) {
        toast.show({ tone: 'danger', title: 'Could not add the employee', text: messageOf(error) });
      }
    },
  });

  const set =
    <K extends keyof FormState>(key: K) =>
    (value: FormState[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
      setErrors((current) => {
        if (!current[key]) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
    };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {
      fullName: form.fullName,
      email: form.email,
      employeeCode: form.employeeCode,
      joiningDate: form.joiningDate,
      role: form.role,
    };
    if (form.departmentId) body.departmentId = form.departmentId;
    if (form.designation.trim()) body.designation = form.designation;
    if (form.phone.trim()) body.phone = form.phone;
    create.mutate(body);
  };

  return (
    <PageContainer width="sm">
      <PageHeader
        title="Add Employee"
        description="Creates the sign-in and the profile. A one-time password is generated and shown once."
      />

      {result ? (
        <Created
          result={result}
          onAnother={() => {
            setResult(null);
            setForm(empty());
          }}
        />
      ) : (
        <Card className="p-5 sm:p-6">
          <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
            <section aria-labelledby="who" className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center gap-3 sm:col-span-2">
                <Avatar name={form.fullName || 'New employee'} size="md" />
                <div>
                  <h2 id="who" className="text-sm font-semibold">
                    Who they are
                  </h2>
                  <p className="text-xs text-muted">The name and the details they sign in with.</p>
                </div>
              </div>
              <Field label="Full name" error={errors.fullName} className="sm:col-span-2">
                {(props) => (
                  <Input
                    {...props}
                    required
                    autoComplete="off"
                    value={form.fullName}
                    onChange={(e) => set('fullName')(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Email" error={errors.email} hint="They sign in with this.">
                {(props) => (
                  <Input
                    {...props}
                    type="email"
                    required
                    autoComplete="off"
                    value={form.email}
                    onChange={(e) => set('email')(e.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Employee ID"
                error={errors.employeeCode}
                hint="Letters, digits, dot, dash or underscore."
              >
                {(props) => (
                  <Input
                    {...props}
                    required
                    autoComplete="off"
                    value={form.employeeCode}
                    onChange={(e) => set('employeeCode')(e.target.value)}
                  />
                )}
              </Field>
            </section>

            <section
              aria-labelledby="work"
              className="grid gap-4 border-t border-line pt-6 sm:grid-cols-2"
            >
              <div className="sm:col-span-2">
                <h2 id="work" className="text-sm font-semibold">
                  Their work
                </h2>
                <p className="text-xs text-muted">
                  Where they sit, what they do and what they can use.
                </p>
              </div>
              <Field label="Department (optional)" error={errors.departmentId}>
                {(props) => (
                  <Select
                    {...props}
                    value={form.departmentId}
                    onChange={(e) => set('departmentId')(e.target.value)}
                  >
                    <option value="">No department</option>
                    {departments.data?.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Designation (optional)" error={errors.designation}>
                {(props) => (
                  <Input
                    {...props}
                    autoComplete="off"
                    value={form.designation}
                    onChange={(e) => set('designation')(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Phone (optional)" error={errors.phone}>
                {(props) => (
                  <Input
                    {...props}
                    type="tel"
                    autoComplete="off"
                    value={form.phone}
                    onChange={(e) => set('phone')(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Joining date" error={errors.joiningDate}>
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    required
                    value={form.joiningDate}
                    onChange={(e) => set('joiningDate')(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Role" error={errors.role} className="sm:col-span-2">
                {(props) => (
                  <Select
                    {...props}
                    value={form.role}
                    onChange={(e) => set('role')(e.target.value as Role)}
                  >
                    {ROLES.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </section>

            <div className="flex justify-end border-t border-line pt-5">
              <Button type="submit" size="lg" loading={create.isPending}>
                Add employee
              </Button>
            </div>
          </form>
        </Card>
      )}
    </PageContainer>
  );
}
