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