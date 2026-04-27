-- ============================================================
-- 海河洪涝决策仿真平台 — Cloudflare D1 建表脚本
-- 执行: wrangler d1 execute haihe-flood-db --file=schema.sql
-- ============================================================

-- 表1: 每轮仿真快照（每局游戏每轮1条）
CREATE TABLE IF NOT EXISTS simulation_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    rainfall_A REAL DEFAULT 0,
    rainfall_B REAL DEFAULT 0,
    rainfall_C REAL DEFAULT 0,
    water_A1 REAL DEFAULT 0,
    water_A2 REAL DEFAULT 0,
    water_A3 REAL DEFAULT 0,
    water_B1 REAL DEFAULT 0,
    water_B2 REAL DEFAULT 0,
    water_B3 REAL DEFAULT 0,
    water_C1 REAL DEFAULT 0,
    water_C2 REAL DEFAULT 0,
    water_C3 REAL DEFAULT 0,
    asset_A1 REAL DEFAULT 0,
    asset_A2 REAL DEFAULT 0,
    asset_A3 REAL DEFAULT 0,
    asset_B1 REAL DEFAULT 0,
    asset_B2 REAL DEFAULT 0,
    asset_B3 REAL DEFAULT 0,
    asset_C1 REAL DEFAULT 0,
    asset_C2 REAL DEFAULT 0,
    asset_C3 REAL DEFAULT 0,
    city_asset_A REAL DEFAULT 0,
    city_asset_B REAL DEFAULT 0,
    city_asset_C REAL DEFAULT 0,
    round_loss REAL DEFAULT 0,
    total_loss REAL DEFAULT 0,
    ts TEXT DEFAULT (datetime('now'))
);

-- 表2: 玩家决策记录（每次操作1条）
CREATE TABLE IF NOT EXISTS player_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT,
    role TEXT,
    village TEXT,
    action_type TEXT NOT NULL,
    action_value TEXT,
    ts TEXT DEFAULT (datetime('now'))
);

-- 表3: 聊天/研讨记录
CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER,
    player_id TEXT,
    player_name TEXT,
    role TEXT,
    channel TEXT DEFAULT 'ALL',
    village TEXT,
    content TEXT,
    msg_type TEXT DEFAULT 'player',
    ts TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_rounds_room ON simulation_rounds(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_decisions_room ON player_decisions(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_chats_room ON chat_logs(room_id, round_num);
