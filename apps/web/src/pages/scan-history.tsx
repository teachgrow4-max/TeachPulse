import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ScanHistory } from '../components/admin/scan-history';
import type { PickedEmployee } from '../components/admin/employee-picker';
import { buttonClass } from '../components/ui/button';
import { ScanIcon } from '../components/ui/icons';
import { PageContainer, PageHeader } from '../components/ui/page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every QR scan, filterable and paged. Other pages link here with `?employee=<id>&name=<name>` to
 * show one person's scans.
 */
export function ScanHistoryPage() {
  const [params] = useSearchParams();
  const initialEmployee = useMemo<PickedEmployee | null>(() => {
    const id = params.get('employee');
    if (!id || !UUID.test(id)) return null;
    return { id, label: params.get('name')?.slice(0, 120) || 'Selected employee' };
    // Only the first render decides; after that the filters belong to the page.
  }, []);

  return (
    <PageContainer>
      <PageHeader
        title="Scan History"
        description="Every QR scan: who was scanned, what happened, and who held the camera."
        actions={
          <Link to="/scanner" className={buttonClass({ variant: 'primary' })}>
            <ScanIcon className="h-4 w-4" /> Scan Employee QR
          </Link>
        }
      />
      <ScanHistory initialEmployee={initialEmployee} />
    </PageContainer>
  );
}
