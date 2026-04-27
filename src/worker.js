/**
 * 海河洪涝决策仿真平台 — Cloudflare Worker (D1 数据 API)
 *
 * 提供 RESTful 接口供 admin.html 和 index.html 读写仿真数据
 * 绑定 Cloudflare D1 数据库 (SQLite 兼容)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin') || '*';

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    };

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      return await route(path, request, env, cors);
    } catch (e) {
      return json({ detail: 'Internal Error: ' + e.message }, cors, 500);
    }
  }
};

// ========== 路由 ==========

async function route(path, request, env, cors) {
  const method = request.method;
  const db = env.DB;
  const params = new URL(request.url).searchParams;

  // --- 健康检查 ---
  if (path === '/api/health') {
    return json({ ok: true, version: '1.0', db: 'cloudflare-d1' }, cors);
  }

  // --- 轮次数据 ---
  if (path === '/api/data/rounds') {
    if (method === 'GET') {
      const roomId = params.get('room_id');
      const sql = roomId
        ? 'SELECT * FROM simulation_rounds WHERE room_id = ? ORDER BY round_num'
        : 'SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 200';
      const bind = roomId ? [roomId] : [];
      const r = await db.prepare(sql).bind(...bind).all();
      return json(r.results, cors);
    }
    if (method === 'POST') {
      const b = await request.json();
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
        b.room_id, b.round_num,
        b.rainfall_A||0, b.rainfall_B||0, b.rainfall_C||0,
        b.water_A1||0, b.water_A2||0, b.water_A3||0,
        b.water_B1||0, b.water_B2||0, b.water_B3||0,
        b.water_C1||0, b.water_C2||0, b.water_C3||0,
        b.asset_A1||0, b.asset_A2||0, b.asset_A3||0,
        b.asset_B1||0, b.asset_B2||0, b.asset_B3||0,
        b.asset_C1||0, b.asset_C2||0, b.asset_C3||0,
        b.city_asset_A||0, b.city_asset_B||0, b.city_asset_C||0,
        b.round_loss||0, b.total_loss||0
      ).run();
      return json({ ok: true }, cors);
    }
  }

  // --- 决策数据 ---
  if (path === '/api/data/decisions') {
    if (method === 'GET') {
      const roomId = params.get('room_id');
      const sql = roomId
        ? 'SELECT * FROM player_decisions WHERE room_id = ? ORDER BY round_num, ts'
        : 'SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 500';
      const bind = roomId ? [roomId] : [];
      const r = await db.prepare(sql).bind(...bind).all();
      return json(r.results, cors);
    }
    if (method === 'POST') {
      const b = await request.json();
      const val = typeof b.action_value === 'string' ? b.action_value : JSON.stringify(b.action_value || '');
      await db.prepare(`
        INSERT INTO player_decisions
        (room_id, round_num, player_id, player_name, role, village, action_type, action_value)
        VALUES (?,?,?,?,?,?,?,?)
      `).bind(b.room_id, b.round_num, b.player_id, b.player_name, b.role, b.village, b.action_type, val).run();
      return json({ ok: true }, cors);
    }
  }

  // --- 聊天数据 ---
  if (path === '/api/data/chats') {
    if (method === 'GET') {
      const roomId = params.get('room_id');
      const sql = roomId
        ? 'SELECT * FROM chat_logs WHERE room_id = ? ORDER BY ts'
        : 'SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 500';
      const bind = roomId ? [roomId] : [];
      const r = await db.prepare(sql).bind(...bind).all();
      return json(r.results, cors);
    }
    if (method === 'POST') {
      const b = await request.json();
      await db.prepare(`
        INSERT INTO chat_logs
        (room_id, round_num, player_id, player_name, role, channel, village, content, msg_type)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(b.room_id, b.round_num, b.player_id, b.player_name, b.role, b.channel||'ALL', b.village, b.content, b.msg_type||'player').run();
      return json({ ok: true }, cors);
    }
  }

  // --- 房间列表 (从已有数据聚合) ---
  if (path === '/api/rooms' && method === 'GET') {
    const r = await db.prepare(`
      SELECT room_id as code,
             MIN(ts) as created_at,
             MAX(round_num) as round,
             COUNT(DISTINCT round_num) as rounds_played
      FROM simulation_rounds
      GROUP BY room_id
      ORDER BY created_at DESC
    `).all();
    return json(r.results, cors);
  }

  // --- 整局数据导出 ---
  if (path.startsWith('/api/export/') && method === 'GET') {
    const roomCode = path.replace('/api/export/', '');
    const [rounds, decisions, chats] = await Promise.all([
      db.prepare('SELECT * FROM simulation_rounds WHERE room_id=? ORDER BY round_num').bind(roomCode).all(),
      db.prepare('SELECT * FROM player_decisions WHERE room_id=? ORDER BY round_num, ts').bind(roomCode).all(),
      db.prepare('SELECT * FROM chat_logs WHERE room_id=? ORDER BY ts').bind(roomCode).all(),
    ]);
    return json({ rounds: rounds.results, decisions: decisions.results, chats: chats.results }, cors);
  }

  // --- 默认配置 ---
  if (path === '/api/config' && method === 'GET') {
    return json({ ok: true, source: 'worker-default' }, cors);
  }

  return json({ detail: 'Not Found: ' + path }, cors, 404);
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
