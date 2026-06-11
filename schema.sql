-- ============================================================
-- 海河洪涝决策仿真平台 — Cloudflare D1 建表脚本
-- 执行: wrangler d1 execute haihe-flood-db --file=schema.sql
-- ============================================================

-- 表1: 每轮仿真快照（每局游戏每轮1条）
CREATE TABLE IF NOT EXISTS simulation_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    forecast_A REAL DEFAULT 0,
    forecast_B REAL DEFAULT 0,
    forecast_C REAL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_rounds_room_round_id ON simulation_rounds(room_id, round_num, id);
CREATE INDEX IF NOT EXISTS idx_decisions_room ON player_decisions(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_decisions_room_id ON player_decisions(room_id, id);
CREATE INDEX IF NOT EXISTS idx_chats_room ON chat_logs(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_chats_room_id ON chat_logs(room_id, id);

-- 表4: 房间同步大厅
CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    group_name TEXT DEFAULT '默认组',
    status TEXT DEFAULT 'WAITING',       -- WAITING | PLAYING | FINISHED
    players TEXT DEFAULT '[]',           -- JSON数组 [{name, student_id, role, village, pref, joined_at}]
    config TEXT DEFAULT '{}',
    rounds_played INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);

-- 表5: 房间内玩家角色分配。UNIQUE(room_id, role) 用于原子抢占官职角色，避免多人同时加入时重复分配。
CREATE TABLE IF NOT EXISTS room_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT,
    role TEXT NOT NULL,
    village TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, player_id),
    UNIQUE(room_id, role)
);
CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id, joined_at);

-- 表6: 房间级突发事件。用于统一同步暴雨、通讯中断、生态补偿等临时冲击。
CREATE TABLE IF NOT EXISTS room_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    event_type TEXT DEFAULT 'shock',
    title TEXT,
    content TEXT,
    payload TEXT DEFAULT '{}',
    source TEXT DEFAULT 'system',
    ts TEXT DEFAULT (datetime('now')),
    UNIQUE(room_id, round_num, event_key)
);
CREATE INDEX IF NOT EXISTS idx_events_room_id ON room_events(room_id, id);

-- 表7: 决策过程时间线。用于复盘响应时间、行动类型、信息状态与策略变化。
CREATE TABLE IF NOT EXISTS decision_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    player_id TEXT,
    player_name TEXT,
    role TEXT,
    village TEXT,
    phase TEXT,
    action_type TEXT NOT NULL,
    action_value TEXT,
    elapsed_ms INTEGER,
    info_state TEXT DEFAULT '{}',
    ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_room_id ON decision_timeline(room_id, id);

-- 表8: 信息暴露记录。用于分析不同角色在有限信息下看到过什么、信息可靠度如何。
CREATE TABLE IF NOT EXISTS information_exposure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    player_id TEXT,
    role TEXT,
    village TEXT,
    info_key TEXT NOT NULL,
    info_value TEXT,
    certainty REAL DEFAULT 1,
    source TEXT DEFAULT 'system',
    ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exposure_room_id ON information_exposure(room_id, id);
