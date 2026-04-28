# 海河洪涝决策仿真平台 — Cloudflare D1 数据库部署方案

## 一、数据库指标清单

### 表1: simulation_rounds（每轮仿真快照）

| 字段名 | 类型 | 含义 |
|--------|------|------|
| id | INTEGER | 自增主键 |
| room_id | TEXT | 房间编码（如 38PABD） |
| round_num | INTEGER | 轮次（1~6） |
| rainfall_A | REAL | 北京降雨量(mm) |
| rainfall_B | REAL | 河北降雨量(mm) |
| rainfall_C | REAL | 天津降雨量(mm) |
| water_A1 | REAL | 北京·房山(蓄洪) 水位 |
| water_A2 | REAL | 北京·门头沟 水位 |
| water_A3 | REAL | 北京·昌平 水位 |
| water_B1 | REAL | 河北·涿州(兰沟洼) 水位 |
| water_B2 | REAL | 河北·霸州 水位 |
| water_B3 | REAL | 河北·保定 水位 |
| water_C1 | REAL | 天津·静海(东淀) 水位 |
| water_C2 | REAL | 天津·武清 水位 |
| water_C3 | REAL | 天津·滨海新区(入海) 水位 |
| asset_A1 ~ asset_C3 | REAL×9 | 9个村庄的村资产余额 |
| city_asset_A | REAL | 北京市资产 |
| city_asset_B | REAL | 河北市资产 |
| city_asset_C | REAL | 天津市资产 |
| round_loss | REAL | 本轮损失 |
| total_loss | REAL | 累计损失 |
| ts | TEXT | 记录时间戳 |

### 表2: player_decisions（玩家决策记录）

| 字段名 | 类型 | 含义 |
|--------|------|------|
| id | INTEGER | 自增主键 |
| room_id | TEXT | 房间编码 |
| round_num | INTEGER | 轮次 |
| player_id | TEXT | 玩家ID |
| player_name | TEXT | 玩家姓名 |
| role | TEXT | 角色（MAYOR_A/LEADER_B1/VIL_C2_h3等） |
| village | TEXT | 所属村庄(A1~C3) |
| action_type | TEXT | 决策类型（见下表） |
| action_value | TEXT | 决策参数(JSON) |
| ts | TEXT | 记录时间戳 |

**action_type 枚举值：**

| action_type | 含义 | action_value 示例 |
|-------------|------|-------------------|
| evacuate | 村民选择搬迁 | {"village":"B1"} |
| stay | 村民选择留守 | {"village":"B1"} |
| sandbag | 村长购置沙袋 | {"village":"B1","amount":30} |
| drain | 市长排洪 | {"city":"A","value":60} |
| build_dam | 市长修坝 | {"city":"A"} |
| blast_dam | 市长炸坝 | {"city":"A"} |
| army_card | 动用解放军救援牌 | {"city":"B"} |
| village_dam | 村级修坝 | {"village":"A2"} |
| activate_dike | 启用蓄滞洪区 | {"village":"A1"} |
| evac_order | 蓄洪区村长下达撤离令 | {"village":"B1"} |

### 表3: chat_logs（聊天/研讨记录）

| 字段名 | 类型 | 含义 |
|--------|------|------|
| id | INTEGER | 自增主键 |
| room_id | TEXT | 房间编码 |
| round_num | INTEGER | 轮次 |
| player_id | TEXT | 发言者ID |
| player_name | TEXT | 发言者姓名 |
| role | TEXT | 角色 |
| channel | TEXT | 频道(ALL=全体/VILLAGE=本村) |
| village | TEXT | 所属村庄 |
| content | TEXT | 发言内容 |
| msg_type | TEXT | 消息类型(player/system/ai) |
| ts | TEXT | 记录时间戳 |

---

## 二、Cloudflare D1 部署步骤

### 前置准备

```bash
# 安装 Wrangler CLI（Cloudflare 的部署工具）
npm install -g wrangler

# 登录 Cloudflare 账号
wrangler login
```

### 步骤1: 创建 D1 数据库

```bash
# 创建数据库
wrangler d1 create haihe-flood-db

# 输出示例（记下 database_id）:
# ✅ Successfully created DB 'haihe-flood-db'
# database_id = "xxxx-xxxx-xxxx-xxxx"
```

### 步骤2: 初始化表结构

创建文件 `schema.sql`：

```sql
-- 表1: 每轮仿真快照
CREATE TABLE IF NOT EXISTS simulation_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    rainfall_A REAL DEFAULT 0,
    rainfall_B REAL DEFAULT 0,
    rainfall_C REAL DEFAULT 0,
    water_A1 REAL DEFAULT 0, water_A2 REAL DEFAULT 0, water_A3 REAL DEFAULT 0,
    water_B1 REAL DEFAULT 0, water_B2 REAL DEFAULT 0, water_B3 REAL DEFAULT 0,
    water_C1 REAL DEFAULT 0, water_C2 REAL DEFAULT 0, water_C3 REAL DEFAULT 0,
    asset_A1 REAL DEFAULT 0, asset_A2 REAL DEFAULT 0, asset_A3 REAL DEFAULT 0,
    asset_B1 REAL DEFAULT 0, asset_B2 REAL DEFAULT 0, asset_B3 REAL DEFAULT 0,
    asset_C1 REAL DEFAULT 0, asset_C2 REAL DEFAULT 0, asset_C3 REAL DEFAULT 0,
    city_asset_A REAL DEFAULT 0,
    city_asset_B REAL DEFAULT 0,
    city_asset_C REAL DEFAULT 0,
    round_loss REAL DEFAULT 0,
    total_loss REAL DEFAULT 0,
    ts TEXT DEFAULT (datetime('now'))
);

-- 表2: 玩家决策记录
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

-- 索引: 加速按房间查询
CREATE INDEX IF NOT EXISTS idx_rounds_room ON simulation_rounds(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_decisions_room ON player_decisions(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_chats_room ON chat_logs(room_id, round_num);
```

执行建表：

```bash
wrangler d1 execute haihe-flood-db --file=schema.sql
```

### 步骤3: 创建 Cloudflare Worker（API中间层）

创建项目目录：

```bash
mkdir haihe-api && cd haihe-api
npm init -y
```

创建 `wrangler.toml`：

```toml
name = "haihe-api"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "haihe-flood-db"
database_id = "替换为步骤1输出的database_id"

[vars]
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD_HASH = "1fd88d9e4f161552063ffb7b1c163e2c265c47ce0ce8290c0328138af7d1faae"
```

创建 `src/worker.js`：

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 路由分发
      if (path === '/api/health') {
        return json({ ok: true, version: '1.0', db: 'cloudflare-d1' }, corsHeaders);
      }

      if (path === '/api/rooms' && request.method === 'GET') {
        return await handleGetRooms(env.DB, corsHeaders);
      }

      if (path === '/api/config' && request.method === 'GET') {
        return json(getDefaultConfig(), corsHeaders);
      }

      if (path === '/api/data/rounds' && request.method === 'GET') {
        const roomId = url.searchParams.get('room_id');
        return await handleGetRounds(env.DB, roomId, corsHeaders);
      }

      if (path === '/api/data/decisions' && request.method === 'GET') {
        const roomId = url.searchParams.get('room_id');
        return await handleGetDecisions(env.DB, roomId, corsHeaders);
      }

      if (path === '/api/data/chats' && request.method === 'GET') {
        const roomId = url.searchParams.get('room_id');
        return await handleGetChats(env.DB, roomId, corsHeaders);
      }

      // --- 写入端点 (前端游戏过程中调用) ---

      if (path === '/api/data/rounds' && request.method === 'POST') {
        const body = await request.json();
        return await handleInsertRound(env.DB, body, corsHeaders);
      }

      if (path === '/api/data/decisions' && request.method === 'POST') {
        const body = await request.json();
        return await handleInsertDecision(env.DB, body, corsHeaders);
      }

      if (path === '/api/data/chats' && request.method === 'POST') {
        const body = await request.json();
        return await handleInsertChat(env.DB, body, corsHeaders);
      }

      if (path.startsWith('/api/export/') && request.method === 'GET') {
        const roomCode = path.replace('/api/export/', '');
        return await handleExport(env.DB, roomCode, corsHeaders);
      }

      return json({ detail: 'Not Found' }, corsHeaders, 404);
    } catch (e) {
      return json({ detail: 'Server Error: ' + e.message }, corsHeaders, 500);
    }
  }
};

// ---- 工具函数 ----

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ---- 查询处理 ----

async function handleGetRounds(db, roomId, cors) {
  let result;
  if (roomId) {
    result = await db.prepare(
      'SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num'
    ).bind(roomId).all();
  } else {
    result = await db.prepare(
      'SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 200'
    ).all();
  }
  return json(result.results, cors);
}

async function handleGetDecisions(db, roomId, cors) {
  let result;
  if (roomId) {
    result = await db.prepare(
      'SELECT * FROM player_decisions WHERE room_id = ? ORDER BY round_num, ts'
    ).bind(roomId).all();
  } else {
    result = await db.prepare(
      'SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 500'
    ).all();
  }
  return json(result.results, cors);
}

async function handleGetChats(db, roomId, cors) {
  let result;
  if (roomId) {
    result = await db.prepare(
      'SELECT * FROM chat_logs WHERE room_id = ? ORDER BY ts'
    ).bind(roomId).all();
  } else {
    result = await db.prepare(
      'SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 500'
    ).all();
  }
  return json(result.results, cors);
}

async function handleGetRooms(db, cors) {
  // 从 simulation_rounds 聚合出房间列表
  const result = await db.prepare(`
    SELECT room_id, 
           MIN(ts) as created_at,
           MAX(round_num) as max_round,
           COUNT(DISTINCT round_num) as rounds_played
    FROM simulation_rounds 
    GROUP BY room_id 
    ORDER BY created_at DESC
  `).all();
  return json(result.results, cors);
}

// ---- 写入处理 ----

async function handleInsertRound(db, body, cors) {
  await db.prepare(`
    INSERT INTO simulation_rounds 
    (room_id, round_num, rainfall_A, rainfall_B, rainfall_C,
     water_A1, water_A2, water_A3, water_B1, water_B2, water_B3,
     water_C1, water_C2, water_C3,
     asset_A1, asset_A2, asset_A3, asset_B1, asset_B2, asset_B3,
     asset_C1, asset_C2, asset_C3,
     city_asset_A, city_asset_B, city_asset_C,
     round_loss, total_loss)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    body.room_id, body.round_num,
    body.rainfall_A || 0, body.rainfall_B || 0, body.rainfall_C || 0,
    body.water_A1 || 0, body.water_A2 || 0, body.water_A3 || 0,
    body.water_B1 || 0, body.water_B2 || 0, body.water_B3 || 0,
    body.water_C1 || 0, body.water_C2 || 0, body.water_C3 || 0,
    body.asset_A1 || 0, body.asset_A2 || 0, body.asset_A3 || 0,
    body.asset_B1 || 0, body.asset_B2 || 0, body.asset_B3 || 0,
    body.asset_C1 || 0, body.asset_C2 || 0, body.asset_C3 || 0,
    body.city_asset_A || 0, body.city_asset_B || 0, body.city_asset_C || 0,
    body.round_loss || 0, body.total_loss || 0
  ).run();
  return json({ ok: true }, cors);
}

async function handleInsertDecision(db, body, cors) {
  await db.prepare(`
    INSERT INTO player_decisions 
    (room_id, round_num, player_id, player_name, role, village, action_type, action_value)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    body.room_id, body.round_num, body.player_id, body.player_name,
    body.role, body.village, body.action_type,
    typeof body.action_value === 'string' ? body.action_value : JSON.stringify(body.action_value)
  ).run();
  return json({ ok: true }, cors);
}

async function handleInsertChat(db, body, cors) {
  await db.prepare(`
    INSERT INTO chat_logs 
    (room_id, round_num, player_id, player_name, role, channel, village, content, msg_type)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    body.room_id, body.round_num, body.player_id, body.player_name,
    body.role, body.channel || 'ALL', body.village, body.content,
    body.msg_type || 'player'
  ).run();
  return json({ ok: true }, cors);
}

async function handleExport(db, roomCode, cors) {
  const rounds = await db.prepare(
    'SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num'
  ).bind(roomCode).all();
  const decisions = await db.prepare(
    'SELECT * FROM player_decisions WHERE room_id = ? ORDER BY round_num, ts'
  ).bind(roomCode).all();
  const chats = await db.prepare(
    'SELECT * FROM chat_logs WHERE room_id = ? ORDER BY ts'
  ).bind(roomCode).all();
  return json({
    rounds: rounds.results,
    decisions: decisions.results,
    chats: chats.results
  }, cors);
}

function getDefaultConfig() {
  // 与 config.json 保持一致，此处返回默认配置
  return { ok: true, source: 'default' };
}
```

### 步骤4: 部署 Worker

```bash
cd haihe-api
wrangler deploy

# 输出示例:
# ✅ Published haihe-api
# https://haihe-api.你的账号.workers.dev
```

记下输出的 Worker URL。

### 步骤5: 配置前端连接 Worker

在管理后台 admin.html 的"服务器地址"输入框中填入：

```
https://haihe-api.你的账号.workers.dev
```

或者，在 Nginx 中添加一条反向代理规则，将 `/api/` 转发到 Worker：

```nginx
# 在 nginx_haihe.conf 的 server{} 块内添加:
location /api/ {
    proxy_pass https://haihe-api.你的账号.workers.dev;
    proxy_ssl_server_name on;
    proxy_set_header Host haihe-api.你的账号.workers.dev;
}
```

### 步骤6: 修改前端游戏，写入数据到 D1

在 index.html 的每轮结算函数中，添加远程数据上报（与本地 Socket.IO 并行）。
在 endRound 函数中找到 `mpEmit('save_round_data', ...)` 附近，加入：

```js
// 上报到 Cloudflare D1
const DB_API = 'https://haihe-api.你的账号.workers.dev';
fetch(DB_API + '/api/data/rounds', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    room_id: G.roomCode || 'LOCAL_' + Date.now(),
    round_num: G.round,
    rainfall_A: G.rain.A, rainfall_B: G.rain.B, rainfall_C: G.rain.C,
    water_A1: G.ws.A1, water_A2: G.ws.A2, water_A3: G.ws.A3,
    water_B1: G.ws.B1, water_B2: G.ws.B2, water_B3: G.ws.B3,
    water_C1: G.ws.C1, water_C2: G.ws.C2, water_C3: G.ws.C3,
    asset_A1: G.va.A1, asset_A2: G.va.A2, asset_A3: G.va.A3,
    asset_B1: G.va.B1, asset_B2: G.va.B2, asset_B3: G.va.B3,
    asset_C1: G.va.C1, asset_C2: G.va.C2, asset_C3: G.va.C3,
    city_asset_A: G.ca.A, city_asset_B: G.ca.B, city_asset_C: G.ca.C,
    round_loss: roundLoss, total_loss: G.totalLoss
  })
}).catch(e => console.warn('D1上报失败:', e));
```

---

## 三、架构总览

```
用户浏览器
    │
    ├── index.html (游戏页面, Nginx 直接提供)
    ├── admin.html  (管理后台, Nginx 直接提供)
    │
    ├── /api/*  ──→  Cloudflare Worker ──→ Cloudflare D1 (数据库)
    │                  (数据读写API)         (3张表)
    │
    └── /socket.io/* ──→ Python uvicorn:8080 (实时通信)
                          (房间管理/多人联机)
```

**分工：**
- **Cloudflare D1**：持久化存储所有教学数据（轮次快照、决策记录、聊天记录）
- **Cloudflare Worker**：提供 RESTful API，管理后台直接调用，不经过 Nginx
- **Python server.py**：仅负责 Socket.IO 实时通信（多人联机、房间管理）
- **Nginx**：提供静态文件 + 转发 WebSocket

---

## 四、验证清单

部署完成后，逐项验证：

```bash
# 1. D1 数据库是否创建成功
wrangler d1 list

# 2. 表结构是否正确
wrangler d1 execute haihe-flood-db --command="SELECT name FROM sqlite_master WHERE type='table'"

# 3. Worker API 是否可用
curl https://haihe-api.你的账号.workers.dev/api/health
# 期望: {"ok":true,"version":"1.0","db":"cloudflare-d1"}

# 4. 写入测试
curl -X POST https://haihe-api.你的账号.workers.dev/api/data/rounds \
  -H "Content-Type: application/json" \
  -d '{"room_id":"TEST01","round_num":1,"rainfall_A":38,"rainfall_B":36,"rainfall_C":23}'

# 5. 读取测试
curl https://haihe-api.你的账号.workers.dev/api/data/rounds
# 期望: 返回包含刚写入记录的JSON数组

# 6. 管理后台测试
# 打开 http://www.resil-hub.cn/admin.html
# 在"服务器地址"中填入 Worker URL
# 应显示 "v1.0 已连接"
```
