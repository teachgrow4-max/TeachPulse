import { describe, expect, it, vi } from 'vitest';
import type { EmployeeQrHolder } from '@teachgrow/shared';
import {
  CARD_PIXELS,
  QUIET_ZONE,
  cardFileName,
  cardPdfBlob,
  drawCard,
  qrMatrix,
  qrPath,
} from './qr-card';

// A well-formed (but made-up) employee code: TGE1 plus 43 base64url characters.
const PAYLOAD = `TGE1.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde'.slice(0, 43)}`;

const holder: EmployeeQrHolder = {
  employeeCode: 'E-1001',
  fullName: 'Priya Sharma',
  department: 'Academics',
  designation: 'Maths Teacher',
  avatarUrl: null,
};

// jsdom's Blob has no arrayBuffer(); FileReader is the portable way to look inside one.
const readBlob = (blob: Blob) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

describe('the QR image', () => {
  it('has the three finder squares every QR code has', () => {
    const m = qrMatrix(PAYLOAD);
    for (const [row, col] of [
      [0, 0],
      [0, m.size - 7],
      [m.size - 7, 0],
    ] as const) {
      // the outer ring of a finder is dark, the ring inside it is light, the centre dark
      expect(m.isDark(row, col)).toBe(true);
      expect(m.isDark(row + 6, col + 6)).toBe(true);
      expect(m.isDark(row + 1, col + 1)).toBe(false);
      expect(m.isDark(row + 3, col + 3)).toBe(true);
    }
  });

  it('is drawn as one path that reproduces the matrix exactly', () => {
    const m = qrMatrix(PAYLOAD);
    const { total, d } = qrPath(PAYLOAD);
    expect(total).toBe(m.size + QUIET_ZONE * 2);

    // Read the path back into a grid: "Mx yhWv1h-Wz" is a run of W dark modules at (x, y).
    const grid = Array.from({ length: m.size }, () => Array<boolean>(m.size).fill(false));
    for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, run] = [Number(match[1]), Number(match[2]), Number(match[3])];
      for (let i = 0; i < run; i += 1) grid[y - QUIET_ZONE]![x - QUIET_ZONE + i] = true;
    }
    for (let row = 0; row < m.size; row += 1) {
      for (let col = 0; col < m.size; col += 1) {
        expect(grid[row]![col], `module ${row},${col}`).toBe(m.isDark(row, col));
      }
    }
  });

  it('differs for a different code and is the same for the same code', () => {
    const other = `TGE1.${'Zz'.repeat(21)}9`;
    expect(qrPath(PAYLOAD).d).toBe(qrPath(PAYLOAD).d);
    expect(qrPath(other).d).not.toBe(qrPath(PAYLOAD).d);
  });
});

describe('the ID card file', () => {
  it('has a name that is safe on every system', () => {
    expect(cardFileName('E-1001', 'png')).toBe('teachgrow-id-E-1001.png');
    expect(cardFileName('../../etc/passwd', 'pdf')).toBe('teachgrow-id-_.._etc_passwd.pdf');
    expect(cardFileName('A B/C:D*E', 'pdf')).toBe('teachgrow-id-A_B_C_D_E.pdf');
    expect(cardFileName('', 'png')).toBe('teachgrow-id-employee.png');
  });

  it('draws the person and the code on the picture card', () => {
    const text: string[] = [];
    let modules = 0;
    const ctx = {
      fillRect: vi.fn(() => {
        modules += 1;
      }),
      fillText: vi.fn((value: string) => {
        text.push(value);
      }),
      measureText: (value: string) => ({ width: value.length * 20 }),
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    } as unknown as CanvasRenderingContext2D;

    drawCard(ctx, holder, PAYLOAD);

    expect(text).toEqual(
      expect.arrayContaining(['Priya Sharma', 'E-1001', 'Maths Teacher', 'Academics']),
    );
    expect(text.join(' ')).toMatch(/Never share a photo/);
    // background + header band + the white box behind the code + one rectangle per dark module
    const m = qrMatrix(PAYLOAD);
    let dark = 0;
    for (let r = 0; r < m.size; r += 1)
      for (let c = 0; c < m.size; c += 1) if (m.isDark(r, c)) dark += 1;
    expect(modules).toBe(3 + dark);
    expect(CARD_PIXELS.width / CARD_PIXELS.height).toBeCloseTo(85.6 / 54, 1);
  });

  it('shortens a name that would run off the card', () => {
    const text: string[] = [];
    const ctx = {
      fillRect: vi.fn(),
      fillText: vi.fn((value: string) => {
        text.push(value);
      }),
      measureText: (value: string) => ({ width: value.length * 20 }),
    } as unknown as CanvasRenderingContext2D;
    drawCard(ctx, { ...holder, fullName: 'Venkata Subramanyam Ramachandra Iyer' }, PAYLOAD);
    const shown = text.find((t) => t.startsWith('Venkata'));
    expect(shown).toMatch(/…$/);
    expect(shown!.length * 20).toBeLessThanOrEqual(470 + 20);
  });

  it('makes a real PDF', async () => {
    const blob = await cardPdfBlob(holder, PAYLOAD);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(800);
    const bytes = new Uint8Array(await readBlob(blob));
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toMatch(/^%PDF-1\.\d/);
  });
});
