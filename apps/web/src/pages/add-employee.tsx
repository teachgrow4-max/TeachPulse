import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateEmployeeResponse, DepartmentDto } from '@teachgrow/shared';
import { api, ApiError, messageOf } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input, Select } from '../components/ui/form';
import { CheckIcon } from '../components/ui/icons';
import { Notice } from '../components/ui/misc';
import { useToast } from '../components/ui/toast';

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
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckIcon />
        </span>
        <div>
          <h2 className="text-lg font-bold">{employee.fullName} was added</h2>
          <p className="text-sm text-muted">
            <span className="font-mono">{employee.employeeCode}</span> · {employee.email}
          </p>
        </div>
      </div>

      {temporaryPassword ? (
        <>
          <div>
            <p className="text-sm font-medium">One-time password</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code
                data-testid="temporary-password"
                className="select-all rounded-xl border border-line bg-surface-2 px-4 py-2.5 font-mono text-base tracking-wide"
              >
                {temporaryPassword}
              </code>
              <Button variant="outline" onClick={() => void copy()}>
                Copy
              </Button>
            </div>
          </div>
          <Notice tone="warning" title="This password is shown only once">
            Give it to {employee.fullName} now. It is not stored anywhere you can read it again.
            They sign in with {employee.email} and this password, and must choose their own password
            straight away.
          </Notice>
        </>
      ) : (
        <Notice tone="info">No temporary password was generated for this account.</Notice>
      )}

      <div>
        <Button onClick={onAnother}>Add another employee</Button>
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
      await queryClient.invalidateQueries({ queryKey: ['employee-qr'] });
      await queryClient.invalidateQueries({ queryKey: ['employee-picker'] });
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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">Add employee</h1>
        <p className="text-sm text-muted">
          Creates the sign-in and the profile. A one-time password is generated and shown once.
        </p>
      </div>

      {result ? (
        <Created
          result={result}
          onAnother={() => {
            setResult(null);
            setForm(empty());
          }}
        />
      ) : (
        <Card className="p-5">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
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

            <div className="sm:col-span-2">
              <Button type="submit" loading={create.isPending}>
                Add employee
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
