import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { AddEmployeePage } from './add-employee';

const DEPT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const created = (password: string | undefined = 'Temp-Pass-123') =>
  json(201, {
    employee: {
      id: '55555555-5555-4555-8555-555555555555',
      employeeCode: 'E-2001',
      fullName: 'Rahul Verma',
      email: 'rahul@school.in',
    },
    ...(password ? { temporaryPassword: password } : {}),
  });

const departments = json(200, { items: [{ id: DEPT, name: 'Academics' }] });

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Full name'), 'Rahul Verma');
  await user.type(screen.getByLabelText('Email'), 'rahul@school.in');
  await user.type(screen.getByLabelText('Employee ID'), 'E-2001');
  await user.click(screen.getByRole('button', { name: 'Add employee' }));
  return user;
}

describe('Add employee page', () => {
  it('sends only what was filled in and shows the one-time password', async () => {
    const net = mockFetch({
      'GET /api/admin/departments': departments,
      'POST /api/admin/employees': created(),
    });
    renderApp(<AddEmployeePage />);
    await screen.findByRole('option', { name: 'Academics' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Department (optional)'), DEPT);
    await fillAndSubmit();

    expect(await screen.findByText('Rahul Verma was added')).toBeInTheDocument();
    expect(screen.getByTestId('temporary-password')).toHaveTextContent('Temp-Pass-123');
    expect(screen.getByText('This password is shown only once')).toBeInTheDocument();

    const body = net.called('POST /api/admin/employees')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      fullName: 'Rahul Verma',
      email: 'rahul@school.in',
      employeeCode: 'E-2001',
      role: 'employee',
      departmentId: DEPT,
    });
    expect(body).not.toHaveProperty('designation');
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('initialPassword'); // the server generates it
    expect(body.joiningDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows a refusal next to the field the server names, and keeps what was typed', async () => {
    mockFetch({
      'GET /api/admin/departments': departments,
      'POST /api/admin/employees': json(409, {
        error: {
          code: 'CONFLICT',
          message: 'An employee with this email already exists.',
          details: [{ path: 'email', message: 'An employee with this email already exists.' }],
        },
      }),
    });
    renderApp(<AddEmployeePage />);
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByLabelText('Email')).toHaveValue('rahul@school.in');
    expect(screen.queryByTestId('temporary-password')).not.toBeInTheDocument();
  });

  it('forgets the password when another employee is added', async () => {
    mockFetch({
      'GET /api/admin/departments': departments,
      'POST /api/admin/employees': created(),
    });
    renderApp(<AddEmployeePage />);
    const user = await fillAndSubmit();
    await screen.findByTestId('temporary-password');
    await user.click(screen.getByRole('button', { name: 'Add another employee' }));
    await waitFor(() => expect(screen.getByLabelText('Full name')).toHaveValue(''));
    expect(screen.queryByText('Temp-Pass-123')).not.toBeInTheDocument();
  });
});
