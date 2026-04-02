# PharmIDE — Encryption & Security Compliance Reference

Last updated: March 2026

---

## What's Changing

The HIPAA Security Rule is being overhauled. The NPRM was published January 6, 2025. Final rule expected late 2026 or early 2027. The key shift: encryption moves from **"addressable"** (implement or document why not) to **"required"** (implement, period). No more opt-out with a risk assessment justification.

---

## Required Standards

### Data at Rest — AES-256
- All ePHI stored on any system must be encrypted with AES-256
- Covers: databases, local files, backups, USB drives, mobile devices
- **PharmIDE status: READY** — SQLCipher provides AES-256 page-level encryption on SQLite. Swap `rusqlite` to `bundled-sqlcipher` feature, add `PRAGMA key` on connection open. All queries unchanged.

### Data in Transit — TLS 1.3
- All ePHI transmitted between systems must use TLS 1.3 or higher
- Covers: e-order ingestion, MCP server endpoints, cloud sync, multi-terminal communication, any HTTP/WebSocket traffic carrying PHI
- **PharmIDE status: NOT YET NEEDED** — currently a local desktop app with no network ePHI transmission. Required the moment any network feature goes live (e-order transport, MCP server, remote access). Configuration per endpoint, not an architecture change.

### Key Exchange — RSA-2048 (minimum)
- Encryption key exchanges must use RSA-2048 or stronger
- Relevant when: TLS certificate setup, any system-to-system encrypted handshake
- **PharmIDE status: DEFERRED** — applies when network layer exists. Standard TLS cert configuration.

### Key Management — HSM Recommended
- Encryption keys should be managed through secure systems (Hardware Security Modules)
- Production pharmacy: YubiKey or similar hardware token for DB key derivation
- Pharmacist-in-charge plugs in token at start of day → key derives → DB unlocks
- **PharmIDE status: PLANNED** — `db_config.rs` centralization supports future key injection. Hardware token integration is a deployment-phase task.

---

## Other Security Requirements Coming

### Multi-Factor Authentication (MFA) — Required Everywhere
- MFA must be enforced on every system that accesses ePHI
- No exceptions for internal systems or "low-risk" users
- **PharmIDE status: READY** — `ACTIVE_SESSION` with role-gated access already exists. Add TOTP or hardware token as second factor at login. Session architecture unchanged.

### Audit Logging — Required, Must Be Tamper-Evident
- Every access, modification, and disclosure of ePHI must be logged
- Logs must be tamper-evident and retained per policy
- **PharmIDE status: EXCEEDS** — Merkle-chained event log with cryptographic hash verification. Each event references previous hash. Tamper detection is built into the data structure, not bolted on.

### Asset Inventory — Required
- Complete inventory of all systems, software, and devices with access to ePHI
- Must be documented and maintained
- **PharmIDE status: N/A for software** — this is an operational/deployment requirement, not a code requirement. Relevant when PharmIDE is deployed in a pharmacy.

### Risk Analysis — Annual, Documented
- Formal risk assessment must be conducted annually
- Must include documented remediation plans
- **PharmIDE status: N/A for software** — operational requirement for the pharmacy running the software.

### Penetration Testing — Required
- Routine penetration testing to identify vulnerabilities
- **PharmIDE status: FUTURE** — relevant before production deployment.

### Incident Reporting — 24 Hours
- Business associates must report security incidents within 24 hours of discovery
- Covered entities must notify HHS
- **PharmIDE status: N/A for software** — policy/procedure requirement for the organization.

### System Restoration — 72 Hours
- Must demonstrate ability to restore critical systems within 72 hours of an incident
- **PharmIDE status: SUPPORTS** — single encrypted DB file = single file to back up and restore. Backup strategy is operational, but architecture makes it trivial.

---

## PharmIDE Implementation Checklist

### Phase 1: Encryption-Ready (DO NOW)
- [ ] Merge patient DB into single `pharmide.db`
- [ ] Create `db_config.rs` — centralize all `Connection::open()` calls
- [ ] Each connection helper takes optional key parameter (ignored for now)
- [ ] Swap Cargo.toml to `rusqlite` with `bundled-sqlcipher` feature
- [ ] Verify app runs normally (SQLCipher is superset, works without key)
- [ ] Confirm `drug_tree.db` stays separate (reference data, no PHI, no encryption needed)

### Phase 2: Encryption Active (BEFORE PRODUCTION)
- [ ] Add `PRAGMA key = '<key>'` to `db_config.rs` connection helpers
- [ ] Implement key derivation (hardware token, environment variable, or secure prompt)
- [ ] Add `PRAGMA cipher_compatibility = 4` for SQLCipher 4.x
- [ ] Test: DB file is unreadable without key (open in hex editor, confirm gibberish)
- [ ] Test: App functions identically with encryption enabled
- [ ] Migrate existing unencrypted DB to encrypted (SQLCipher provides `sqlcipher_export`)

### Phase 3: MFA (BEFORE PRODUCTION)
- [ ] Add second factor to login flow (TOTP app or hardware key)
- [ ] Enforce MFA for all roles (tech, pharmacist, admin)
- [ ] Log MFA events in audit trail

### Phase 4: Network Security (WHEN NETWORK FEATURES EXIST)
- [ ] TLS 1.3 on e-order ingestion endpoint
- [ ] TLS 1.3 on MCP server
- [ ] TLS 1.3 on any future HTTP/WebSocket endpoints
- [ ] RSA-2048+ for certificate key exchange
- [ ] Certificate management plan (renewal, revocation)

---

## Timeline

| Regulation | Status | Expected Enforcement |
|---|---|---|
| HIPAA Security Rule overhaul (encryption, MFA, logging) | NPRM published Jan 2025, comment period closed | Late 2026 or early 2027 |
| Part 2 / HIPAA alignment (substance abuse records) | Final rule published Feb 2024 | Full compliance by Feb 16, 2026 |
| HIPAA Privacy Rule update | Tribal consultation Feb 2026, final rule pending | TBD — depends on current administration |
| OCR HIPAA compliance audits (Phase 3) | Underway as of March 2025 | Ongoing, 50 entities initially |
| NCPDP Retail Pharmacy Standards update | Final rule Dec 2024 | Effective 2025-2026 |

---

## Sources

- HHS NPRM: HIPAA Security Rule update (Federal Register, Jan 6, 2025)
- HIPAA Journal: hipaajournal.com/hipaa-updates-hipaa-changes/
- Censinet: censinet.com/perspectives/hipaa-encryption-protocols-2025-updates
- HIPAA Vault: hipaavault.com/resources/2026-hipaa-changes/
- 45 CFR §164.312 (Technical Safeguards)
- NIST Cybersecurity Framework

---

## The Bottom Line

PharmIDE was built with security as architecture, not afterthought. Merkle audit chain, role-gated sessions, centralized DB design — these aren't compliance features, they're how the system works. Flipping on encryption is a configuration change, not a rewrite. When the final rule drops, the checklist is short.
