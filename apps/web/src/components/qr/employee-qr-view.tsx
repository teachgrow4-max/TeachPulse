import { useState } from 'react';
import type { EmployeeQrDto } from '@teachgrow/shared';
import { cardFileName, cardPdfBlob, cardPngBlob, saveBlob } from '../../lib/qr-card';
import { messageOf } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DownloadIcon, ShieldCheckIcon } from '../ui/icons';
import { Notice } from '../ui/misc';
import { useToast } from '../ui/toast';
import { QrImage } from './qr-image';

/**
 * An employee's QR code with its download buttons. Used on the employee's own profile and, for
 * administrators, in the dialog for any employee.
 */
export function EmployeeQrView({ qr, own = false }: { qr: EmployeeQrDto; own?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null);
  const { holder } = qr;

  async function download(kind: 'png' | 'pdf') {
    if (!qr.payload) return;
    setBusy(kind);
    try {
      const blob =
        kind === 'png'
          ? await cardPngBlob(holder, qr.payload)
          : await cardPdfBlob(holder, qr.payload);
      saveBlob(blob, cardFileName(holder.employeeCode, kind));
      toast.show({ tone: 'success', title: `ID card downloaded (${kind.toUpperCase()})` });
    } catch (error) {
      toast.show({ tone: 'danger', title: 'Could not create the file', text: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  if (qr.status !== 'ACTIVE' || !qr.payload) {
    return (
      <Notice
        tone="warning"
        title={qr.status === 'REVOKED' ? 'This QR code was revoked' : 'No QR code yet'}
      >
        {own
          ? 'Ask HR for a new one. Until then an attendance operator cannot record your attendance with it.'
          : 'This employee has no live code. Regenerate it to issue a new one.'}
      </Notice>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-full max-w-[19rem] rounded-2xl border border-line bg-white p-3 shadow-card">
        <QrImage payload={qr.payload} label={`QR code for ${holder.fullName}`} />
      </div>
      <div className="text-center">
        <p className="text-base font-semibold">{holder.fullName}</p>
        <p className="font-mono text-sm text-muted">{holder.employeeCode}</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Badge tone="success">
            <ShieldCheckIcon className="h-3.5 w-3.5" />
            Active
          </Badge>
          {qr.generatedAt ? (
            <span className="text-xs text-muted">Issued {formatDateTime(qr.generatedAt)}</span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={() => void download('png')} loading={busy === 'png'}>
          <DownloadIcon /> Download PNG
        </Button>
        <Button variant="outline" onClick={() => void download('pdf')} loading={busy === 'pdf'}>
          <DownloadIcon /> Download PDF
        </Button>
      </div>
      <p className="max-w-sm text-center text-xs text-muted">
        {own
          ? 'Show this code to an attendance operator, or print it on your ID card. Anyone who copies it could try to use it, so never post a photo of it.'
          : 'Print this on the employee’s ID card. If it is lost or copied, revoke or regenerate it.'}
      </p>
    </div>
  );
}
