import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeQrDto } from '@teachgrow/shared';
import { session } from '../lib/api';
import { json, mockFetch, person, renderApp, session as sessionBody } from '../test/utils';
import type * as QrCardModule from '../lib/qr-card';
import { ProfilePage } from './profile';

// Downloading really creates a file; here we only want to know it was asked for, under which name.
const files = vi.hoisted(() => ({ saveBlob: vi.fn(), pdf: vi.fn(), png: vi.fn() }));
vi.mock('../lib/qr-card', async (importOriginal) => {
  const original = await importOriginal<typeof QrCardModule>();
  return {
    ...original,
    saveBlob: files.saveBlob,
    cardPdfBlob: files.pdf,
    cardPngBlob: files.png,
  };
});

const PAYLOAD = `TGE1.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde'.slice(0, 43)}`;
const qr = (over: Partial<EmployeeQrDto> = {}): EmployeeQrDto => ({
  status: 'ACTIVE',
  payload: PAYLOAD,
  generatedAt: '2026-11-01T05:00:00.000Z',
  revokedAt: null,
  holder: {
    employeeCode: 'E-1001',
    fullName: 'Priya Sharma',
    department: 'Academics',
    designation: 'Maths Teacher',
    avatarUrl: null,
  },
  ...over,
});

beforeEach(() => {
  session.set('test-token');
  files.saveBlob.mockReset();
  files.pdf.mockReset().mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
  files.png.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderProfile() {
  mockFetch({
    'POST /api/auth/refresh': json(200, sessionBody(person())),
    'GET /api/employee-qr/me': json(200, qr()),
  });
  return renderApp(<ProfilePage />, { auth: true });
}

describe('the profile page', () => {
  it('shows the person and their own QR code', async () => {
    renderProfile();
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
    expect(screen.getAllByText('E-1001').length).toBeGreaterThan(0);
    expect(screen.getByText('Academics')).toBeInTheDocument();
    expect(screen.getByText('Maths Teacher')).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: 'QR code for Priya Sharma' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('draws the code as a vector image of the code itself, black on white', async () => {
    renderProfile();
    const svg = await screen.findByRole('img', { name: 'QR code for Priya Sharma' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#000000');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    expect((svg.querySelector('path')?.getAttribute('d') ?? '').length).toBeGreaterThan(200);
  });

  it('downloads the ID card as a PNG and as a PDF, named after the employee ID', async () => {
    const user = userEvent.setup();
    renderProfile();
    await user.click(await screen.findByRole('button', { name: /Download PNG/ }));
    await waitFor(() => expect(files.saveBlob).toHaveBeenCalledTimes(1));
    expect(files.png).toHaveBeenCalledWith(
      expect.objectContaining({ employeeCode: 'E-1001' }),
      PAYLOAD,
    );
    expect(files.saveBlob.mock.calls[0]?.[1]).toBe('teachgrow-id-E-1001.png');

    await user.click(screen.getByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(files.saveBlob).toHaveBeenCalledTimes(2));
    expect(files.saveBlob.mock.calls[1]?.[1]).toBe('teachgrow-id-E-1001.pdf');
    expect(await screen.findAllByText(/ID card downloaded/)).not.toHaveLength(0);
  });

  it('says so, and does not offer a download, when the code has been revoked', async () => {
    mockFetch({
      'POST /api/auth/refresh': json(200, sessionBody(person())),
      'GET /api/employee-qr/me': json(
        200,
        qr({ status: 'REVOKED', payload: null, revokedAt: '2026-11-02T05:00:00.000Z' }),
      ),
    });
    renderApp(<ProfilePage />, { auth: true });
    expect(await screen.findByText('This QR code was revoked')).toBeInTheDocument();
    expect(screen.getByText(/Ask HR for a new one/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
  });

  it('reports a failure to create the file instead of failing silently', async () => {
    const user = userEvent.setup();
    renderProfile();
    files.pdf.mockRejectedValueOnce(new Error('The PDF library did not load.'));
    await user.click(await screen.findByRole('button', { name: /Download PDF/ }));
    expect(await screen.findByText('Could not create the file')).toBeInTheDocument();
    expect(screen.getByText('The PDF library did not load.')).toBeInTheDocument();
    expect(files.saveBlob).not.toHaveBeenCalled();
  });

  it('offers a retry when the code cannot be loaded', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(200, sessionBody(person())),
      'GET /api/employee-qr/me': [
        json(503, {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'The service is temporarily unavailable.',
          },
        }),
        json(200, qr()),
      ],
    });
    renderApp(<ProfilePage />, { auth: true });
    expect(await screen.findByText('Your QR code could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for Priya Sharma' }),
    ).toBeInTheDocument();
  });
});
