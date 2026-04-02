## Encryption-Ready Prep (Small — Can Do Now)

- [ ] Create `db_config.rs` module — centralizes all DB file paths and connection setup
- [ ] Move all `Connection::open()` calls into `db_config.rs` helper functions
- [ ] Each helper takes an optional key parameter (ignored for now): `fn open_pharmide_db(key: Option<&str>) -> Connection`
- [ ] Add `PRAGMA key` call inside the helper, gated by `if let Some(k) = key`
- [ ] Swap `Cargo.toml`: `rusqlite = { features = ["bundled-sqlcipher"] }` instead of `["bundled"]` — SQLCipher is a superset, works without a key too, so nothing breaks
- [ ] Verify app still runs normally with SQLCipher feature (no key = no encryption = same behavior)

**Later (when shipping with real patient data):**
- [ ] Implement key source (hardware token / OS keychain / env var)
- [ ] Pass key to `db_config` helpers on startup
- [ ] Migration script: `sqlcipher_export` to encrypt existing unencrypted databases in place
- [ ] Test: confirm encrypted DB is unreadable without key
