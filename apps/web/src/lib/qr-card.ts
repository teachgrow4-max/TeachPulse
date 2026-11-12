import QRCode from 'qrcode';
import type { EmployeeQrHolder } from '@teachgrow/shared';

/**
 * Drawing an employee's QR code and their ID card.
 *
 * The code is drawn straight from the QR module matrix (squares), never from a screenshot or an
 * image library, so it is perfectly sharp at any size, on screen, in a PNG and in a PDF. QR codes
 * are always dark on light, even in dark mode: scanners depend on it.
 */

/** Quiet zone, in modules, around the code. The QR standard asks for four; two scans fine on a card. */
export const QUIET_ZONE = 2;

export interface QrMatrix {
  size: number;
  isDark(row: number, col: number): boolean;
}

export function qrMatrix(payload: string): QrMatrix {
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  return { size: modules.size, isDark: (row, col) => modules.get(row, col) === 1 };
}

/** The dark modules as one SVG path (horizontal runs), plus the width of the whole square. */
export function qrPath(payload: string, quiet = QUIET_ZONE): { total: number; d: string } {
  const matrix = qrMatrix(payload);
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < matrix.size && matrix.isDark(row, col + run)) run += 1;
      parts.push(`M${col + quiet} ${row + quiet}h${run}v1h-${run}z`);
      col += run;
    }
  }
  return { total: matrix.size + quiet * 2, d: parts.join('') };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** A file name safe on every system, built from the employee ID. */
export function cardFileName(employeeCode: string, extension: 'png' | 'pdf'): string {
  const safe = employeeCode.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'employee';
  return `teachgrow-id-${safe}.${extension}`;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the address is released.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------------------------
// PNG: a credit-card sized ID card (85.6 x 54 mm at about 300 dpi)
// ---------------------------------------------------------------------------------------------

export const CARD_PIXELS = { width: 1011, height: 638 } as const;
const BRAND = '#0f766e';

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened.trimEnd()}…`;
}

export function drawCard(
  ctx: CanvasRenderingContext2D,
  holder: EmployeeQrHolder,
  payload: string,
): void {
  const { width, height } = CARD_PIXELS;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // header band
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, width, 110);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.font = '700 46px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('TeachGrow', 48, 56);
  ctx.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('EMPLOYEE ID', width - 48, 56);

  // the person
  const textWidth = 470;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 56px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(fitText(ctx, holder.fullName, textWidth), 48, 235);
  ctx.fillStyle = '#334155';
  ctx.font = '500 34px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  let y = 295;
  for (const line of [holder.designation, holder.department]) {
    if (!line) continue;
    ctx.fillText(fitText(ctx, line, textWidth), 48, y);
    y += 48;
  }
  ctx.fillStyle = BRAND;
  ctx.font = '700 40px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(fitText(ctx, holder.employeeCode, textWidth), 48, Math.max(y + 24, 410));

  // the code
  const matrix = qrMatrix(payload);
  const modulePx = Math.floor(430 / (matrix.size + QUIET_ZONE * 2));
  const boxPx = modulePx * (matrix.size + QUIET_ZONE * 2);
  const left = width - 48 - boxPx;
  const top = 148;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(left, top, boxPx, boxPx);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.isDark(row, col)) {
        ctx.fillRect(
          left + (col + QUIET_ZONE) * modulePx,
          top + (row + QUIET_ZONE) * modulePx,
          modulePx,
          modulePx,
        );
      }
    }
  }

  // footer
  ctx.fillStyle = '#64748b';
  ctx.font = '500 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(
    'Show this code to an attendance operator. Never share a photo of it.',
    48,
    height - 34,
  );
}

export function cardPngBlob(holder: EmployeeQrHolder, payload: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_PIXELS.width;
  canvas.height = CARD_PIXELS.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser cannot draw the card.'));
  drawCard(ctx, holder, payload);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))),
      'image/png',
    );
  });
}

// ---------------------------------------------------------------------------------------------
// PDF: the same card, vector, ready to print at its real size
// ---------------------------------------------------------------------------------------------

export async function cardPdfBlob(holder: EmployeeQrHolder, payload: string): Promise<Blob> {
  // Loaded only when somebody asks for a PDF: it is the biggest dependency in the app.
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: [85.6, 54], orientation: 'landscape' });

  doc.setFillColor(15, 118, 110);
  doc.rect(0, 0, 85.6, 9.4, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('TeachGrow', 4, 6.3);
  doc.setFontSize(7);
  doc.text('EMPLOYEE ID', 81.6, 6.1, { align: 'right' });

  const clip = (text: string, max: number) => doc.splitTextToSize(text, max)[0] ?? text;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(12.5);
  doc.text(clip(holder.fullName, 40), 4, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  let y = 25.5;
  for (const line of [holder.designation, holder.department]) {
    if (!line) continue;
    doc.text(clip(line, 40), 4, y);
    y += 4.4;
  }
  doc.setFont('courier', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 118, 110);
  doc.text(clip(holder.employeeCode, 40), 4, Math.max(y + 2.5, 36));

  const matrix = qrMatrix(payload);
  const total = matrix.size + QUIET_ZONE * 2;
  const box = 35;
  const mod = box / total;
  const left = 85.6 - 4 - box;
  const top = 12.2;
  doc.setFillColor(255, 255, 255);
  doc.rect(left, top, box, box, 'F');
  doc.setFillColor(0, 0, 0);
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < matrix.size && matrix.isDark(row, col + run)) run += 1;
      doc.rect(
        left + (col + QUIET_ZONE) * mod,
        top + (row + QUIET_ZONE) * mod,
        run * mod,
        mod,
        'F',
      );
      col += run;
    }
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(100, 116, 139);
  doc.text('Show this code to an attendance operator. Never share a photo of it.', 4, 51);

  return doc.output('blob');
}
