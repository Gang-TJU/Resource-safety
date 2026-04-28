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
  if (role.startsWith('MAYOR_')) return role.replace('MAYOR_', '') + '1';
  if (role.startsWith('VIL_')) return role.split('_')[1];
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
    return json({ ok: true, version: '2.0', db: 'cloudflare-d1' }, cors);
  }

  // --- 房间管理 (同步大厅) ---

  // GET /api/rooms — 房间列表
  if (path === '/api/rooms' && method === 'GET') {
    const r = await db.prepare(
      'SELECT code, group_name, status, players, created_at, started_at FROM rooms ORDER BY created_at DESC'
    ).all();
    return json(r.results.map(row => ({
      ...row,
      players: JSON.parse(row.players || '[]'),
      player_count: JSON.parse(row.players || '[]').length,
    })), cors);
  }

  // POST /api/rooms — 创建房间
  if (path === '/api/rooms' && method === 'POST') {
    const b = await request.json();
    const code = generateCode();
    const groupName = b.group_name || '默认组';
    const config = JSON.stringify(b.config || {});
    await db.prepare(
      'INSERT INTO rooms (code, group_name, status, players, config) VALUES (?, ?, ?, ?, ?)'
    ).bind(code, groupName, 'WAITING', '[]', config).run();
    return json({ ok: true, code, status: 'WAITING' }, cors);
  }

  // 参数化房间路由
  const roomMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{4,8})$/);
  const roomJoinMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/join$/);
  const roomStartMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/start$/);
  const roomFinishMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/finish$/);

  // GET /api/rooms/{code} — 轮询房间状态
  if (roomMatch && method === 'GET') {
    const code = roomMatch[1];
    const r = await db.prepare(
      'SELECT code, group_name, status, players, config, created_at, started_at, finished_at FROM rooms WHERE code = ?'
    ).bind(code).first();
    if (!r) return json({ detail: 'Room not found' }, cors, 404);
    return json({
      ...r,
      players: JSON.parse(r.players || '[]'),
      config: JSON.parse(r.config || '{}'),
      player_count: JSON.parse(r.players || '[]').length,
    }, cors);
  }

  // DELETE /api/rooms/{code} — 删除房间
  if (roomMatch && method === 'DELETE') {
    const code = roomMatch[1];
    await db.prepare('DELETE FROM rooms WHERE code = ?').bind(code).run();
    return json({ ok: true }, cors);
  }

  // POST /api/rooms/{code}/join — 加入房间
  if (roomJoinMatch && method === 'POST') {
    const code = roomJoinMatch[1];
    const b = await request.json();
    const room = await db.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
    if (!room) return json({ detail: 'Room not found' }, cors, 404);
    if (room.status !== 'WAITING') return json({ detail: 'Room is not accepting players (status: ' + room.status + ')' }, cors, 400);

    const players = JSON.parse(room.players || '[]');

    // 检查是否已加入（按 student_id 去重）
    const existing = players.find(p => p.student_id === b.student_id);
    if (existing) {
      return json({
        ok: true, already_joined: true,
        role: existing.role, village: existing.village, players
      }, cors);
    }

    // 分配角色
    const { role, village } = assignRole(players, b.pref);
    const player = {
      name: b.name || '未命名',
      student_id: b.student_id || '',
      pref: b.pref || '',
      role, village,
      joined_at: new Date().toISOString()
    };
    players.push(player);

    await db.prepare('UPDATE rooms SET players = ? WHERE code = ?')
      .bind(JSON.stringify(players), code).run();

    return json({ ok: true, role, village, players }, cors);
  }

  // POST /api/rooms/{code}/start — 教师启动游戏
  if (roomStartMatch && method === 'POST') {
    const code = roomStartMatch[1];
    const room = await db.prepare('SELECT status FROM rooms WHERE code = ?').bind(code).first();
    if (!room) return json({ detail: 'Room not found' }, cors, 404);
    if (room.status !== 'WAITING') return json({ detail: 'Room already started' }, cors, 400);

    await db.prepare("UPDATE rooms SET status = 'PLAYING', started_at = datetime('now') WHERE code = ?")
      .bind(code).run();
    return json({ ok: true, status: 'PLAYING' }, cors);
  }

  // POST /api/rooms/{code}/finish — 结束游戏
  if (roomFinishMatch && method === 'POST') {
    const code = roomFinishMatch[1];
    await db.prepare("UPDATE rooms SET status = 'FINISHED', finished_at = datetime('now') WHERE code = ?")
      .bind(code).run();
    return json({ ok: true, status: 'FINISHED' }, cors);
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
