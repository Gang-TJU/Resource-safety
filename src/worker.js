// worker.js — V3.3 多人同步与教学过程数据版
// 角色分配、玩家动作、聊天、房间事件和轮次水情快照全部走 HTTP/D1，前端无需 WebSocket。

const ROLE_SLOTS = [
  'MAYOR_A','MAYOR_B','MAYOR_C',
  'LEADER_A1','LEADER_A2','LEADER_A3',
  'LEADER_B1','LEADER_B2','LEADER_B3',
  'LEADER_C1','LEADER_C2','LEADER_C3'
];

function roleToVillage(role) {
  if (role.startsWith('LEADER_')) return role.replace('LEADER_', '');
  if (role.startsWith('MAYOR_'))  return role.replace('MAYOR_', '') + '1';
  if (role.startsWith('VIL_'))    return role.split('_')[1];
  return 'B1';
}

function rolePreferenceOrder(pref) {
  if (pref === 'MAYOR') return ['MAYOR_A', 'MAYOR_B', 'MAYOR_C'];
  if (pref === 'VLF') return ['LEADER_A1', 'LEADER_B1', 'LEADER_C1'];
  if (pref === 'VLN') return ['LEADER_A2', 'LEADER_A3', 'LEADER_B2', 'LEADER_B3', 'LEADER_C2', 'LEADER_C3'];
  return [];
}

function genVilRole(village) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `VIL_${village}_${Date.now()}_${rand}`;
}

// ── 自动建表 ─────────────────────────────────────────────────────────────────
// Worker 全局变量：每个 isolate 实例只初始化一次，避免每次请求都跑 CREATE TABLE
let _dbInitialized = false;

async function ensureTablesExist(env) {
  if (_dbInitialized) return;
  // CREATE TABLE IF NOT EXISTS 是幂等的，多个 Worker 实例并发执行也安全
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      group_name TEXT DEFAULT '默认组',
      status TEXT DEFAULT 'WAITING',
      players TEXT DEFAULT '[]',
      config TEXT DEFAULT '{}',
      rounds_played INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS room_players (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     TEXT NOT NULL,
      player_id   TEXT NOT NULL,
      player_name TEXT,
      role        TEXT NOT NULL,
      village     TEXT,
      joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, player_id),
      UNIQUE(room_id, role)
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare(`
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
    )
  `).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_decisions_room_id ON player_decisions(room_id, id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chats_room_id ON chat_logs(room_id, id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_rounds_room_round_id ON simulation_rounds(room_id, round_num, id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_room_id ON room_events(room_id, id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_timeline_room_id ON decision_timeline(room_id, id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_exposure_room_id ON information_exposure(room_id, id)").run();
  await ensureColumn(env, "rooms", "group_name", "TEXT DEFAULT '默认组'");
  await ensureColumn(env, "rooms", "status", "TEXT DEFAULT 'WAITING'");
  await ensureColumn(env, "rooms", "players", "TEXT DEFAULT '[]'");
  await ensureColumn(env, "rooms", "config", "TEXT DEFAULT '{}'");
  await ensureColumn(env, "rooms", "rounds_played", "INTEGER DEFAULT 0");
  await ensureColumn(env, "rooms", "started_at", "TEXT");
  await ensureColumn(env, "rooms", "finished_at", "TEXT");
  await ensureColumn(env, "simulation_rounds", "forecast_A", "REAL DEFAULT 0");
  await ensureColumn(env, "simulation_rounds", "forecast_B", "REAL DEFAULT 0");
  await ensureColumn(env, "simulation_rounds", "forecast_C", "REAL DEFAULT 0");
  _dbInitialized = true;
}

async function ensureColumn(env, table, column, definition) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const exists = (info.results || []).some(row => row.name === column);
  if (!exists) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 每次请求先确保表存在（第二次之后走缓存标志，几乎无开销）
    await ensureTablesExist(env);

    try {
      // ── 健康检查 ──────────────────────────────────────────────
      if (path === "/api/health")
        return Response.json({ ok: true, version: "3.3", db: "D1" }, { headers: corsHeaders });

      if (path === "/api/config")
        return Response.json({}, { headers: corsHeaders });

      // ── 房间列表 ──────────────────────────────────────────────
      if (path === "/api/rooms" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM rooms ORDER BY created_at DESC LIMIT 50"
        ).all();
        return Response.json(results || [], { headers: corsHeaders });
      }

      // ── 创建房间 ──────────────────────────────────────────────
      if (path === "/api/rooms" && method === "POST") {
        const body = await request.json();
        const code = 'R' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        await env.DB.prepare(
          "INSERT INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')"
        ).bind(code, body.group_name || '默认组').run();
        return Response.json({ code }, { headers: corsHeaders });
      }

      // ── 单个房间操作 ──────────────────────────────────────────
      const roomMatch = path.match(/^\/api\/rooms\/([^\/]+)(?:\/(join|start|sync))?$/);
      if (roomMatch) {
        const code   = roomMatch[1];
        const action = roomMatch[2];

        // 删除房间（同时清理玩家记录）
        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM room_players WHERE room_id = ?").bind(code).run();
          await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // 多人游戏轮询同步：返回增量动作、聊天和最新权威水情快照
        if (method === "GET" && action === "sync") {
          const sinceAction = Number(url.searchParams.get("since_action") || 0);
          const sinceChat = Number(url.searchParams.get("since_chat") || 0);
          const sinceEvent = Number(url.searchParams.get("since_event") || 0);
          const { results: roomRows } = await env.DB.prepare(
            "SELECT * FROM rooms WHERE code = ?"
          ).bind(code).all();
          if (roomRows.length === 0)
            return Response.json({ detail: '房间不存在' }, { status: 404, headers: corsHeaders });

          const { results: players } = await env.DB.prepare(
            "SELECT player_id, player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
          ).bind(code).all();
          const { results: decisions } = await env.DB.prepare(
            "SELECT * FROM player_decisions WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 500"
          ).bind(code, sinceAction).all();
          const { results: chats } = await env.DB.prepare(
            "SELECT * FROM chat_logs WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 500"
          ).bind(code, sinceChat).all();
          const { results: events } = await env.DB.prepare(
            "SELECT * FROM room_events WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 100"
          ).bind(code, sinceEvent).all();
          const latestRound = await env.DB.prepare(
            "SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num DESC, id DESC LIMIT 1"
          ).bind(code).first();

          return Response.json({
            room: roomRows[0],
            players,
            decisions: decisions || [],
            chats: chats || [],
            events: events || [],
            latest_round: latestRound || null
          }, { headers: corsHeaders });
        }

        // 查询房间（从 room_players 表读取最新玩家列表）
        if (method === "GET" && !action) {
          const { results } = await env.DB.prepare(
            "SELECT * FROM rooms WHERE code = ?"
          ).bind(code).all();
          if (results.length === 0)
            return Response.json({ detail: '房间不存在' }, { status: 404, headers: corsHeaders });

          const room = results[0];
          const { results: players } = await env.DB.prepare(
            "SELECT player_id, player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
          ).bind(code).all();
          room.players = players;
          return Response.json(room, { headers: corsHeaders });
        }

        // 启动游戏
        if (method === "POST" && action === "start") {
          await env.DB.prepare(
            "UPDATE rooms SET status = 'PLAYING', started_at = datetime('now') WHERE code = ?"
          ).bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // ── 加入房间（核心修复区域）────────────────────────────
        if (method === "POST" && action === "join") {
          const body = await request.json();

          const playerName = (body.name || '玩家').toString().slice(0, 30);
          const rawId    = (body.student_id || body.player_id || '');
          // 用学号+姓名拼成稳定的玩家ID，支持断线重连幂等性
          const playerId = (rawId + '_' + (body.name || '')).replace(/\s+/g, '_').slice(0, 60)
                        || `anon_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
          const pref     = body.pref || 'MAYOR';

          // 1. 确保房间存在
          const { results: roomRows } = await env.DB.prepare(
            "SELECT status FROM rooms WHERE code = ?"
          ).bind(code).all();

          if (roomRows.length === 0) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')"
            ).bind(code, "自主加入房间").run();
          }

          // 2. 幂等检查：同一学生断线重连，直接返回已分配的角色
          const existingRow = await env.DB.prepare(
            "SELECT role, village FROM room_players WHERE room_id = ? AND player_id = ?"
          ).bind(code, playerId).first().catch(() => null);

          if (existingRow) {
            const { results: allPlayers } = await env.DB.prepare(
              "SELECT player_id, player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
            ).bind(code).all();
            return Response.json({
              role: existingRow.role,
              village: existingRow.village,
              players: allPlayers
            }, { headers: corsHeaders });
          }

          if (roomRows.length > 0 && roomRows[0].status !== 'WAITING') {
            return Response.json({ detail: "游戏已开始，无法加入" }, { status: 400, headers: corsHeaders });
          }

          // 3. 角色分配（利用 DB UNIQUE 约束实现原子抢占，彻底解决竞态条件）
          let assignedRole    = null;
          let assignedVillage = null;

          if (pref === 'OBSERVER') {
            // 观察者：允许多个老师，用时间戳区分
            const obsRole = 'OBSERVER';
            try {
              await env.DB.prepare(
                "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
              ).bind(code, playerId, playerName, obsRole, 'ALL').run();
              assignedRole = obsRole; assignedVillage = 'ALL';
            } catch(e) {
              // OBSERVER 角色冲突，追加编号
              const obsRoleN = `OBSERVER_${Date.now()}`;
              await env.DB.prepare(
                "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
              ).bind(code, playerId, playerName, obsRoleN, 'ALL').run();
              assignedRole = obsRoleN; assignedVillage = 'ALL';
            }

          } else if (pref === 'VIL') {
            // 明确选村民：永不给官职
            const countRow = await env.DB.prepare(
              "SELECT COUNT(*) as c FROM room_players WHERE room_id = ?"
            ).bind(code).first();
            const vList = ['A1','A2','A3','B1','B2','B3','C1','C2','C3'];
            const v = vList[(countRow?.c || 0) % vList.length];
            const vilRole = genVilRole(v);
            await env.DB.prepare(
              "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
            ).bind(code, playerId, playerName, vilRole, v).run();
            assignedRole = vilRole; assignedVillage = v;

          } else {
            // 官职角色：按偏好优先，逐一尝试 INSERT
            // UNIQUE 约束冲突 → 该角色已被人抢走 → 自动尝试下一个，零竞态条件
            const preferred = rolePreferenceOrder(pref);
            const roleOrder = [];
            preferred.forEach(r => roleOrder.push(r));
            ROLE_SLOTS.filter(r => !roleOrder.includes(r)).forEach(r => roleOrder.push(r));

            for (const role of roleOrder) {
              try {
                await env.DB.prepare(
                  "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
                ).bind(code, playerId, playerName, role, roleToVillage(role)).run();
                assignedRole    = role;
                assignedVillage = roleToVillage(role);
                break;
              } catch(e) {
                continue; // 被抢了，试下一个
              }
            }

            // 12个官职全满 → 降级为村民
            if (!assignedRole) {
              const countRow = await env.DB.prepare(
                "SELECT COUNT(*) as c FROM room_players WHERE room_id = ?"
              ).bind(code).first();
              const vList = ['A1','A2','A3','B1','B2','B3','C1','C2','C3'];
              const v = vList[(countRow?.c || 0) % vList.length];
              const vilRole = genVilRole(v);
              await env.DB.prepare(
                "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
              ).bind(code, playerId, playerName, vilRole, v).run();
              assignedRole = vilRole; assignedVillage = v;
            }
          }

          // 4. 返回结果，异步更新 rooms.players JSON（向后兼容）
          const { results: players } = await env.DB.prepare(
            "SELECT player_id, player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
          ).bind(code).all();

          ctx.waitUntil(
            env.DB.prepare("UPDATE rooms SET players = ? WHERE code = ?")
              .bind(JSON.stringify(players), code).run()
          );

          return Response.json({
            role: assignedRole,
            village: assignedVillage,
            players
          }, { headers: corsHeaders });
        }
      }

      // ── 决策/聊天/轮次数据写入 ───────────────────────────────
      if (path === "/api/data/decisions" && method === "POST") {
        const d = await request.json();
        const actionVal = typeof d.action_value === 'object'
          ? JSON.stringify(d.action_value) : String(d.action_value);
        const result = await env.DB.prepare(
          "INSERT INTO player_decisions (room_id,round_num,player_id,player_name,role,village,action_type,action_value) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(d.room_id, d.round_num, d.player_id||'human', d.player_name, d.role, d.village, d.action_type, actionVal).run();
        return Response.json({ ok: true, id: result.meta?.last_row_id || null }, { headers: corsHeaders });
      }

      if (path === "/api/data/chats" && method === "POST") {
        const c = await request.json();
        const result = await env.DB.prepare(
          "INSERT INTO chat_logs (room_id,round_num,player_id,player_name,role,channel,village,content,msg_type) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(c.room_id, c.round_num, c.player_id||'human', c.player_name, c.role, c.channel, c.village, c.content, c.msg_type).run();
        return Response.json({ ok: true, id: result.meta?.last_row_id || null }, { headers: corsHeaders });
      }

      if (path === "/api/data/rounds" && method === "POST") {
        const r = await request.json();
        await env.DB.prepare(
          "DELETE FROM simulation_rounds WHERE room_id = ? AND round_num = ?"
        ).bind(r.room_id, r.round_num).run();
        await env.DB.prepare(
          `INSERT INTO simulation_rounds (
            room_id,round_num,forecast_A,forecast_B,forecast_C,rainfall_A,rainfall_B,rainfall_C,
            water_A1,water_A2,water_A3,water_B1,water_B2,water_B3,water_C1,water_C2,water_C3,
            asset_A1,asset_A2,asset_A3,asset_B1,asset_B2,asset_B3,asset_C1,asset_C2,asset_C3,
            city_asset_A,city_asset_B,city_asset_C,round_loss,total_loss
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          r.room_id, r.round_num, r.forecast_A||0, r.forecast_B||0, r.forecast_C||0, r.rainfall_A||0, r.rainfall_B||0, r.rainfall_C||0,
          r.water_A1||0, r.water_A2||0, r.water_A3||0, r.water_B1||0, r.water_B2||0, r.water_B3||0, r.water_C1||0, r.water_C2||0, r.water_C3||0,
          r.asset_A1||0, r.asset_A2||0, r.asset_A3||0, r.asset_B1||0, r.asset_B2||0, r.asset_B3||0, r.asset_C1||0, r.asset_C2||0, r.asset_C3||0,
          r.city_asset_A||0, r.city_asset_B||0, r.city_asset_C||0, r.round_loss||0, r.total_loss||0
        ).run();
        await env.DB.prepare("UPDATE rooms SET rounds_played = ? WHERE code = ?").bind(r.round_num, r.room_id).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/api/data/events" && method === "POST") {
        const e = await request.json();
        const payload = typeof e.payload === 'object' ? JSON.stringify(e.payload) : String(e.payload || '{}');
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO room_events
            (room_id,round_num,event_key,event_type,title,content,payload,source)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(
          e.room_id, e.round_num || 1, e.event_key || 'manual_event',
          e.event_type || 'shock', e.title || '', e.content || '',
          payload, e.source || 'system'
        ).run();
        return Response.json({ ok: true, id: result.meta?.last_row_id || null }, { headers: corsHeaders });
      }

      if (path === "/api/data/timeline" && method === "POST") {
        const d = await request.json();
        const actionVal = typeof d.action_value === 'object'
          ? JSON.stringify(d.action_value) : String(d.action_value || '');
        const infoState = typeof d.info_state === 'object'
          ? JSON.stringify(d.info_state) : String(d.info_state || '{}');
        const result = await env.DB.prepare(
          `INSERT INTO decision_timeline
            (room_id,round_num,player_id,player_name,role,village,phase,action_type,action_value,elapsed_ms,info_state)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          d.room_id, d.round_num || 1, d.player_id || 'human', d.player_name || '',
          d.role || '', d.village || '', d.phase || '', d.action_type || 'unknown',
          actionVal, d.elapsed_ms || null, infoState
        ).run();
        return Response.json({ ok: true, id: result.meta?.last_row_id || null }, { headers: corsHeaders });
      }

      if (path === "/api/data/exposure" && method === "POST") {
        const d = await request.json();
        const infoValue = typeof d.info_value === 'object'
          ? JSON.stringify(d.info_value) : String(d.info_value || '');
        const result = await env.DB.prepare(
          `INSERT INTO information_exposure
            (room_id,round_num,player_id,role,village,info_key,info_value,certainty,source)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(
          d.room_id, d.round_num || 1, d.player_id || 'human', d.role || '',
          d.village || '', d.info_key || 'unknown', infoValue,
          d.certainty == null ? 1 : Number(d.certainty), d.source || 'system'
        ).run();
        return Response.json({ ok: true, id: result.meta?.last_row_id || null }, { headers: corsHeaders });
      }

      // ── 数据查询 ──────────────────────────────────────────────
      if (path === "/api/data/decisions" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const since = Number(url.searchParams.get("since") || 0);
        const sql = roomId
          ? "SELECT * FROM player_decisions WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 500"
          : "SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId, since) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/rounds" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const sql = roomId
          ? "SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num ASC, id ASC LIMIT 100"
          : "SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/chats" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const since = Number(url.searchParams.get("since") || 0);
        const sql = roomId
          ? "SELECT * FROM chat_logs WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 500"
          : "SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId, since) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/events" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const since = Number(url.searchParams.get("since") || 0);
        const sql = roomId
          ? "SELECT * FROM room_events WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 500"
          : "SELECT * FROM room_events ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId, since) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/timeline" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const since = Number(url.searchParams.get("since") || 0);
        const sql = roomId
          ? "SELECT * FROM decision_timeline WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 1000"
          : "SELECT * FROM decision_timeline ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId, since) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/exposure" && method === "GET") {
        const roomId = url.searchParams.get("room_id");
        const since = Number(url.searchParams.get("since") || 0);
        const sql = roomId
          ? "SELECT * FROM information_exposure WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 1000"
          : "SELECT * FROM information_exposure ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId, since) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }

      // ── 数据导出 ──────────────────────────────────────────────
      if (path.startsWith("/api/export/")) {
        const room  = path.split('/')[3];
        const allRooms = room === '_all';
        const [rounds, decisions, chats, events, timeline, exposure] = await Promise.all(allRooms ? [
          env.DB.prepare("SELECT * FROM simulation_rounds").all(),
          env.DB.prepare("SELECT * FROM player_decisions").all(),
          env.DB.prepare("SELECT * FROM chat_logs").all(),
          env.DB.prepare("SELECT * FROM room_events").all(),
          env.DB.prepare("SELECT * FROM decision_timeline").all(),
          env.DB.prepare("SELECT * FROM information_exposure").all(),
        ] : [
          env.DB.prepare("SELECT * FROM simulation_rounds WHERE room_id = ?").bind(room).all(),
          env.DB.prepare("SELECT * FROM player_decisions WHERE room_id = ?").bind(room).all(),
          env.DB.prepare("SELECT * FROM chat_logs WHERE room_id = ?").bind(room).all(),
          env.DB.prepare("SELECT * FROM room_events WHERE room_id = ?").bind(room).all(),
          env.DB.prepare("SELECT * FROM decision_timeline WHERE room_id = ?").bind(room).all(),
          env.DB.prepare("SELECT * FROM information_exposure WHERE room_id = ?").bind(room).all(),
        ]);
        return Response.json({
          rounds: rounds.results, decisions: decisions.results, chats: chats.results,
          events: events.results, timeline: timeline.results, exposure: exposure.results
        }, { headers: corsHeaders });
      }

      return new Response("API Route Not Found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return Response.json({ detail: "云端报错: " + e.message }, { status: 500, headers: corsHeaders });
    }
  }
};
