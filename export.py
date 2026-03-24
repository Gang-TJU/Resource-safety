"""
数据导出工具 — 将仿真数据从 SQLite 导出为 Excel/CSV
Usage:
    python export.py                        # 导出所有数据
    python export.py --room ROOM_CODE       # 导出指定房间
    python export.py --format csv           # 导出为CSV
    python export.py --format xlsx          # 导出为Excel (默认)
"""
import argparse, sqlite3, os
from pathlib import Path
from datetime import datetime

import pandas as pd

DB_PATH = Path(__file__).parent / "haihe.db"
OUTPUT_DIR = Path(__file__).parent / "exports"

def get_conn():
    if not DB_PATH.exists():
        print(f"数据库不存在: {DB_PATH}")
        return None
    return sqlite3.connect(str(DB_PATH))

def export_data(room_id=None, fmt="xlsx"):
    conn = get_conn()
    if conn is None:
        return
    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = f"_{room_id}" if room_id else "_all"
    where = f" WHERE room_id='{room_id}'" if room_id else ""

    # Load tables
    df_rounds = pd.read_sql_query(f"SELECT * FROM simulation_rounds{where} ORDER BY round_num", conn)
    df_decisions = pd.read_sql_query(f"SELECT * FROM player_decisions{where} ORDER BY round_num, ts", conn)
    df_chats = pd.read_sql_query(f"SELECT * FROM chat_logs{where} ORDER BY ts", conn)
    conn.close()

    print(f"Simulation_Rounds: {len(df_rounds)} rows")
    print(f"Player_Decisions:  {len(df_decisions)} rows")
    print(f"Chat_Logs:         {len(df_chats)} rows")

    if fmt == "xlsx":
        outpath = OUTPUT_DIR / f"haihe_export{suffix}_{ts}.xlsx"
        with pd.ExcelWriter(str(outpath), engine="openpyxl") as writer:
            df_rounds.to_excel(writer, sheet_name="回合数据", index=False)
            df_decisions.to_excel(writer, sheet_name="玩家决策", index=False)
            df_chats.to_excel(writer, sheet_name="聊天记录", index=False)
            # Summary sheet
            if not df_rounds.empty:
                summary = df_rounds.groupby("room_id").agg(
                    总轮数=("round_num", "max"),
                    累计损失=("total_loss", "max"),
                    平均降雨A=("rainfall_A", "mean"),
                    平均降雨B=("rainfall_B", "mean"),
                    平均降雨C=("rainfall_C", "mean"),
                ).reset_index()
                summary.to_excel(writer, sheet_name="汇总", index=False)
        print(f"已导出: {outpath}")
    else:
        for name, df in [("rounds", df_rounds), ("decisions", df_decisions), ("chats", df_chats)]:
            outpath = OUTPUT_DIR / f"haihe_{name}{suffix}_{ts}.csv"
            df.to_csv(str(outpath), index=False, encoding="utf-8-sig")
            print(f"已导出: {outpath}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="海河仿真数据导出")
    parser.add_argument("--room", type=str, default=None, help="房间代码")
    parser.add_argument("--format", type=str, default="xlsx", choices=["xlsx", "csv"], help="导出格式")
    args = parser.parse_args()
    export_data(room_id=args.room, fmt=args.format)
