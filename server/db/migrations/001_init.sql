-- 用户：balance 是余额的「当前值」，point_ledger 是它的「全部历史」。
-- 两者总在同一事务内更新；CHECK 保证无论代码怎么写，余额都不可能为负。
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话：只存 token 的 sha256，数据库泄露也拿不到可用的 cookie
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  reward      INTEGER NOT NULL CHECK (reward > 0),
  -- once：每人终身一次；daily：每人每个 UTC 日一次
  kind        TEXT NOT NULL CHECK (kind IN ('once', 'daily')),
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- 「领过没有」由唯一约束判定：period 对 once 任务固定为 'once'，对 daily 任务是 UTC 日期。
-- 并发点击时第二个 INSERT 会撞约束，不需要先查再写。
CREATE TABLE task_completions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  period     TEXT NOT NULL,
  reward     INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, task_id, period)
);

CREATE TABLE products (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL,
  price               INTEGER NOT NULL CHECK (price > 0),
  -- external：调外部 API 发码；internal：站内权益，扣分即发放
  fulfillment         TEXT NOT NULL CHECK (fulfillment IN ('external', 'internal')),
  external_product_id TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  CHECK ((fulfillment = 'external') = (external_product_id IS NOT NULL))
);

-- 订单 id 同时作为外部 API 的 requestId，所以重试天然幂等。
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  product_id      TEXT NOT NULL REFERENCES products(id),
  price           INTEGER NOT NULL CHECK (price > 0),       -- 下单时的价格快照
  idempotency_key TEXT NOT NULL,                            -- 前端生成，防双击/重发
  status          TEXT NOT NULL CHECK (status IN ('processing', 'delivered', 'failed')),
  code            TEXT,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ,                              -- 后台补发的下次时间
  lease_until     TIMESTAMPTZ,                              -- 谁正在处理它（避免同时两个人调外部 API）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_due_idx ON orders(next_attempt_at) WHERE status = 'processing';

-- 积分流水：只追加，不修改。
CREATE TABLE point_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  delta         INTEGER NOT NULL CHECK (delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('signup_bonus', 'seed_grant', 'task_reward', 'redeem', 'refund')),
  task_completion_id BIGINT REFERENCES task_completions(id),
  order_id      TEXT REFERENCES orders(id),
  description   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'task_reward' OR task_completion_id IS NOT NULL),
  CHECK (kind NOT IN ('redeem', 'refund') OR order_id IS NOT NULL),
  CHECK (kind <> 'redeem' OR delta < 0),
  CHECK (kind = 'redeem' OR delta > 0)
);
CREATE INDEX point_ledger_user_idx ON point_ledger(user_id, id DESC);
-- 数据库层面的最后一道保险：每个订单最多扣一次、最多退一次
CREATE UNIQUE INDEX point_ledger_one_redeem_per_order ON point_ledger(order_id) WHERE kind = 'redeem';
CREATE UNIQUE INDEX point_ledger_one_refund_per_order ON point_ledger(order_id) WHERE kind = 'refund';
CREATE UNIQUE INDEX point_ledger_one_reward_per_completion ON point_ledger(task_completion_id) WHERE kind = 'task_reward';
