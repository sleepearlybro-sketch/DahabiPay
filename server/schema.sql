-- ===========================================================================
-- Dahabi Pay schema
-- SQLite is the source schema. server/db.js translates PRAGMAs, integer IDs
-- and AUTOINCREMENT declarations when DATABASE_URL selects PostgreSQL.
-- Money is stored as TEXT decimal strings, never floats - see lib/money.js.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT    NOT NULL UNIQUE,
  email          TEXT    NOT NULL UNIQUE,
  pass_hash      TEXT    NOT NULL,
  pin_hash       TEXT,
  role           TEXT    NOT NULL DEFAULT 'user',      -- user | operator | admin
  email_verified INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  block_reason   TEXT,
  kyc_status     TEXT    NOT NULL DEFAULT 'none',      -- none | pending | approved | rejected
  discount_bp    INTEGER NOT NULL DEFAULT 0,           -- fee discount, basis points
  referrer_id    INTEGER REFERENCES users(id),
  ref_code       TEXT    UNIQUE,
  lang           TEXT    NOT NULL DEFAULT 'en',
  notify_status  INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  last_seen_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
CREATE INDEX IF NOT EXISTS ix_users_ref   ON users(referrer_id);

-- ------------------------------------------------------------------ sessions
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  ua         TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- one-shot tokens for email verification and password reset
CREATE TABLE IF NOT EXISTS email_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                            -- verify | reset
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- currencies
CREATE TABLE IF NOT EXISTS currencies (
  id           TEXT PRIMARY KEY,                       -- 'usdt_trc20'
  name         TEXT NOT NULL,
  net          TEXT NOT NULL DEFAULT '',
  code         TEXT NOT NULL,
  grp          TEXT NOT NULL,                          -- crypto | account | mobile
  color        TEXT NOT NULL DEFAULT '#025081',
  pivot_usd    TEXT NOT NULL,                          -- decimal string
  pivot_source TEXT NOT NULL DEFAULT 'manual',         -- manual | feed
  feed_symbol  TEXT,                                   -- key in the rate feed
  reserve      TEXT NOT NULL DEFAULT '0',
  -- liquidity already committed to open orders. Available = reserve - reserved.
  -- Incremented inside the order-creation transaction so two concurrent orders
  -- cannot both pass the same reserve check (see lib/orders.js).
  reserved     TEXT NOT NULL DEFAULT '0',
  deposit_addr TEXT,                                   -- static address, manual provider
  deposit_memo TEXT,
  min_amt      TEXT NOT NULL DEFAULT '0',
  max_amt      TEXT NOT NULL DEFAULT '0',
  fee_bp       INTEGER NOT NULL DEFAULT 100,           -- basis points, 100 = 1%
  field_label  TEXT NOT NULL DEFAULT 'Account number',
  field_regex  TEXT,                                   -- optional requisite check
  enabled      INTEGER NOT NULL DEFAULT 1,
  manual       INTEGER NOT NULL DEFAULT 0,             -- operator handles payout
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

-- group-level allow list, plus per-pair overrides
CREATE TABLE IF NOT EXISTS direction_rules (
  from_grp TEXT NOT NULL,
  to_grp   TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (from_grp, to_grp)
);

CREATE TABLE IF NOT EXISTS pair_overrides (
  from_id  TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  enabled  INTEGER,                                    -- NULL = inherit group rule
  fee_bp   INTEGER,                                    -- NULL = inherit send currency
  PRIMARY KEY (from_id, to_id)
);

-- pivot cache from the live feed, with the timestamp we judge staleness on
CREATE TABLE IF NOT EXISTS rate_cache (
  symbol     TEXT PRIMARY KEY,
  usd        TEXT NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- -------------------------------------------------------------------- orders
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,                    -- 'EP-A1B2C-12345'
  user_id         INTEGER REFERENCES users(id),        -- NULL for guest orders
  from_id         TEXT NOT NULL REFERENCES currencies(id),
  to_id           TEXT NOT NULL REFERENCES currencies(id),
  send_amount     TEXT NOT NULL,
  recv_amount     TEXT NOT NULL,
  rate            TEXT NOT NULL,                       -- locked at creation
  fee_bp          INTEGER NOT NULL,
  status          TEXT NOT NULL,                       -- see lib/orders.js STATES
  requisite       TEXT NOT NULL,
  holder          TEXT,
  email           TEXT NOT NULL,
  note            TEXT,
  deposit_address TEXT,
  deposit_memo    TEXT,
  tx_hash         TEXT,
  paid_amount     TEXT,                                -- what actually arrived
  payout_ref      TEXT,
  provider        TEXT,
  operator_id     INTEGER REFERENCES users(id),
  hold_reason     TEXT,
  cancel_reason   TEXT,
  ip              TEXT,
  lock_expires_at TEXT NOT NULL,
  -- set when the customer accepts a recalculation after the lock expired
  rate_reaccepted_at TEXT,
  -- guest orders are read back with this instead of a session
  access_token    TEXT,
  reserve_held    INTEGER NOT NULL DEFAULT 0,          -- is `reserved` still counting this order?
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  paid_at         TEXT,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS ix_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created_at);

-- every status change, append-only
CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status  TEXT NOT NULL,
  actor      TEXT NOT NULL,                            -- system | operator:<login> | customer
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_events_order ON order_events(order_id);

-- ------------------------------------------------------------------ balances
CREATE TABLE IF NOT EXISTS balances (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  amount      TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (user_id, currency_id)
);

-- double-entry-ish ledger so a balance can always be reconstructed
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id),
  delta       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  order_id    TEXT REFERENCES orders(id),
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON ledger(user_id, currency_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id),
  amount      TEXT NOT NULL,
  requisite   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'balance',         -- balance | affiliate
  status      TEXT NOT NULL DEFAULT 'pending',         -- pending | paid | rejected
  operator_id INTEGER REFERENCES users(id),
  reason      TEXT,
  created_at  TEXT NOT NULL,
  settled_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_withdrawals_status ON withdrawals(status);

-- ----------------------------------------------------------------- affiliate
CREATE TABLE IF NOT EXISTS affiliate_rewards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  volume_usd  TEXT NOT NULL,
  share_bp    INTEGER NOT NULL,
  reward_usd  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aff_user ON affiliate_rewards(user_id);

-- ----------------------------------------------------------------------- kyc
CREATE TABLE IF NOT EXISTS kyc_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                           -- id_front | id_back | selfie | address | sof
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_kyc_user ON kyc_docs(user_id);

-- --------------------------------------------------------------- editorial
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  who        TEXT NOT NULL,
  body       TEXT NOT NULL,
  order_id   TEXT REFERENCES orders(id),
  rating     INTEGER NOT NULL DEFAULT 5,
  approved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  excerpt      TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  published    INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL
);

-- ------------------------------------------------------------------- system
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id),
  actor_login TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(created_at);

-- Payout idempotency. The key is order_id + ':payout'; inserting it is part of
-- the same transaction that writes 'completed', so a webhook replay or a
-- double-clicked operator button hits the primary key and pays nothing twice.
CREATE TABLE IF NOT EXISTS payout_locks (
  key        TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider   TEXT,
  ref        TEXT,
  created_at TEXT NOT NULL
);

-- Every webhook we accept, so a replayed callback is recognised and dropped.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  order_id     TEXT,
  event        TEXT,
  payload      TEXT,
  accepted     INTEGER NOT NULL DEFAULT 1,
  reason       TEXT,
  received_at  TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
);

-- Captcha challenges. The answer stays server-side and each row is single
-- use, so a solved image cannot be replayed.
CREATE TABLE IF NOT EXISTS captchas (
  id         TEXT PRIMARY KEY,
  answer     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- simple fixed-window rate limiting, so a restart cannot be used to reset it
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  reset_at   TEXT NOT NULL
);
