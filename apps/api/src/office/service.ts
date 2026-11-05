import type {
  OfficeNetworkDto,
  OfficeReadinessIssue,
  OfficeSettingsDto,
  OfficeSettingsResponse,
  OfficeSettingsUpdate,
  OfficeTestResponse,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import type { Db, Queryable } from '../db/pool.js';
import type { Actor } from '../employees/service.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { normalizeIp, type RequestMeta } from '../lib/request-meta.js';
import { evaluateGps } from '../verification/gps.js';
import { evaluateNetwork } from '../verification/network.js';
import { windowIndexAt, windowOf } from '../verification/qr.js';
import {
  NETWORK_COLUMNS,
  listNetworks,
  loadActiveOffice,
  toNetwork,
  type NetworkDbRow,
  type NetworkRow,
  type OfficeRow,
} from './repository.js';

export interface OfficeServiceDeps {
  db: Db;
  clock: Clock;
}

const validation = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', undefined, { details: [{ path, message }] });

const conflict = (path: string, message: string): AppError =>
  new AppError('CONFLICT', message, { details: [{ path, message }] });

export const toSettingsDto = (office: OfficeRow): OfficeSettingsDto => ({
  id: office.id,
  name: office.name,
  address: office.address,
  latitude: office.latitude,
  longitude: office.longitude,
  geofenceRadiusM: office.geofenceRadiusM,
  maxGpsAccuracyM: office.maxGpsAccuracyM,
  maxFixAgeSeconds: office.maxFixAgeSeconds,
  qrRotationSeconds: office.qrRotationSeconds,
  timezone: office.timezone,
  workingDays: office.workingDays,
  updatedAt: office.updatedAt.toISOString(),
});

export const toNetworkDto = (network: NetworkRow): OfficeNetworkDto => ({
  id: network.id,
  label: network.label,
  cidr: network.cidr,
  isActive: network.isActive,
  nonPublic: network.nonPublic,
  createdAt: network.createdAt.toISOString(),
});

const COLUMN_FOR: Record<keyof OfficeSettingsUpdate, string> = {
  name: 'name',
  address: 'address',
  latitude: 'latitude',
  longitude: 'longitude',
  geofenceRadiusM: 'geofence_radius_m',
  maxGpsAccuracyM: 'max_gps_accuracy_m',
  maxFixAgeSeconds: 'max_fix_age_seconds',
  qrRotationSeconds: 'qr_rotation_seconds',
  timezone: 'timezone',
  workingDays: 'working_days',
};

type Snapshot = Omit<OfficeSettingsDto, 'id' | 'updatedAt'>;

const snapshotOf = (office: OfficeRow): Snapshot => {
  const { id: _id, updatedAt: _updatedAt, ...rest } = toSettingsDto(office);
  return rest;
};

/** Which fields differ, as before/after objects containing only those fields. */
function diff(
  before: Snapshot,
  after: Snapshot,
): { before: object; after: object; keys: string[] } {
  const keys = (Object.keys(after) as Array<keyof Snapshot>).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  const pick = (source: Snapshot) => Object.fromEntries(keys.map((key) => [key, source[key]]));
  return { before: pick(before), after: pick(after), keys };
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  /** Postgres puts the human explanation of many errors here, not in the message. */
  detail?: string;
}

function constraintOf(error: unknown): { code?: string; name?: string; message: string } {
  const e = (error ?? {}) as PgErrorLike;
  const quoted = /"([^"]+)"/.exec(e.message ?? '')?.[1];
  return {
    code: e.code,
    name: e.constraint ?? quoted,
    message: [e.message, e.detail].filter(Boolean).join(' '),
  };
}

function mapOfficeWriteError(error: unknown): unknown {
  const { code, name } = constraintOf(error);
  if (code === '23514' && name?.includes('timezone')) {
    return validation('timezone', 'Use an IANA timezone name such as Asia/Kolkata.');
  }
  if (code === '23514') {
    return validation('settings', 'One of the values is outside its allowed range.');
  }
  if (code === '23505' && name === 'office_locations_single_active') {
    return conflict(
      'settings',
      'The office was just configured by someone else. Reload and try again.',
    );
  }
  return error;
}

const IPV4_FULL = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

/** `::ffff:203.0.113.5` is just IPv4 `203.0.113.5` as far as a client address is concerned. */
function stripIpv4Mapped(value: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(\/\d{1,3})?$/i.exec(value);
  if (!match) return value;
  const prefix = match[2] ? Number(match[2].slice(1)) - 96 : undefined;
  return prefix === undefined ? match[1]! : `${match[1]}/${Math.max(prefix, 0)}`;
}

interface NormalizedNetwork {
  cidr: string;
  family: number;
  prefix: number;
}

export class OfficeService {
  constructor(private readonly deps: OfficeServiceDeps) {}

  // ---------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------

  async getSettings(): Promise<OfficeSettingsResponse> {
    const { db } = this.deps;
    const office = await loadActiveOffice(db);
    const networks = office ? await listNetworks(db, office.id) : [];
    return {
      office: office ? toSettingsDto(office) : null,
      networks: networks.map(toNetworkDto),
      readiness: await this.readiness(office, networks),
    };
  }

  private async readiness(
    office: OfficeRow | null,
    networks: NetworkRow[],
  ): Promise<OfficeSettingsResponse['readiness']> {
    const issues: OfficeReadinessIssue[] = [];
    if (!office) {
      issues.push({
        code: 'OFFICE_NOT_CONFIGURED',
        message: 'Set the office name and location. Until then nobody can check in.',
      });
      return { ready: false, issues };
    }

    const active = networks.filter((n) => n.isActive);
    if (active.length === 0) {
      issues.push({
        code: 'NO_ACTIVE_NETWORK',
        message: 'Add the office public IP address. Until then nobody can check in.',
      });
    } else if (active.every((n) => n.nonPublic)) {
      issues.push({
        code: 'ONLY_NON_PUBLIC_NETWORKS',
        message:
          'Every active network is a private address. The server only sees the office public IP, so these can never match.',
      });
    }

    const { rows } = await this.deps.db.query<{ present: boolean }>(
      `select exists (
         select 1 from public.profiles p join public.roles r on r.id = p.role_id
         where r.name = 'office_display' and p.is_active
       ) as present`,
    );
    if (!rows[0]?.present) {
      issues.push({
        code: 'NO_QR_DISPLAY_ACCOUNT',
        message:
          'Create an office display account so the lobby screen can show the rotating QR code.',
      });
    }

    if (office.maxGpsAccuracyM > office.geofenceRadiusM) {
      issues.push({
        code: 'ACCURACY_EXCEEDS_RADIUS',
        message:
          'The allowed GPS inaccuracy is larger than the geofence radius, so a reading could be accepted that is actually outside the office.',
      });
    }
    return { ready: issues.length === 0, issues };
  }

  /** Create the office (first time) or change the fields given. */
  async updateSettings(
    patch: OfficeSettingsUpdate,
    actor: Actor,
    meta: RequestMeta,
  ): Promise<OfficeSettingsResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();

    try {
      await db.withTransaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext('teachgrow.office'))`);
        const current = await loadActiveOffice(tx, { lock: true });
        const base = {
          actorId: actor.id,
          actorRole: actor.role,
          entityType: 'office',
          ...meta,
          at: now,
        };

        const assignments = (Object.keys(patch) as Array<keyof OfficeSettingsUpdate>)
          .filter((key) => patch[key] !== undefined)
          .map((key) => {
            const value = patch[key];
            return {
              column: COLUMN_FOR[key],
              cast: key === 'workingDays' ? '::smallint[]' : '',
              value:
                key === 'workingDays' ? `{${[...(value as number[])].sort().join(',')}}` : value,
            };
          });

        if (!current) {
          const missing = (['name', 'latitude', 'longitude'] as const).filter(
            (key) => patch[key] === undefined,
          );
          if (missing.length > 0) {
            throw new AppError(
              'VALIDATION_FAILED',
              'Name, latitude and longitude are required the first time the office is set up.',
              { details: missing.map((path) => ({ path, message: 'Required.' })) },
            );
          }
          const params = assignments.map((a) => a.value);
          const inserted = await tx.query<{ id: string }>(
            `insert into public.office_locations (${assignments.map((a) => a.column).join(', ')})
             values (${assignments.map((a, i) => `$${i + 1}${a.cast}`).join(', ')})
             returning id`,
            params,
          );
          const created = (await loadActiveOffice(tx))!;
          await writeAudit(tx, {
            ...base,
            action: 'office.create',
            entityId: inserted.rows[0]!.id,
            after: snapshotOf(created),
          });
          return;
        }

        const params: unknown[] = [current.id, ...assignments.map((a) => a.value)];
        await tx.query(
          `update public.office_locations
           set ${assignments.map((a, i) => `${a.column} = $${i + 2}${a.cast}`).join(', ')}
           where id = $1`,
          params,
        );
        const updated = (await loadActiveOffice(tx))!;
        const changes = diff(snapshotOf(current), snapshotOf(updated));
        if (changes.keys.length > 0) {
          await writeAudit(tx, {
            ...base,
            action: 'office.update',
            entityId: current.id,
            before: changes.before,
            after: changes.after,
          });
        }
      });
    } catch (error) {
      throw mapOfficeWriteError(error);
    }
    return this.getSettings();
  }

  // ---------------------------------------------------------------------------------------
  // Networks
  // ---------------------------------------------------------------------------------------

  async listNetworks(): Promise<OfficeNetworkDto[]> {
    const office = await loadActiveOffice(this.deps.db);
    if (!office) return [];
    return (await listNetworks(this.deps.db, office.id)).map(toNetworkDto);
  }

  /**
   * Accepts `203.0.113.10` or `203.0.113.0/29` (IPv4 or IPv6), validated and normalised by
   * Postgres itself so the stored value is exactly what the matching query will compare against.
   */
  private async normalizeNetwork(input: string): Promise<NormalizedNetwork> {
    const raw = stripIpv4Mapped(input.trim());
    const friendly =
      'Enter an IP address or range such as 203.0.113.10 or 203.0.113.0/29 (IPv6 works too).';

    // Postgres would quietly expand shorthand like "10.1" to 10.1.0.0; require full addresses.
    if (!raw.includes(':') && !IPV4_FULL.test(raw)) throw validation('cidr', friendly);

    try {
      const { rows } = await this.deps.db.query<NormalizedNetwork>(
        raw.includes('/')
          ? `select ($1::cidr)::text as cidr, family($1::cidr)::int as family, masklen($1::cidr)::int as prefix`
          : `select (($1::inet)::cidr)::text as cidr, family($1::inet)::int as family, masklen($1::inet)::int as prefix`,
        [raw],
      );
      const normalized = rows[0]!;
      const tooBroad =
        (normalized.family === 4 && normalized.prefix < 16) ||
        (normalized.family === 6 && normalized.prefix < 48);
      if (tooBroad) {
        throw validation(
          'cidr',
          'That range is too broad. Use /16 or narrower for IPv4 (/48 or narrower for IPv6), ideally just your office address.',
        );
      }
      return normalized;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (/bits set to right of mask/i.test(constraintOf(error).message)) {
        let hint = '';
        try {
          const { rows } = await this.deps.db.query<{ suggestion: string }>(
            'select network($1::inet)::text as suggestion',
            [raw],
          );
          hint = rows[0] ? ` Did you mean ${rows[0].suggestion}?` : '';
        } catch {
          // The suggestion is a courtesy only.
        }
        throw validation(
          'cidr',
          `That range has host bits set, so it is not a network address.${hint}`,
        );
      }
      throw validation('cidr', friendly);
    }
  }

  async addNetwork(
    input: { label: string; cidr: string },
    actor: Actor,
    meta: RequestMeta,
  ): Promise<{ network: OfficeNetworkDto; warnings: string[] }> {
    const { db, clock } = this.deps;
    const normalized = await this.normalizeNetwork(input.cidr);

    const network = await db
      .withTransaction(async (tx) => {
        const office = await loadActiveOffice(tx);
        if (!office) throw new AppError('CONFLICT', 'Set up the office location first.');
        const inserted = await tx.query<{ id: string }>(
          `insert into public.office_networks (office_id, label, cidr, created_by)
           values ($1, $2, $3::cidr, $4) returning id`,
          [office.id, input.label, normalized.cidr, actor.id],
        );
        const created = await this.loadNetwork(tx, inserted.rows[0]!.id);
        await writeAudit(tx, {
          action: 'office.network.add',
          actorId: actor.id,
          actorRole: actor.role,
          entityType: 'office_network',
          entityId: created.id,
          after: { label: created.label, cidr: created.cidr },
          ...meta,
          at: clock.now(),
        });
        return created;
      })
      .catch((error: unknown) => {
        if (constraintOf(error).code === '23505') {
          throw conflict('cidr', 'That address or range is already on the list.');
        }
        throw error;
      });

    return {
      network: toNetworkDto(network),
      warnings: network.nonPublic ? ['NON_PUBLIC_RANGE'] : [],
    };
  }

  async updateNetwork(
    id: string,
    patch: {
      label?: string | undefined;
      cidr?: string | undefined;
      isActive?: boolean | undefined;
    },
    actor: Actor,
    meta: RequestMeta,
  ): Promise<{ network: OfficeNetworkDto; warnings: string[] }> {
    const { db, clock } = this.deps;
    const normalized = patch.cidr !== undefined ? await this.normalizeNetwork(patch.cidr) : null;

    const after = await db
      .withTransaction(async (tx) => {
        const locked = await tx.query<NetworkDbRow>(
          `select ${NETWORK_COLUMNS} from public.office_networks n where n.id = $1 for update`,
          [id],
        );
        if (!locked.rows[0]) throw new AppError('NOT_FOUND');
        const current = toNetwork(locked.rows[0]);

        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (column: string, value: unknown, cast = ''): void => {
          values.push(value);
          sets.push(`${column} = $${values.length}${cast}`);
        };
        if (patch.label !== undefined) set('label', patch.label);
        if (normalized) set('cidr', normalized.cidr, '::cidr');
        if (patch.isActive !== undefined) set('is_active', patch.isActive);
        if (sets.length > 0) {
          await tx.query(
            `update public.office_networks set ${sets.join(', ')} where id = $1`,
            values,
          );
        }

        const updated = await this.loadNetwork(tx, id);
        const pick = (n: NetworkRow) => ({ label: n.label, cidr: n.cidr, isActive: n.isActive });
        if (JSON.stringify(pick(current)) !== JSON.stringify(pick(updated))) {
          await writeAudit(tx, {
            action: 'office.network.update',
            actorId: actor.id,
            actorRole: actor.role,
            entityType: 'office_network',
            entityId: id,
            before: pick(current),
            after: pick(updated),
            ...meta,
            at: clock.now(),
          });
        }
        return updated;
      })
      .catch((error: unknown) => {
        if (constraintOf(error).code === '23505') {
          throw conflict('cidr', 'That address or range is already on the list.');
        }
        throw error;
      });

    return { network: toNetworkDto(after), warnings: after.nonPublic ? ['NON_PUBLIC_RANGE'] : [] };
  }

  async deleteNetwork(id: string, actor: Actor, meta: RequestMeta): Promise<void> {
    const { db, clock } = this.deps;
    await db.withTransaction(async (tx) => {
      const removed = await tx.query<{ label: string; cidr: string }>(
        'delete from public.office_networks where id = $1 returning label, cidr::text as cidr',
        [id],
      );
      if (!removed.rows[0]) throw new AppError('NOT_FOUND');
      await writeAudit(tx, {
        action: 'office.network.delete',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'office_network',
        entityId: id,
        before: removed.rows[0],
        ...meta,
        at: clock.now(),
      });
    });
  }

  private async loadNetwork(q: Queryable, id: string): Promise<NetworkRow> {
    const { rows } = await q.query<NetworkDbRow>(
      `select ${NETWORK_COLUMNS} from public.office_networks n where n.id = $1`,
      [id],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND');
    return toNetwork(rows[0]);
  }

  // ---------------------------------------------------------------------------------------
  // "Test my configuration" - runs the real evaluators, writes nothing
  // ---------------------------------------------------------------------------------------

  async test(
    input: { gps?: Parameters<typeof evaluateGps>[0]; ipAddress?: string | undefined },
    callerIp: string | null,
  ): Promise<OfficeTestResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const office = await loadActiveOffice(db);
    if (!office) throw new AppError('CONFLICT', 'Set up the office location first.');

    let ip = callerIp;
    let source: 'request' | 'supplied' = 'request';
    if (input.ipAddress !== undefined) {
      // normalizeIp returns null for anything that is not a valid IPv4 / IPv6 address.
      const supplied = normalizeIp(input.ipAddress);
      if (!supplied) throw validation('ipAddress', 'Enter a valid IPv4 or IPv6 address.');
      ip = supplied;
      source = 'supplied';
    }

    const gps = input.gps
      ? evaluateGps(
          input.gps,
          {
            latitude: office.latitude,
            longitude: office.longitude,
            radiusM: office.geofenceRadiusM,
            maxAccuracyM: office.maxGpsAccuracyM,
            maxFixAgeSeconds: office.maxFixAgeSeconds,
          },
          now,
        )
      : null;
    const network = await evaluateNetwork(db, office.id, ip);
    const window = windowOf(windowIndexAt(now, office.qrRotationSeconds), office.qrRotationSeconds);

    return {
      gps: {
        result: gps ? gps.result : 'NOT_TESTED',
        distanceMeters: gps?.distanceM ?? null,
        radiusM: office.geofenceRadiusM,
        maxAccuracyM: office.maxGpsAccuracyM,
        reasons: gps?.reasons ?? [],
      },
      network: {
        result: network.result,
        ipAddress: ip,
        source,
        matchedNetwork: network.matched,
        reasons: network.reasons,
      },
      qr: {
        rotationSeconds: office.qrRotationSeconds,
        currentWindow: {
          validFrom: window.validFrom.toISOString(),
          expiresAt: window.expiresAt.toISOString(),
        },
      },
    };
  }
}
