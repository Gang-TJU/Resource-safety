"""
海河流域洪涝风险决策仿真平台 — 后端服务
FastAPI + Socket.IO + SQLite
"""
import json, os, time, random, string, uuid
from datetime import datetime
from pathlib import Path

import hashlib, hmac, secrets

import socketio
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Depends, Cookie, Response
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

# ── paths ──
BASE = Path(__file__).parent
CONFIG_PATH = BASE / "config.json"
DB_PATH = BASE / "haihe.db"

# ── load config ──
def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

CFG = load_config()

# ── Admin auth ──
ADMIN_CRED_PATH = BASE / "admin_credentials.json"
ADMIN_SESSIONS = {}  # token -> expire_ts
ADMIN_SESSION_PATH = BASE / "admin_sessions.json"

def _load_sessions():
    global ADMIN_SESSIONS
    if ADMIN_SESSION_PATH.exists():
        try:
            with open(ADMIN_SESSION_PATH, "r") as f:
                data = json.load(f)
            # Prune expired sessions
            now = time.time()
            ADMIN_SESSIONS = {k: v for k, v in data.items() if v > now}
        except Exception:
            ADMIN_SESSIONS = {}

def _save_sessions():
    try:
        with open(ADMIN_SESSION_PATH, "w") as f:
            json.dump(ADMIN_SESSIONS, f)
    except Exception:
        pass

_load_sessions()

def _load_admin_creds():
    if ADMIN_CRED_PATH.exists():
        with open(ADMIN_CRED_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    # Default credentials — change on first deployment
    creds = {"username": "admin", "password_hash": hashlib.sha256("haihe2023".encode()).hexdigest()}
    with open(ADMIN_CRED_PATH, "w", encoding="utf-8") as f:
        json.dump(creds, f, ensure_ascii=False, indent=2)
    return creds

def _verify_password(username, password):
    creds = _load_admin_creds()
    if username != creds.get("username"):
        return False
    return hmac.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(),
        creds.get("password_hash", "")
    )

def _create_session():
    token = secrets.token_hex(32)
    ADMIN_SESSIONS[token] = time.time() + 86400  # 24h
    _save_sessions()
    return token

def _check_session(token):
    if not token or token not in ADMIN_SESSIONS:
        return False
    if time.time() > ADMIN_SESSIONS[token]:
        del ADMIN_SESSIONS[token]
        _save_sessions()
        return False
    return True

# ── database (sqlite3) ──
import sqlite3

def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS simulation_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        round_num INTEGER NOT NULL,
        rainfall_A REAL, rainfall_B REAL, rainfall_C REAL,
        water_A1 REAL, water_A2 REAL, water_A3 REAL,
        water_B1 REAL, water_B2 REAL, water_B3 REAL,
        water_C1 REAL, water_C2 REAL, water_C3 REAL,
        asset_A1 REAL, asset_A2 REAL, asset_A3 REAL,
        asset_B1 REAL, asset_B2 REAL, asset_B3 REAL,
        asset_C1 REAL, asset_C2 REAL, asset_C3 REAL,
        city_asset_A REAL, city_asset_B REAL, city_asset_C REAL,
        round_loss REAL, total_loss REAL,
        ts TEXT DEFAULT (datetime('now','localtime'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS player_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        round_num INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        player_name TEXT,
        role TEXT,
        village TEXT,
        action_type TEXT NOT NULL,
        action_value TEXT,
        ts TEXT DEFAULT (datetime('now','localtime'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        round_num INTEGER,
        player_id TEXT,
        player_name TEXT,
        role TEXT,
        channel TEXT,
        village TEXT,
        content TEXT,
        msg_type TEXT DEFAULT 'player',
        ts TEXT DEFAULT (datetime('now','localtime'))
    )""")
    conn.commit()
    conn.close()

init_db()

def db_exec(sql, params=()):
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute(sql, params)
    conn.commit()
    last_id = c.lastrowid
    conn.close()
    return last_id

def db_query(sql, params=()):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute(sql, params)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows

# ── Room management ──
ROOMS = {}  # room_code -> room dict

ROLE_SLOTS = [
    "MAYOR_A", "MAYOR_B", "MAYOR_C",
    "LEADER_A1", "LEADER_A2", "LEADER_A3",
    "LEADER_B1", "LEADER_B2", "LEADER_B3",
    "LEADER_C1", "LEADER_C2", "LEADER_C3",
]

def gen_room_code():
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))

def create_room(group_name="默认组"):
    code = gen_room_code()
    room = {
        "code": code,
        "group_name": group_name,
        "created_at": datetime.now().isoformat(),
        "status": "waiting",  # waiting / playing / finished
        "players": {},  # sid -> {id, name, sid, role, village, is_bot}
        "config": load_config(),  # each room gets its own config snapshot
        "game_state": None,
        "round": 0,
        "phase_index": 0,
    }
    ROOMS[code] = room
    return code

def assign_role(room, player_name, pref=None):
    """Assign a role to the player. Returns (role, village)."""
    taken = {p["role"] for p in room["players"].values() if not p["is_bot"]}
    available = [r for r in ROLE_SLOTS if r not in taken]
    # preference mapping
    pref_map = {
        "MAYOR": [r for r in available if r.startswith("MAYOR_")],
        "VLF": [r for r in available if r.startswith("LEADER_") and room["config"]["is_flood_zone"].get(r.replace("LEADER_", ""), False)],
        "VLN": [r for r in available if r.startswith("LEADER_") and not room["config"]["is_flood_zone"].get(r.replace("LEADER_", ""), False)],
        "VIL": [],  # villager gets no special slot
    }
    role = None
    if pref and pref in pref_map and pref_map[pref]:
        role = random.choice(pref_map[pref])
    elif available:
        role = random.choice(available)
    if role is None:
        # All named roles taken — assign as villager
        vils = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"]
        v = random.choice(vils)
        role = f"VIL_{v}_h{len(room['players'])}"
    # Determine village
    if role.startswith("LEADER_"):
        vil = role.replace("LEADER_", "")
    elif role.startswith("MAYOR_"):
        vil = role.replace("MAYOR_", "") + "1"
    elif role.startswith("VIL_"):
        parts = role.split("_")
        vil = parts[1] if len(parts) > 1 else "B1"
    else:
        vil = "B1"
    return role, vil

# ── FastAPI + Socket.IO ──
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
app = FastAPI(title="海河洪涝决策仿真平台", redirect_slashes=False)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
sio_app = socketio.ASGIApp(sio, other_asgi_app=app)

# ── Admin auth dependency ──
async def require_admin(request: Request):
    token = request.cookies.get("admin_token")
    if not _check_session(token):
        raise HTTPException(401, "未登录或会话已过期")

# Serve static files
@app.get("/")
async def serve_index():
    return FileResponse(str(BASE / "index.html"), media_type="text/html")

@app.get("/admin")
async def serve_admin(request: Request):
    token = request.cookies.get("admin_token")
    if not _check_session(token):
        return FileResponse(str(BASE / "admin_login.html"), media_type="text/html")
    return FileResponse(str(BASE / "admin.html"), media_type="text/html")

@app.get("/admin/")
async def serve_admin_slash(request: Request):
    return RedirectResponse("/admin", status_code=302)

@app.post("/api/admin/login")
async def admin_login(request: Request):
    body = await request.json()
    username = body.get("username", "")
    password = body.get("password", "")
    if not _verify_password(username, password):
        raise HTTPException(401, "用户名或密码错误")
    token = _create_session()
    resp = JSONResponse({"ok": True})
    resp.set_cookie("admin_token", token, max_age=86400, httponly=True, samesite="lax")
    return resp

@app.post("/api/admin/logout")
async def admin_logout(request: Request):
    token = request.cookies.get("admin_token")
    if token and token in ADMIN_SESSIONS:
        del ADMIN_SESSIONS[token]
        _save_sessions()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("admin_token")
    return resp

@app.post("/api/admin/change-password")
async def admin_change_password(request: Request, _=Depends(require_admin)):
    body = await request.json()
    old_pw = body.get("old_password", "")
    new_pw = body.get("new_password", "")
    creds = _load_admin_creds()
    if not _verify_password(creds["username"], old_pw):
        raise HTTPException(400, "原密码错误")
    if len(new_pw) < 4:
        raise HTTPException(400, "新密码至少4个字符")
    creds["password_hash"] = hashlib.sha256(new_pw.encode()).hexdigest()
    with open(ADMIN_CRED_PATH, "w", encoding="utf-8") as f:
        json.dump(creds, f, ensure_ascii=False, indent=2)
    return {"ok": True}

# ── REST API: Config (read: public, write: admin only) ──
@app.get("/api/config")
async def get_config():
    return load_config()

@app.post("/api/config", dependencies=[Depends(require_admin)])
async def update_config(request: Request):
    body = await request.json()
    save_config(body)
    global CFG
    CFG = body
    return {"ok": True}

# ── REST API: Rooms (admin only) ──
@app.post("/api/rooms", dependencies=[Depends(require_admin)])
async def api_create_room(request: Request):
    body = await request.json()
    code = create_room(body.get("group_name", "默认组"))
    return {"code": code, "room": _room_summary(code)}

@app.get("/api/rooms", dependencies=[Depends(require_admin)])
async def api_list_rooms():
    return [_room_summary(c) for c in ROOMS]

@app.get("/api/rooms/{code}", dependencies=[Depends(require_admin)])
async def api_get_room(code: str):
    if code not in ROOMS:
        raise HTTPException(404, "Room not found")
    return _room_summary(code)

@app.delete("/api/rooms/{code}", dependencies=[Depends(require_admin)])
async def api_delete_room(code: str):
    if code in ROOMS:
        del ROOMS[code]
    return {"ok": True}

def _room_summary(code):
    r = ROOMS.get(code)
    if not r:
        return None
    return {
        "code": r["code"],
        "group_name": r["group_name"],
        "status": r["status"],
        "player_count": len([p for p in r["players"].values() if not p["is_bot"]]),
        "created_at": r["created_at"],
        "round": r["round"],
    }

# ── REST API: Data export (admin only) ──
@app.get("/api/export/{room_code}", dependencies=[Depends(require_admin)])
async def api_export(room_code: str, fmt: str = "json"):
    rounds_data = db_query("SELECT * FROM simulation_rounds WHERE room_id=? ORDER BY round_num", (room_code,))
    decisions = db_query("SELECT * FROM player_decisions WHERE room_id=? ORDER BY round_num, ts", (room_code,))
    chats = db_query("SELECT * FROM chat_logs WHERE room_id=? ORDER BY ts", (room_code,))
    if fmt == "json":
        return {"rounds": rounds_data, "decisions": decisions, "chats": chats}
    # Excel export handled by export.py script
    raise HTTPException(400, "Use export.py for Excel output")

@app.get("/api/data/rounds", dependencies=[Depends(require_admin)])
async def api_data_rounds(room_id: str = None):
    if room_id:
        return db_query("SELECT * FROM simulation_rounds WHERE room_id=? ORDER BY round_num", (room_id,))
    return db_query("SELECT * FROM simulation_rounds ORDER BY ts DESC LIMIT 200")

@app.get("/api/data/decisions", dependencies=[Depends(require_admin)])
async def api_data_decisions(room_id: str = None):
    if room_id:
        return db_query("SELECT * FROM player_decisions WHERE room_id=? ORDER BY round_num, ts", (room_id,))
    return db_query("SELECT * FROM player_decisions ORDER BY ts DESC LIMIT 500")

@app.get("/api/data/chats", dependencies=[Depends(require_admin)])
async def api_data_chats(room_id: str = None):
    if room_id:
        return db_query("SELECT * FROM chat_logs WHERE room_id=? ORDER BY ts", (room_id,))
    return db_query("SELECT * FROM chat_logs ORDER BY ts DESC LIMIT 500")

# ── Socket.IO events ──
@sio.event
async def connect(sid, environ):
    print(f"[WS] connect: {sid}")

@sio.event
async def disconnect(sid):
    print(f"[WS] disconnect: {sid}")
    # Remove from room
    for code, room in ROOMS.items():
        if sid in room["players"]:
            player = room["players"].pop(sid)
            await sio.emit("player_left", {"player_id": player["id"], "name": player["name"]}, room=code)
            break

@sio.event
async def join_room(sid, data):
    """Player joins a room. data: {code, name, student_id, pref}"""
    code = data.get("code", "").upper()
    if code not in ROOMS:
        await sio.emit("error", {"msg": "房间不存在"}, to=sid)
        return
    room = ROOMS[code]
    if room["status"] == "finished":
        await sio.emit("error", {"msg": "该房间游戏已结束"}, to=sid)
        return
    name = data.get("name", "匿名")
    pref = data.get("pref", "VIL")
    role, vil = assign_role(room, name, pref)
    player = {
        "id": f"p_{sid[:8]}",
        "name": name,
        "sid": sid,
        "student_id": data.get("student_id", ""),
        "role": role,
        "village": vil,
        "is_bot": False,
    }
    room["players"][sid] = player
    sio.enter_room(sid, code)
    # Send role assignment to this player
    await sio.emit("role_assigned", {
        "role": role, "village": vil, "room_code": code,
        "config": room["config"],
        "players": [{"id": p["id"], "name": p["name"], "role": p["role"], "is_bot": p["is_bot"]}
                    for p in room["players"].values()]
    }, to=sid)
    # Broadcast to room
    await sio.emit("player_joined", {
        "player_id": player["id"], "name": name, "role": role
    }, room=code)

@sio.event
async def start_game(sid, data):
    """Teacher starts the game. data: {code}"""
    code = data.get("code", "")
    if code not in ROOMS:
        return
    room = ROOMS[code]
    room["status"] = "playing"
    room["round"] = 1
    room["phase_index"] = 0
    # Fill empty roles with AI
    taken_roles = {p["role"] for p in room["players"].values()}
    ai_id = 0
    for r in ROLE_SLOTS:
        if r not in taken_roles:
            ai_player = {
                "id": f"ai_{r}",
                "name": f"AI_{r}",
                "sid": None,
                "role": r,
                "village": r.replace("LEADER_", "").replace("MAYOR_", "") + ("1" if r.startswith("MAYOR_") else ""),
                "is_bot": True,
            }
            if r.startswith("LEADER_"):
                ai_player["village"] = r.replace("LEADER_", "")
            room["players"][f"ai_{ai_id}"] = ai_player
            ai_id += 1
    await sio.emit("game_started", {
        "round": 1,
        "config": room["config"],
        "players": [{"id": p["id"], "name": p["name"], "role": p["role"], "is_bot": p["is_bot"]}
                    for p in room["players"].values()]
    }, room=code)

@sio.event
async def player_action(sid, data):
    """Player sends a decision. data: {code, action, value, ...}"""
    code = data.get("code", "")
    if code not in ROOMS:
        return
    room = ROOMS[code]
    player = room["players"].get(sid)
    if not player:
        return
    action_type = data.get("action", "")
    action_value = json.dumps(data.get("value", ""), ensure_ascii=False)
    # Record to database
    db_exec(
        "INSERT INTO player_decisions (room_id, round_num, player_id, player_name, role, village, action_type, action_value) VALUES (?,?,?,?,?,?,?,?)",
        (code, room["round"], player["id"], player["name"], player["role"], player["village"], action_type, action_value)
    )
    # Broadcast to all room members
    await sio.emit("action_broadcast", {
        "player_id": player["id"],
        "name": player["name"],
        "role": player["role"],
        "action": action_type,
        "value": data.get("value"),
        "round": room["round"],
    }, room=code)

@sio.event
async def chat_message(sid, data):
    """Chat message. data: {code, content, channel, village}"""
    code = data.get("code", "")
    if code not in ROOMS:
        return
    room = ROOMS[code]
    player = room["players"].get(sid)
    if not player:
        return
    content = data.get("content", "")
    channel = data.get("channel", "ALL")
    village = data.get("village")
    # Record to database
    db_exec(
        "INSERT INTO chat_logs (room_id, round_num, player_id, player_name, role, channel, village, content, msg_type) VALUES (?,?,?,?,?,?,?,?,?)",
        (code, room["round"], player["id"], player["name"], player["role"], channel, village, content, "player")
    )
    # Broadcast
    await sio.emit("chat_broadcast", {
        "player_id": player["id"],
        "name": player["name"],
        "role": player["role"],
        "content": content,
        "channel": channel,
        "village": village,
        "round": room["round"],
    }, room=code)

@sio.event
async def advance_phase(sid, data):
    """Advance game phase. data: {code}"""
    code = data.get("code", "")
    if code not in ROOMS:
        return
    room = ROOMS[code]
    room["phase_index"] += 1
    phases = ["WEATHER", "VIL_DISCUSS", "LEADER_BUILD", "MAYOR_DRAIN", "COMPUTE", "ROUND_END"]
    if room["phase_index"] >= len(phases):
        room["phase_index"] = 0
        room["round"] += 1
        if room["round"] > room["config"]["game"]["max_rounds"]:
            room["status"] = "finished"
            await sio.emit("game_finished", {"code": code}, room=code)
            return
    await sio.emit("phase_changed", {
        "round": room["round"],
        "phase_index": room["phase_index"],
        "phase": phases[room["phase_index"] % len(phases)],
    }, room=code)

@sio.event
async def save_round_data(sid, data):
    """Save round summary data. data: {code, round_num, rainfall, water_levels, ...}"""
    code = data.get("code", "")
    r = data.get("round_num", 0)
    rain = data.get("rainfall", {})
    ws = data.get("water_levels", {})
    va = data.get("village_assets", {})
    ca = data.get("city_assets", {})
    loss = data.get("round_loss", 0)
    total = data.get("total_loss", 0)
    db_exec(
        """INSERT INTO simulation_rounds
        (room_id, round_num, rainfall_A, rainfall_B, rainfall_C,
         water_A1, water_A2, water_A3, water_B1, water_B2, water_B3, water_C1, water_C2, water_C3,
         asset_A1, asset_A2, asset_A3, asset_B1, asset_B2, asset_B3, asset_C1, asset_C2, asset_C3,
         city_asset_A, city_asset_B, city_asset_C,
         round_loss, total_loss) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (code, r,
         rain.get("A", 0), rain.get("B", 0), rain.get("C", 0),
         ws.get("A1", 0), ws.get("A2", 0), ws.get("A3", 0),
         ws.get("B1", 0), ws.get("B2", 0), ws.get("B3", 0),
         ws.get("C1", 0), ws.get("C2", 0), ws.get("C3", 0),
         va.get("A1", 0), va.get("A2", 0), va.get("A3", 0),
         va.get("B1", 0), va.get("B2", 0), va.get("B3", 0),
         va.get("C1", 0), va.get("C2", 0), va.get("C3", 0),
         ca.get("A", 0), ca.get("B", 0), ca.get("C", 0),
         loss, total)
    )

# ── Main ──
if __name__ == "__main__":
    print("🌊 海河流域洪涝风险决策仿真平台")
    print(f"   游戏页面: http://localhost:8080/")
    print(f"   管理后台: http://localhost:8080/admin")
    print(f"   数据API:  http://localhost:8080/api/data/rounds")
    uvicorn.run(sio_app, host="0.0.0.0", port=8080, log_level="info")
