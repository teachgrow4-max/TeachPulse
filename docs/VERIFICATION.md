# Office verification

How TeachGrow decides that somebody is physically at the office before it lets them check in or out.
Implemented in Phase 5. The code lives in `apps/api/src/verification/`, `apps/api/src/devices/` and
`apps/api/src/office/`.

> **Read this first.** No single check can prove where a person is. Each of the four layers below
> can be defeated on its own, and the table says how. Together they make faking presence
> noticeably harder and leave evidence behind. They do not make it impossible, and nothing here
> should be described to staff as foolproof.

## The four layers

| # | Layer | What it establishes | How it can still be defeated |
| --- | --- | --- | --- |
| 1 | **Location** (GPS geofence) | The device _reported_ a precise, fresh position within the configured radius of the office, and did not flag it as mocked. | A rooted phone or a spoofing tool that hides the mock flag. A radius generous enough to cover the building also covers the car park next door. |
| 2 | **Office network** | The request reached the API from one of the office's public IP ranges. | Anyone genuinely on the office network can relay for someone elsewhere (remote desktop, a tethered laptop). Guest Wi-Fi shares the address. Office addresses that change need the allowlist kept up to date. Phones on mobile data fail by design (decision D8). |
| 3 | **Rotating QR code** | The person could see the lobby screen within the last ~40 seconds. | Somebody in the lobby photographing or streaming the screen to a person outside, inside that window. Mitigated, not removed, by the short window and one-use-per-person. |
| 4 | **Registered device** | The device an administrator approved, holding the private key it registered, is present, and (for a browser) the person unlocked it. | A phone handed to a colleague who then unlocks it. A passkey that the platform syncs between a person's devices is not tied to one machine. Native app integrity is **not yet attested** (see _Not yet in place_). |

Location and network are **always** required, for check-in and check-out (the database refuses a
check-in verification without them, and the engine insists for check-out too: decision D3). The QR
code and the device are configurable per channel in the attendance policy.

## What happens on a check-in

```
 phone / browser                         API                                   database
 ───────────────                         ───                                   ────────
 collects EVIDENCE:                      decides everything itself:
   • a location fix                        • distance, from the raw fix
   • the scanned QR text    ───────►       • address, from the connection        attendance_verifications
   • a signed challenge     POST           • code, recomputed and checked          one row per attempt,
                            /api/attendance/verify  • device, from its own records   pass or fail
                                                                                  
                            ◄───────  VERIFIED  (valid 120 s, usable once)
                                      or 422 VERIFICATION_FAILED + every reason

 later: check-in / check-out  ───────►  private.check_in / check_out accept ONLY a VERIFIED row
```

The client never sends a verdict, a distance, an address, or a time that the server believes. The
request schema is strict: a body containing `result`, `layers`, `distanceM`, `ip`, `requestedAt`
or `employeeId` is rejected with 400.

### Endpoints

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /api/office/qr/current` | `office_display`, `admin` | The code on screen now, the next one, and the exact window boundaries. |
| `POST /api/office/qr/verify` | tracked employees | Instant "is this code good?" feedback after scanning. Never consumes the code. |
| `POST /api/devices/register/options` | tracked employees | Step 1 of enrolling a device: a one-time challenge (plus passkey options for browsers). |
| `POST /api/devices/register` | tracked employees | Step 2: password + proof of the device key. Creates a **PENDING** device. |
| `GET /api/devices`, `DELETE /api/devices/:id` | tracked employees | List and remove their own devices. |
| `POST /api/attendance/challenge` | tracked employees | A one-time challenge for a registered device to sign for one check-in / check-out. |
| `POST /api/attendance/verify` | tracked employees | The verification itself. |
| `GET/PUT /api/admin/office/settings`, `…/networks`, `POST …/test` | `admin` | Office location, thresholds, network allowlist, and a "what would happen if" tool. |
| `GET /api/admin/devices`, `POST …/:id/approve`, `POST …/:id/revoke` | `admin` | The device approval queue. |

"Tracked" means `attendance_required = true`. Administrators and the lobby display account are
usually not tracked, and are refused these endpoints.

### Verify request

```jsonc
{
  "purpose": "CHECK_IN",            // or CHECK_OUT
  "channel": "MOBILE",              // or WEB
  "gps": { "latitude": 10.0, "longitude": 20.0, "accuracyM": 12,
           "fixTime": 1793593800000,  // epoch ms or ISO 8601, the device's own timestamp
           "mocked": false },         // Android's mock-provider flag, when available
  "qr": { "payload": "TG1.59786460.q3N…" },
  "device": { "deviceId": "…", "challengeId": "…",
              "proof": { "type": "APP_KEY", "signature": "…" } }  // or { "type": "WEBAUTHN", "response": { … } }
}
```

Layers the policy does not require are ignored: sending a QR code that is not needed does not use
it up.

### Verify response

Success — `200`:

```jsonc
{ "result": "VERIFIED", "verificationId": "…", "expiresAt": "2026-11-02T04:32:00.000Z",
  "layers": { "GPS": "PASS", "NETWORK": "PASS", "QR": "PASS", "DEVICE": "PASS" },
  "gps": { "distanceMeters": 40, "accuracyMeters": 12 } }
```

Failure — `422 VERIFICATION_FAILED`. **Every layer is evaluated**, so a person is told about all
the problems at once:

```jsonc
{ "error": { "code": "VERIFICATION_FAILED", "message": "You are about 500 m from the office; …",
    "details": { "result": "REJECTED", "verificationId": "…",
      "layers": { "GPS": "FAIL", "NETWORK": "PASS", "QR": "FAIL", "DEVICE": "PASS" },
      "reasons": [ { "code": "GPS_OUTSIDE_RADIUS", "layer": "GPS", "message": "…", "hint": "Go to the office and try again." },
                   { "code": "QR_EXPIRED", "layer": "QR", "message": "…", "hint": "Scan the code that is showing now." } ],
      "gps": { "distanceMeters": 500, "accuracyMeters": 12 } } } }
```

Every reason has a stable `code`, a plain-language `message`, and a `hint` saying what to do next.
The full catalogue is `VERIFICATION_REASONS` in `packages/shared/src/verification.ts`.

| Layer | Reason codes |
| --- | --- |
| GPS | `GPS_MISSING`, `GPS_INVALID`, `GPS_LOW_ACCURACY`, `GPS_STALE`, `GPS_FUTURE`, `GPS_MOCKED`, `GPS_OUTSIDE_RADIUS` |
| Network | `NETWORK_UNKNOWN`, `NETWORK_NOT_ALLOWED`, `NETWORK_NOT_CONFIGURED` |
| QR | `QR_MISSING`, `QR_INVALID`, `QR_EXPIRED`, `QR_REPLAYED` |
| Device | `DEVICE_MISSING`, `DEVICE_NOT_REGISTERED`, `DEVICE_PENDING`, `DEVICE_REVOKED`, `DEVICE_PLATFORM_MISMATCH`, `DEVICE_CHALLENGE_INVALID`, `DEVICE_CHALLENGE_EXPIRED`, `DEVICE_PROOF_MISSING`, `DEVICE_PROOF_INVALID`, `DEVICE_CLONE_SUSPECTED` |

## Layer 1: location

`verification/gps.ts`. Pure functions, no I/O.

- Distance is the great-circle (Haversine) distance from the office, computed **on the server**
  from the raw coordinates (Earth radius 6 371 008.8 m). The device never says "I am inside".
- A reading is rejected if it is missing or malformed, flagged as **mocked**, **stale** (older than
  `max_fix_age_seconds`, default 30), from a device clock more than 10 s in the **future**, or
  **imprecise** (reported accuracy worse than `max_gps_accuracy_m`, default 50).
- Only a trustworthy reading is judged against the radius (default 150 m). Telling someone "you
  are 450 m away" from a reading that is itself unreliable would mislead them, so they are first
  asked for a better one.
- All limits are inclusive: exactly at the limit passes.
- The raw coordinates are stored on the verification row and **blanked after 90 days** by the
  retention job. The verdict and the distance stay.

## Layer 2: office network

`verification/network.ts`. The address compared is `req.ip`, and nothing else.

- Express resolves `req.ip` according to `TRUST_PROXY`. With the default (`false`) it is the TCP
  peer address and **every forwarding header is ignored**: `X-Forwarded-For`, `X-Real-IP`,
  `Forwarded`, `CF-Connecting-IP`, `True-Client-IP`, … With a trusted proxy configured, only what
  that proxy appended is believed; anything a client adds to the left of it is discarded.
- `TRUST_PROXY` must be an exact hop count or a list of proxy addresses. `true`, `*` and `/0`
  ranges are refused at startup, because they would let any client claim to be on the office
  network.
- Matching is done by Postgres (`address <<= cidr`), for IPv4 and IPv6 alike, and the most specific
  matching range is recorded as the evidence. IPv4-mapped IPv6 addresses (`::ffff:203.0.113.5`) are
  treated as the IPv4 address.
- The settings response flags ranges that can never be the office's public address (private,
  loopback, link-local, carrier-grade NAT), and `POST /api/admin/office/test` lets an administrator
  try an address or a location before relying on it.
- Browsers cannot reveal which Wi-Fi network they are on, so the public address the server sees is
  the only honest proof available. A phone on mobile data will fail this layer (decision D8).
  Remote staff therefore cannot check in; that is intended.

## Layer 3: rotating QR code

`verification/qr.ts` (pure) and `verification/qr-service.ts` (persistence).

- Time is cut into windows of `qr_rotation_seconds` (default 30). The code for a window is
  `HMAC-SHA256(QR_SIGNING_SECRET, "TG1|office id|rotation|window")`, shown as
  `TG1.<window>.<43-character code>`. Nobody without the server's secret can compute it, and the
  server needs no stored copy of the plaintext: it recomputes on demand.
- A code is accepted from 5 s before its window starts (display clock drift) until 10 s after it
  ends (scanned just before the screen refreshed), so it is good for at most window + 15 s.
- The check compares the **exact text**, in constant time. (The last character of the code has
  spare bits; comparing decoded bytes would let one code answer to four spellings, and so defeat
  the single-use rule. There is a test for exactly this.)
- **Only the SHA-256 of a code is stored** (`qr_tokens`), and only once somebody scans it.
  Forged or malformed text creates no rows.
- **Single use is per employee** (decision D1), because a whole office scans one shared screen at
  10:00. A person cannot use the same code twice; a colleague can. The database enforces it with a
  unique index on `(token, employee)` for `ACCEPTED` scans.
- A scan is only **spent** when the entire verification succeeds. If the code was good but, say,
  the GPS fix was weak, the scan is recorded as `VALID` and the same code works on the next try
  within its window.
- Every scan is recorded in `qr_scan_events` with an outcome: `ACCEPTED`, `VALID`, `EXPIRED`,
  `UNKNOWN`, `REPLAYED`.
- Changing `qr_rotation_seconds` or `QR_SIGNING_SECRET` changes every code: whatever is on screen
  at that moment stops working, and the display picks up the new codes on its next refresh.

## Layer 4: registered device

`devices/`. "Device" means a **key that never leaves the device**, not a fingerprint of it.

### Enrolling

1. `POST /api/devices/register/options` returns a one-time 32-byte challenge, valid 5 minutes (and,
   for a browser, the WebAuthn creation options). It fails here, before the person is asked to
   unlock anything, if they have no free slot.
2. The device creates its key, and `POST /api/devices/register` sends:
   - the **password again**, checked by Supabase Auth with the sign-in lockout (a stolen access
     token is not enough to enrol a device, and the endpoint is not a guessing oracle);
   - the challenge id;
   - the proof the device holds the key (below).
3. The device is stored as **`PENDING`**. It does nothing until an administrator approves it
   (`POST /api/admin/devices/:id/approve`).

A person may hold up to `max_devices_per_employee` live devices (default 2, pending ones count).
A physical device or passkey can be live for only one person at a time, and a removed device can
be registered again. Device identifiers are stored as a SHA-256 digest, never raw.

### Proofs

| Platform | Key | Registration proof | Check-in proof |
| --- | --- | --- | --- |
| Android / iOS app | ECDSA P-256 key made on the device (SPKI public key) | ES256 (IEEE P1363) signature over `tg-register-v1 \n challenge \n employee \n platform \n identifier` | ES256 signature over `tg-verify-v1 \n challenge \n employee \n device \n purpose` |
| Browser | WebAuthn **platform** passkey (Windows Hello, Touch ID / Face ID, Android screen lock), user verification required | WebAuthn attestation (`none`) | WebAuthn assertion |

The message formats are built by shared functions (`registrationProofMessage`,
`verificationProofMessage`) so the app and the server cannot disagree on the bytes. Signing over
the challenge, the employee, the device and the purpose means a signature cannot be reused for a
different person, device, or for check-out instead of check-in.

### Challenges

Every proof is made over a server-issued challenge that is **single use**, **bound** to one person,
one purpose and one device, and valid for 120 s (5 min for enrolment). It is **spent the moment a
proof is attempted**, whether or not the proof was good, so signatures cannot be ground out against
one challenge. Only the newest challenge for a device is live.

### Revocation and copies

- Revoking a device (administrator, or the employee for their own) applies immediately: the next
  verification fails with `DEVICE_REVOKED`, and a verification that was already issued is refused
  at check-in (`DEVICE_NOT_ACTIVE`).
- A WebAuthn signature counter that fails to advance means the credential has been copied. The
  attempt is rejected as `DEVICE_CLONE_SUSPECTED` and an audit entry `device.clone_suspected` is
  written for administrators. (Many platform passkeys report a counter of 0 forever; those are
  not flagged.)
- Whether a registered passkey is **synced** between a person's devices is recorded on the
  `device.register` audit entry (`synced_across_devices`, `backed_up`), so an administrator can
  judge the device before approving it.

### Not yet in place

- **Play Integrity (Android) and App Attest (iOS)** — proof that the request comes from a genuine,
  unmodified build of the app on a genuine device — need Google Cloud / Apple Developer accounts
  and a real device build. The seam exists (`devices/attestation.ts`, an `AttestationVerifier`
  interface); until the mobile app (Phase 9) supplies real evidence, every native registration is
  recorded with `attestation_provider = 'NONE'` and administrators approve devices knowing that.
  Do not describe the native device layer as "attested" before then.

## Policy

`attendance_policies` holds the layers required for each channel and purpose:

| Setting | Default |
| --- | --- |
| `check_in_layers_web` | GPS, NETWORK, QR, DEVICE |
| `check_in_layers_mobile` | GPS, NETWORK, QR, DEVICE |
| `check_out_layers` | GPS, NETWORK |
| `admin_scan_layers` | GPS, NETWORK (**retired**: the scanner is no longer location-checked) |
| `daily_qr_layers` | GPS, NETWORK (what an employee must prove before generating an attendance QR) |
| `daily_qr_ttl_seconds` | 90 |
| `daily_qr_max_per_day` | 5 |
| `verification_ttl_seconds` | 120 |
| `max_devices_per_employee` | 2 |

**Retired:** `admin_scan_layers` was what a person operating the QR attendance scanner had to prove about **themselves** (purpose `ADMIN_SCAN`). An administrator or operator is no longer asked for a location or a network, and nothing reads this setting any more (see [ADMIN_QR_ATTENDANCE.md](ADMIN_QR_ATTENDANCE.md)).

`daily_qr_layers` is requested by `POST /api/attendance-qr/verify` (the employee about to generate a QR code); the verification is stored with the purpose of the action the code is for (CHECK_IN / CHECK_OUT) and is spent when the code is generated.

GPS and NETWORK cannot be removed from check-in, check-out, or the QR check (database constraints). The `channel` in a
request is declared by the client and is not authenticated, so anyone who can use both the app and
a browser can pick whichever channel's policy is lighter: **the weaker of the two policies is the
one that effectively binds everybody.** The defaults are identical for that reason; loosen one
only if you accept loosening both. A device of the wrong kind for the declared channel fails with
`DEVICE_PLATFORM_MISMATCH`.

## What is kept, and for how long

| Data | Kept | Notes |
| --- | --- | --- |
| `attendance_verifications` | indefinitely | Evidence of every attempt, pass or fail. Immutable apart from the one-time consumption stamp. |
| Raw coordinates in a verification | 90 days | Blanked by `private.apply_retention`; verdict and distance remain. |
| `qr_scan_events` | 90 days | |
| `qr_tokens` | 7 days after expiry | Hash only. |
| `device_challenges` | 1 day after expiry | |

Location is read **only at the moment of check-in or check-out**. There is no background tracking.

## Setting it up

1. **Office** — an administrator sets the name, coordinates, radius and thresholds
   (`PUT /api/admin/office/settings`). The response includes a `readiness` list of anything still
   missing.
2. **Networks** — add the office's public IP range(s). Use the public address the API sees, not
   the office's internal range. The test tool (`POST /api/admin/office/test`) shows what a given
   address and location would produce.
3. **Lobby display** — create an account with the `office_display` role
   (`POST /api/admin/employees` with `"role": "office_display"`) and call
   `GET /api/office/qr/current` from the screen (the web client for this arrives in Phase 7).
   Treat this account like a key: anyone holding its credentials can read the live code (and the
   next one) from anywhere, so use a dedicated device, a strong password, and deactivate the
   account if the screen is lost.
4. **Secrets and settings** — set `QR_SIGNING_SECRET` (at least 32 random characters; server only),
   `TRUST_PROXY` to match the real number of proxies, and `WEBAUTHN_RP_ID` / `CORS_ORIGINS` to the
   web app's domain and origin. Changing `WEBAUTHN_RP_ID` later orphans every registered browser.
5. **Devices** — employees enrol; administrators approve from the queue.

## Testing, and what was not tested

Covered by automated tests (`apps/api/src/verification`, `…/devices`, `…/routes/*.integration.test.ts`):
Haversine against known distances and the antimeridian; every GPS rejection and its exact
boundary; QR derivation, windows, grace, forgery, replay, per-person single use and storage;
CIDR matching (IPv4 and IPv6), spoofed forwarding headers with and without a trusted proxy;
device enrolment, approval, revocation, caps, duplicates; every challenge failure mode; native and
passkey proofs including wrong key, wrong origin, wrong challenge, copied credential; all 16
combinations of layers passing and failing; and the hand-off to `private.check_in` /
`check_out`.

Not tested, and the reasons:

- **Against a real Supabase stack** — Docker could not start on the development machine. The tests
  run on embedded Postgres 17 with an in-repo fake of Supabase Auth.
- **Real authenticators and browsers.** The passkey tests use a software authenticator that builds
  genuine WebAuthn bytes and runs them through the real `@simplewebauthn/server`; real hardware and
  real browser quirks arrive with the web app (Phase 7).
- **Real phone key stores** (Android Keystore, iOS Secure Enclave) — Phase 9.
- **True concurrency.** One verification at a time per person is enforced with a transaction-level
  advisory lock and a unique index, but the embedded test database has a single connection, so
  simultaneous requests were reasoned about, not raced.
- Rate limits are counted per API instance.
