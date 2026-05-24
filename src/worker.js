// worker.js — V3.0 竞态条件彻底修复版
// 核心改动：用独立 room_players 表 + DB UNIQUE 约束替代 JSON blob 内存锁
// 解决：30人并发加入时身份重复、覆盖丢失、卡死三大问题

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

function prefToRole(pref) {
  if (pref === 'MAYOR') return 'MAYOR_A';
  if (pref === 'VLF')   return 'LEADER_B1';
  if (pref === 'VLN')   return 'LEADER_B2';
  return null;
}

// 生成几乎不可能冲突的村民角色字符串
function genVilRole(village) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `VIL_${village}_${Date.now()}_${rand}`;
}

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

    try {
      // ── 健康检查 ──────────────────────────────────────────────
      if (path === "/api/health")
        return Response.json({ ok: true, version: "3.0", db: "D1" }, { headers: corsHeaders });

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
          // 用学号+姓名拼成稳定的玩家ID，支持断线重连幂等性
          const rawId    = (body.student_id || body.player_id || '');
          const playerId = (rawId + '_' + (body.name || '')).replace(/\s+/g, '_').slice(0, 60)
                        || `anon_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
          const pref     = body.pref || 'MAYOR';

          // 1. 确保房间存在
          const { results: roomRows } = await env.DB.prepare(
            "SELECT status FROM rooms WHERE code = ?"
          ).bind(code).all();

          if (roomRows.length === 0) {
            // 自动创建（允许学生先于老师进入）
            await env.DB.prepare(
              "INSERT OR IGNORE INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')"
            ).bind(code, "自主加入房间").run();
          } else if (roomRows[0].status !== 'WAITING') {
            return Response.json({ detail: "游戏已开始，无法加入" }, { status: 400, headers: corsHeaders });
          }

          // 2. 幂等检查：同一学生断线重连，直接返回已分配的角色
          let existingRow = null;
          try {
            existingRow = await env.DB.prepare(
              "SELECT role, village FROM room_players WHERE room_id = ? AND player_id = ?"
            ).bind(code, playerId).first();
          } catch(e) { /* table may not exist yet */ }

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

          // 3. 角色分配（利用 DB UNIQUE 约束实现原子抢占）
          let assignedRole    = null;
          let assignedVillage = null;

          if (pref === 'OBSERVER') {
            // 观察者：允许多个（多位老师），用唯一时间戳区分
            const obsRole = 'OBSERVER';
            try {
              await env.DB.prepare(
                "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
              ).bind(code, playerId, playerName, obsRole, 'ALL').run();
              assignedRole = obsRole; assignedVillage = 'ALL';
            } catch(e) {
              // OBSERVER 已被占用（两位老师），分配带编号的观察者角色
              const obsRoleN = `OBSERVER_${Date.now()}`;
              await env.DB.prepare(
                "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
              ).bind(code, playerId, playerName, obsRoleN, 'ALL').run();
              assignedRole = obsRoleN; assignedVillage = 'ALL';
            }

          } else if (pref === 'VIL') {
            // 明确选择村民：直接分配，永不给官职
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
            // 官职角色：按偏好优先，逐一尝试 INSERT，UNIQUE 冲突则尝试下一个
            const prefRole   = prefToRole(pref);
            const roleOrder  = [];
            if (prefRole) roleOrder.push(prefRole);
            ROLE_SLOTS.filter(r => r !== prefRole).forEach(r => roleOrder.push(r));

            for (const role of roleOrder) {
              try {
                await env.DB.prepare(
                  "INSERT INTO room_players (room_id, player_id, player_name, role, village) VALUES (?,?,?,?,?)"
                ).bind(code, playerId, playerName, role, roleToVillage(role)).run();
                assignedRole    = role;
                assignedVillage = roleToVillage(role);
                break;  // 成功抢到，退出循环
              } catch(e) {
                // UNIQUE constraint 冲突 → 该角色已被别人抢走，继续尝试下一个
                continue;
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

          // 4. 读取最新玩家列表并返回（同时更新 rooms.players 字段保持向后兼容）
          const { results: players } = await env.DB.prepare(
            "SELECT player_name as name, role, village FROM room_players WHERE room_id = ? ORDER BY joined_at ASC"
          ).bind(code).all();

          // 异步更新 JSON blob（不阻塞响应）
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
          ? JSON.stringify(d.action_value)
          : String(d.action_value);
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
          "INSERT INTO simulation_rounds (room_id,round_num,rainfall_A,rainfall_B,rainfall_C,round_loss,total_loss) VALUES (?,?,?,?,?,?,?)"
        ).bind(r.room_id, r.round_num, r.rainfall_A||0, r.rainfall_B||0, r.rainfall_C||0, r.round_loss||0, r.total_loss||0).run();
        await env.DB.prepare("UPDATE rooms SET rounds_played = ? WHERE code = ?")
          .bind(r.round_num, r.room_id).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // ── 数据查询 ──────────────────────────────────────────────
      if (path === "/api/data/decisions" && method === "GET")
        return Response.json(
          (await env.DB.prepare("SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 100").all()).results || [],
          { headers: corsHeaders }
        );

      if (path === "/api/data/rounds" && method === "GET")
        return Response.json(
          (await env.DB.prepare("SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 100").all()).results || [],
          { headers: corsHeaders }
        );

      if (path === "/api/data/chats" && method === "GET")
        return Response.json(
          (await env.DB.prepare("SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 100").all()).results || [],
          { headers: corsHeaders }
        );

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
          rounds:    rounds.results,
          decisions: decisions.results,
          chats:     chats.results
        }, { headers: corsHeaders });
      }

      return new Response("API Route Not Found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return Response.json({ detail: "云端报错: " + e.message }, { status: 500, headers: corsHeaders });
    }
  }
};
