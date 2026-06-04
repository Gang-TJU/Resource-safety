// worker.js — V3.1 自动建表版（解决 no such table: room_players 报错）
// 新增：ensureTablesExist() 在每次请求时自动建表，无需手动跑迁移 SQL

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

function prefToRoles(pref) {
  if (pref === 'MAYOR') return ['MAYOR_A', 'MAYOR_B', 'MAYOR_C'];
  if (pref === 'VLF') {
    return ['LEADER_A1', 'LEADER_B1', 'LEADER_C1', 'LEADER_A2', 'LEADER_B2', 'LEADER_C2', 'LEADER_A3', 'LEADER_B3', 'LEADER_C3'];
  }
  if (pref === 'VLN') {
    return ['LEADER_A2', 'LEADER_B2', 'LEADER_C2', 'LEADER_A3', 'LEADER_B3', 'LEADER_C3', 'LEADER_A1', 'LEADER_B1', 'LEADER_C1'];
  }
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
  _dbInitialized = true;
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
        return Response.json({ ok: true, version: "3.1", db: "D1" }, { headers: corsHeaders });

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
      const roomMatch = path.match(/^\/api\/rooms\/([^\/]+)(?:\/(join|start))?$/);
      if (roomMatch) {
        const code   = roomMatch[1];
        const action = roomMatch[2];

        // 删除房间（同时清理玩家记录）
        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM room_players WHERE room_id = ?").bind(code).run();
          await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // 查询房间（从 room_players 表读取最新玩家列表）
        if (method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM rooms WHERE code = ?"
          ).bind(code).all();
          if (results.length === 0)
            return Response.json({ detail: '房间不存在' }, { status: 404, headers: corsHeaders });

          const room = results[0];
          const { results: players } = await env.DB.prepare(
            "SELECT player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
          ).bind(code).all();
          room.players = players;
          return Response.json(room, { headers: corsHeaders });
        }

        // 启动游戏
        if (method === "POST" && action === "start") {
          await env.DB.prepare(
            "UPDATE rooms SET status = 'PLAYING' WHERE code = ?"
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
          } else if (roomRows[0].status !== 'WAITING') {
            return Response.json({ detail: "游戏已开始，无法加入" }, { status: 400, headers: corsHeaders });
          }

          // 2. 幂等检查：同一学生断线重连，直接返回已分配的角色
          const existingRow = await env.DB.prepare(
            "SELECT role, village FROM room_players WHERE room_id = ? AND player_id = ?"
          ).bind(code, playerId).first().catch(() => null);

          if (existingRow) {
            const { results: allPlayers } = await env.DB.prepare(
              "SELECT player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
            ).bind(code).all();
            return Response.json({
              role: existingRow.role,
              village: existingRow.village,
              players: allPlayers
            }, { headers: corsHeaders });
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
            const preferredRoles = prefToRoles(pref);
            const roleOrder = [];
            preferredRoles.forEach(r => { if (!roleOrder.includes(r)) roleOrder.push(r); });
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
            "SELECT player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
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
        await env.DB.prepare(
          "INSERT INTO player_decisions (room_id,round_num,player_id,player_name,role,village,action_type,action_value) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(d.room_id, d.round_num, d.player_id||'human', d.player_name, d.role, d.village, d.action_type, actionVal).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/api/data/chats" && method === "POST") {
        const c = await request.json();
        await env.DB.prepare(
          "INSERT INTO chat_logs (room_id,round_num,player_id,player_name,role,channel,village,content,msg_type) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(c.room_id, c.round_num, c.player_id||'human', c.player_name, c.role, c.channel, c.village, c.content, c.msg_type).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/api/data/rounds" && method === "POST") {
        const r = await request.json();
        await env.DB.prepare(
          `INSERT INTO simulation_rounds (
            room_id,round_num,rainfall_A,rainfall_B,rainfall_C,
            water_A1,water_A2,water_A3,water_B1,water_B2,water_B3,water_C1,water_C2,water_C3,
            asset_A1,asset_A2,asset_A3,asset_B1,asset_B2,asset_B3,asset_C1,asset_C2,asset_C3,
            city_asset_A,city_asset_B,city_asset_C,round_loss,total_loss
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          r.room_id, r.round_num, r.rainfall_A||0, r.rainfall_B||0, r.rainfall_C||0,
          r.water_A1||0, r.water_A2||0, r.water_A3||0, r.water_B1||0, r.water_B2||0, r.water_B3||0, r.water_C1||0, r.water_C2||0, r.water_C3||0,
          r.asset_A1||0, r.asset_A2||0, r.asset_A3||0, r.asset_B1||0, r.asset_B2||0, r.asset_B3||0, r.asset_C1||0, r.asset_C2||0, r.asset_C3||0,
          r.city_asset_A||0, r.city_asset_B||0, r.city_asset_C||0, r.round_loss||0, r.total_loss||0
        ).run();
        await env.DB.prepare("UPDATE rooms SET rounds_played = ? WHERE code = ?")
          .bind(r.round_num, r.room_id).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // ── 数据查询 ──────────────────────────────────────────────
      if (path === "/api/data/decisions" && method === "GET") {
        const roomId = url.searchParams.get('room_id');
        const sql = roomId
          ? "SELECT * FROM player_decisions WHERE room_id = ? ORDER BY round_num ASC, ts ASC"
          : "SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/rounds" && method === "GET") {
        const roomId = url.searchParams.get('room_id');
        const sql = roomId
          ? "SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num ASC, ts ASC"
          : "SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/chats" && method === "GET") {
        const roomId = url.searchParams.get('room_id');
        const sql = roomId
          ? "SELECT * FROM chat_logs WHERE room_id = ? ORDER BY ts ASC"
          : "SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 100";
        const q = roomId ? env.DB.prepare(sql).bind(roomId) : env.DB.prepare(sql);
        return Response.json((await q.all()).results || [], { headers: corsHeaders });
      }

      // ── 数据导出 ──────────────────────────────────────────────
      if (path.startsWith("/api/export/")) {
        const room  = path.split('/')[3];
        const where = room === '_all' ? "" : `WHERE room_id = '${room}'`;
        const [rounds, decisions, chats] = await Promise.all([
          env.DB.prepare(`SELECT * FROM simulation_rounds ${where}`).all(),
          env.DB.prepare(`SELECT * FROM player_decisions ${where}`).all(),
          env.DB.prepare(`SELECT * FROM chat_logs ${where}`).all(),
        ]);
        return Response.json({
          rounds: rounds.results, decisions: decisions.results, chats: chats.results
        }, { headers: corsHeaders });
      }

      return new Response("API Route Not Found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return Response.json({ detail: "云端报错: " + e.message }, { status: 500, headers: corsHeaders });
    }
  }
};
