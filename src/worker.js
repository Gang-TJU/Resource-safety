<<<<<<< HEAD
/**
 * 海河洪涝决策仿真平台 — Cloudflare Worker (D1 数据 API)
 *
 * 提供 RESTful 接口供 admin.html 和 index.html 读写仿真数据
 * 绑定 Cloudflare D1 数据库 (SQLite 兼容)
 */

// 角色槽位（与 server.py 和 index.html 一致）
const ROLE_SLOTS = [
  'MAYOR_A','MAYOR_B','MAYOR_C',
  'LEADER_A1','LEADER_A2','LEADER_A3',
  'LEADER_B1','LEADER_B2','LEADER_B3',
  'LEADER_C1','LEADER_C2','LEADER_C3'
];

function roleToVillage(role) {
  if (role.startsWith('LEADER_')) return role.replace('LEADER_', '');
  if (role.startsWith('MAYOR_')) return role.replace('MAYOR_', '') + '1';  if (role.startsWith('VIL_')) return role.split('_')[1];
  return null;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function prefToRole(pref) {
  if (pref === 'MAYOR') return 'MAYOR_A';
  if (pref === 'VLF') return 'LEADER_B1';
  if (pref === 'VLN') return 'LEADER_B2';
  if (pref === 'OBSERVER') return 'OBSERVER';
  return null; // VIL or unknown → sequential assignment
}

// 分配角色：按照已占用槽位分配下一个可用角色
function assignRole(players, pref) {
  const taken = new Set(players.map(p => p.role));

  // OBSERVER 角色（教师/观察者）不占用游戏槽位
  if (pref === 'OBSERVER' && !taken.has('OBSERVER')) {
    return { role: 'OBSERVER', village: 'ALL' };
  }

  // 尝试偏好角色
  const prefRole = prefToRole(pref);
  if (prefRole && !taken.has(prefRole)) {
    return { role: prefRole, village: roleToVillage(prefRole) };
  }

  // 顺序分配空闲槽位
  for (const slot of ROLE_SLOTS) {
    if (!taken.has(slot)) {
      return { role: slot, village: roleToVillage(slot) };
    }
  }

  // 所有命名槽位已满，分配为普通村民
  const vilCounts = {};
  ['A1','A2','A3','B1','B2','B3','C1','C2','C3'].forEach(v => vilCounts[v] = 0);
  players.forEach(p => {
    if (p.role && p.role.startsWith('VIL_')) {
      const v = p.role.split('_')[1];
      vilCounts[v] = (vilCounts[v] || 0) + 1;
    }
  });
  // 找最少人的村
  let minV = 'B1', minC = Infinity;
  Object.entries(vilCounts).forEach(([v, c]) => { if (c < minC) { minC = c; minV = v; } });
  const idx = vilCounts[minV];
  return { role: `VIL_${minV}_${idx}`, village: minV };
}

=======
>>>>>>> f85631b1e1b8e1c11744ec9414b11d990b901395
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
      if (path === "/api/health") return Response.json({ ok: true, version: "2.0", db: "D1" }, { headers: corsHeaders });
      if (path === "/api/config") return Response.json({}, { headers: corsHeaders });

      // Rooms API
      if (path === "/api/rooms" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM rooms ORDER BY created_at DESC LIMIT 50").all();
        return Response.json(results || [], { headers: corsHeaders });
      }

      if (path === "/api/rooms" && method === "POST") {
        const body = await request.json();
        const groupName = body.group_name || '默认组';
        const code = 'R' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        await env.DB.prepare("INSERT INTO rooms (code, group_name, status, players) VALUES (?, ?, 'WAITING', '[]')").bind(code, groupName).run();
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

        if (method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).all();
          if (results.length === 0) return Response.json({ detail: 'Room not found' }, { status: 404, headers: corsHeaders });
          const room = results[0];
          room.players = JSON.parse(room.players || '[]');
          return Response.json(room, { headers: corsHeaders });
        }

        if (method === "POST" && action === "start") {
          await env.DB.prepare("UPDATE rooms SET status = 'PLAYING' WHERE code = ?").bind(code).run();
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        if (method === "POST" && action === "join") {
          const body = await request.json();
          const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).all();
          
          if (results.length === 0) {
            await env.DB.prepare("INSERT INTO rooms (code, group_name, status, players) VALUES (?, '自主房间', 'WAITING', '[]')").bind(code).run();
          } else if (results[0].status !== 'WAITING') {
            return Response.json({ detail: "房间已在游戏中，无法加入" }, { status: 400, headers: corsHeaders });
          }

          const roomQuery = await env.DB.prepare("SELECT players FROM rooms WHERE code = ?").bind(code).all();
          let players = JSON.parse(roomQuery.results[0].players || '[]');
          
          let assignedRole = body.pref || 'VIL';
          let assignedVillage = 'B1';
          if (assignedRole === 'OBSERVER') assignedVillage = 'ALL';
          else if (assignedRole.startsWith('MAYOR_')) assignedVillage = assignedRole.replace('MAYOR_', '') + '1';
          else if (assignedRole.startsWith('LEADER_')) assignedVillage = assignedRole.replace('LEADER_', '');

          players.push({ name: body.name || '玩家', role: assignedRole, village: assignedVillage });
          await env.DB.prepare("UPDATE rooms SET players = ? WHERE code = ?").bind(JSON.stringify(players), code).run();
          
          return Response.json({ role: assignedRole, village: assignedVillage, players }, { headers: corsHeaders });
        }
      }

      // Data Collection
      if (path === "/api/data/decisions" && method === "POST") {
        const d = await request.json();
        await env.DB.prepare("INSERT INTO player_decisions (room_id, round_num, player_id, player_name, role, village, action_type, action_value) VALUES (?,?,?,?,?,?,?,?)")
          .bind(d.room_id, d.round_num, d.player_id, d.player_name, d.role, d.village, d.action_type, d.action_value).run();
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

      // Data Retrieval
      if (path === "/api/data/rounds" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 200").all();
        return Response.json(results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/decisions" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 200").all();
        return Response.json(results || [], { headers: corsHeaders });
      }
      if (path === "/api/data/chats" && method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 200").all();
        return Response.json(results || [], { headers: corsHeaders });
      }

      // Export
      if (path.startsWith("/api/export/")) {
        const room = path.split('/')[3];
        const where = room === '_all' ? "" : `WHERE room_id = '${room}'`;
        const rounds = (await env.DB.prepare(`SELECT * FROM simulation_rounds ${where}`).all()).results;
        const decisions = (await env.DB.prepare(`SELECT * FROM player_decisions ${where}`).all()).results;
        const chats = (await env.DB.prepare(`SELECT * FROM chat_logs ${where}`).all()).results;
        return Response.json({ rounds, decisions, chats }, { headers: corsHeaders });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  }
};