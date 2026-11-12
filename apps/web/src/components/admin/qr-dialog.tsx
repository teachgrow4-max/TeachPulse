import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminEmployeeQrDetail, EmployeeQrCodeRecordDto } from '@teachgrow/shared';
import { api, messageOf } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { EmployeeQrView } from '../qr/employee-qr-view';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Field, Textarea } from '../ui/form';
import { Dialog } from '../ui/dialog';
import { BanIcon, RefreshIcon } from '../ui/icons';
import { Notice, Skeleton } from '../ui/misc';
import { useToast } from '../ui/toast';

type Mode = 'view' | 'regenerate' | 'revoke';

function CodeHistory({ codes }: { codes: EmployeeQrCodeRecordDto[] }) {
  return (
    <section aria-labelledby="qr-history-title" className="mt-5">
      <h3
        id="qr-history-title"
        className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
      >
        Every code this person has had
      </h3>
      <ol className="divide-y divide-line rounded-xl border border-line">
        {codes.map((code) => (
          <li key={code.id} className="flex flex-col gap-0.5 px-3.5 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone={code.status === 'ACTIVE' ? 'success' : 'neutral'}>
                {code.status === 'ACTIVE' ? 'Active' : 'Revoked'}
              </Badge>
              <span className="text-muted">
                Issued {formatDateTime(code.generatedAt)}
                {code.generatedBy ? ` by ${code.generatedBy.fullName}` : ' automatically'}
              </span>
            </div>
            {code.revokedAt ? (
              <p className="text-muted">
                Revoked {formatDateTime(code.revokedAt)}
                {code.revokedBy ? ` by ${code.revokedBy.fullName}` : ''}
                {code.revokeReason ? ` — ${code.revokeReason}` : ''}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One employee's QR code for an administrator: see it, download it, regenerate it, revoke it. */
export function QrDialog({
  employeeId,
  onClose,
}: {
  employeeId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [reason, setReason] = useState('');

  const key = ['employee-qr', 'detail', employeeId] as const;
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<AdminEmployeeQrDetail>(`/api/admin/employee-qr/${employeeId}`),
    enabled: employeeId !== null,
  });

  const change = useMutation({
    mutationFn: (action: 'regenerate' | 'revoke') =>
      api(`/api/admin/employee-qr/${employeeId}/${action}`, {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      }),
    onSuccess: async (_data, action) => {
      toast.show({
        tone: 'success',
        title: action === 'regenerate' ? 'New QR code issued' : 'QR code revoked',
        text:
          action === 'regenerate'
            ? 'The old code no longer works. Print a new ID card.'
            : 'It can no longer be used to record attendance.',
      });
      setMode('view');
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['employee-qr'] });
    },
  });

  const close = () => {
    setMode('view');
    setReason('');
    change.reset();
    onClose();
  };

  const data = detail.data;
  const revokeNeedsReason = mode === 'revoke' && reason.trim().length < 3;

  return (
    <Dialog
      open={employeeId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={data ? data.holder.fullName : 'QR code'}
      description={
        data
          ? `${data.holder.employeeCode}${data.holder.department ? ` · ${data.holder.department}` : ''}`
          : undefined
      }
      footer={
        mode === 'view' ? (
          <>
            <Button variant="outline" disabled={!data} onClick={() => setMode('regenerate')}>
              <RefreshIcon /> Regenerate
            </Button>
            <Button
              variant="outline"
              className="text-danger"
              disabled={!data || data.status !== 'ACTIVE'}
              onClick={() => setMode('revoke')}
            >
              <BanIcon /> Revoke
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setMode('view')} disabled={change.isPending}>
              Cancel
            </Button>
            <Button
              variant={mode === 'revoke' ? 'danger' : 'primary'}
              loading={change.isPending}
              disabled={revokeNeedsReason}
              onClick={() => change.mutate(mode)}
            >
              {mode === 'revoke' ? 'Revoke this code' : 'Regenerate code'}
            </Button>
          </>
        )
      }
    >
      {detail.isLoading ? (
        <div className="flex flex-col items-center gap-3 py-2">
          <Skeleton className="aspect-square w-56 rounded-2xl" />
          <Skeleton className="h-5 w-40" />
        </div>
      ) : detail.isError ? (
        <Notice tone="danger" title="Could not load this code">
          {messageOf(detail.error)}
        </Notice>
      ) : data ? (
        <>
          {mode === 'view' ? (
            <>
              <EmployeeQrView qr={data} />
              <CodeHistory codes={data.history} />
            </>
          ) : (
            <div className="flex flex-col gap-4 pt-1">
              <Notice
                tone={mode === 'revoke' ? 'danger' : 'warning'}
                title={mode === 'revoke' ? 'Revoke this code?' : 'Regenerate this code?'}
              >
                {mode === 'revoke'
                  ? `${data.holder.fullName} will not be able to use their code until you regenerate one. Use this when a card is lost or a code has been copied.`
                  : `The current code stops working immediately and a new one is issued. ${data.holder.fullName} will need a new printed ID card.`}
              </Notice>
              <Field
                label={mode === 'revoke' ? 'Reason (required)' : 'Reason (optional)'}
                hint="Kept in the audit log."
              >
                {(props) => (
                  <Textarea
                    {...props}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={
                      mode === 'revoke'
                        ? 'For example: ID card reported lost'
                        : 'For example: card photographed'
                    }
                  />
                )}
              </Field>
              {change.isError ? <Notice tone="danger">{messageOf(change.error)}</Notice> : null}
            </div>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
