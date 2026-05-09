// src/worker.js - 解决前后端房间数据同步问题
const ROLE_SLOTS = [
  'MAYOR_A','MAYOR_B','MAYOR_C',
  'LEADER_A1','LEADER_A2','LEADER_A3',
  'LEADER_B1','LEADER_B2','LEADER_B3',
  'LEADER_C1','LEADER_C2','LEADER_C3'
];

function roleToVillage(role) {
  if (role.startsWith('LEADER_')) return role.replace('LEADER_', '');
  if (role.startsWith('MAYOR_')) return role.replace('MAYOR_', '') + '1';
  if (role.startsWith('VIL_')) return role.split('_')[1];
  return 'B1';
}

function prefToRole(pref) {
  if (pref === 'MAYOR') return 'MAYOR_A';
  if (pref === 'VLF') return 'LEADER_B1';
  if (pref === 'VLN') return 'LEADER_B2';
  if (pref === 'OBSERVER') return 'OBSERVER';
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      if (path === "/api/health") return Response.json({ ok: true, version: "2.2", db: "D1" }, { headers: corsHeaders });
      if (path === "/api/config") return Response.json({}, { headers: corsHeaders });

      if (path === "/api/rooms" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM rooms ORDER BY created_at DESC LIMIT 50").all();
        return Response.json(results || [], { headers: corsHeaders });
      }

      if (path === "/api/rooms" && method === "POST") {
        const body = await request.json();
        const code = 'R' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        await env.DB.prepare("INSERT INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')")
          .bind(code, body.group_name || '默认组').run();
        return Response.json({ code }, { headers: corsHeaders });
      }

      const roomMatch = path.match(/^\/api\/rooms\/([^\/]+)(?:\/(join|start))?$/);
      if (roomMatch) {
        const code = roomMatch[1];
        const action = roomMatch[2];

        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        if (method === "POST" && action === "start") {
          await env.DB.prepare("UPDATE rooms SET status = 'PLAYING' WHERE code = ?").bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        if (method === "POST" && action === "join") {
          const body = await request.json();
          const { results } = await env.DB.prepare("SELECT players, status FROM rooms WHERE code = ?").bind(code).all();

          let currentStatus = 'WAITING';
          let playersStr = '[]';

          // 【核心修复】：如果学生输入的房间号在数据库不存在，则自动创建该房间！
          // 这样教师端就能立刻在后台看到学生自建的房间了
          if (results.length === 0) {
            await env.DB.prepare("INSERT INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')")
              .bind(code, "自主加入房间").run();
          } else {
            currentStatus = results[0].status;
            playersStr = results[0].players || '[]';
          }

          if (currentStatus !== 'WAITING') return Response.json({ detail: "游戏已开始" }, { status: 400, headers: corsHeaders });

          let players = JSON.parse(playersStr);
          const takenRoles = new Set(players.map(p => p.role));

          let assignedRole = null;
          let assignedVillage = 'B1';

          if (body.pref === 'OBSERVER') {
            assignedRole = 'OBSERVER'; assignedVillage = 'ALL';
          } else {
            const pRole = prefToRole(body.pref);
            if (pRole && !takenRoles.has(pRole)) {
              assignedRole = pRole;
            } else {
              assignedRole = ROLE_SLOTS.find(r => !takenRoles.has(r));
            }
            if (!assignedRole) {
              const v = body.pref === 'VLF' ? 'B1' : 'A1';
              assignedRole = `VIL_${v}_${players.length}`;
            }
            assignedVillage = roleToVillage(assignedRole);
          }

          players.push({ name: body.name || '玩家', role: assignedRole, village: assignedVillage });
          await env.DB.prepare("UPDATE rooms SET players = ? WHERE code = ?").bind(JSON.stringify(players), code).run();
          return Response.json({ role: assignedRole, village: assignedVillage, players }, { headers: corsHeaders });
        }
      }

      if (path === "/api/data/decisions" && method === "POST") {
        const d = await request.json();
        await env.DB.prepare("INSERT INTO player_decisions (room_id, round_num, player_id, player_name, role, village, action_type, action_value) VALUES (?,?,?,?,?,?,?,?)")
          .bind(d.room_id, d.round_num, d.player_id, d.player_name, d.role, d.village, d.action_type, JSON.stringify(d.action_value)).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }
      if (path === "/api/data/chats" && method === "POST") {
        const c = await request.json();
        await env.DB.prepare("INSERT INTO chat_logs (room_id, round_num, player_id, player_name, role, channel, village, content, msg_type) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(c.room_id, c.round_num, c.player_id, c.player_name, c.role, c.channel, c.village, c.content, c.msg_type).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }
      if (path === "/api/data/rounds" && method === "POST") {
        const r = await request.json();
        await env.DB.prepare(`INSERT INTO simulation_rounds (room_id, round_num, rainfall_A, rainfall_B, rainfall_C, round_loss, total_loss) VALUES (?,?,?,?,?,?,?)`)
          .bind(r.room_id, r.round_num, r.rainfall_A||0, r.rainfall_B||0, r.rainfall_C||0, r.round_loss||0, r.total_loss||0).run();
        await env.DB.prepare("UPDATE rooms SET rounds_played = ? WHERE code = ?").bind(r.round_num, r.room_id).run();
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/api/data/decisions" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 100").all();
        return Response.json(results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/rounds" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 100").all();
        return Response.json(results || [], { headers: corsHeaders });
      }
      
      if (path.startsWith("/api/export/")) {
        const room = path.split('/')[3];
        const where = room === '_all' ? "" : `WHERE room_id = '${room}'`;
        const rounds = (await env.DB.prepare(`SELECT * FROM simulation_rounds ${where}`).all()).results;
        const decisions = (await env.DB.prepare(`SELECT * FROM player_decisions ${where}`).all()).results;
        return Response.json({ rounds, decisions }, { headers: corsHeaders });
      }

      return new Response("API Route Not Found", { status: 404, headers: corsHeaders });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  }
};