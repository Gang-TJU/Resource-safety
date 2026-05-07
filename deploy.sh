#!/bin/bash
# ============================================================
# 海河流域洪涝风险决策仿真平台 — 一键部署脚本
# 在服务器上执行: bash deploy.sh
# ============================================================

set -e

# ---- 配置区(根据实际情况修改) ----
APP_DIR="/opt/haihe/output"       # 应用文件目录
DOMAIN="www.resil-hub.cn"         # 域名
PORT=8080                         # 后端端口

echo "========================================"
echo "  海河洪涝决策仿真平台 — 部署脚本"
echo "========================================"

# ---- 1. 检查 Python 依赖 ----
echo ""
echo "[1/5] 检查 Python 依赖..."
pip3 install --quiet fastapi uvicorn python-socketio aiofiles 2>/dev/null || {
    echo "  ⚠  pip3 安装失败, 尝试 pip..."
    pip install --quiet fastapi uvicorn python-socketio aiofiles 2>/dev/null || {
        echo "  ✗  无法安装依赖, 请手动执行: pip3 install fastapi uvicorn python-socketio aiofiles"
        exit 1
    }
}
echo "  ✓  Python 依赖已就绪"

# ---- 2. 停止旧进程 ----
echo ""
echo "[2/5] 停止旧的后端进程..."
pkill -f "python.*server.py" 2>/dev/null && echo "  ✓  已停止旧进程" || echo "  -  无旧进程运行"
sleep 1

# ---- 3. 启动后端服务 ----
echo ""
echo "[3/5] 启动后端服务..."
cd "$APP_DIR"
nohup python3 server.py > /var/log/haihe_server.log 2>&1 &
BACKEND_PID=$!
sleep 3

# 验证后端启动成功
if kill -0 $BACKEND_PID 2>/dev/null; then
    HEALTH=$(curl -s http://127.0.0.1:$PORT/api/health 2>/dev/null)
    if echo "$HEALTH" | grep -q '"ok"'; then
        echo "  ✓  后端已启动 (PID: $BACKEND_PID)"
        echo "     健康检查: $HEALTH"
    else
        echo "  ⚠  后端进程已启动但健康检查失败"
        echo "     返回内容: $HEALTH"
        echo "     日志: tail -20 /var/log/haihe_server.log"
    fi
else
    echo "  ✗  后端启动失败! 查看日志:"
    tail -20 /var/log/haihe_server.log
    exit 1
fi

# ---- 4. 配置 Nginx ----
echo ""
echo "[4/5] 配置 Nginx..."
if [ -f "$APP_DIR/nginx_haihe.conf" ]; then
    # 备份旧配置
    if [ -f /etc/nginx/conf.d/haihe.conf ]; then
        cp /etc/nginx/conf.d/haihe.conf /etc/nginx/conf.d/haihe.conf.bak
        echo "  -  已备份旧配置到 haihe.conf.bak"
    fi

    # 更新 root 路径
    sed "s|root /opt/haihe/output|root $APP_DIR|g" "$APP_DIR/nginx_haihe.conf" > /etc/nginx/conf.d/haihe.conf

    # 禁用可能冲突的 default 配置
    if [ -f /etc/nginx/sites-enabled/default ]; then
        mv /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default.disabled 2>/dev/null || true
        echo "  -  已禁用 default site"
    fi

    # 验证配置
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        echo "  ✓  Nginx 配置已更新并重载"
    else
        echo "  ✗  Nginx 配置语法错误:"
        nginx -t
        exit 1
    fi
else
    echo "  ⚠  未找到 nginx_haihe.conf, 跳过 Nginx 配置"
    echo "     请手动将 nginx_haihe.conf 复制到 /etc/nginx/conf.d/"
fi

# ---- 5. 验证 ----
echo ""
echo "[5/5] 验证部署..."
echo ""

# 测试API
API_RESULT=$(curl -s http://127.0.0.1:$PORT/api/health)
echo "  后端直连测试:  $API_RESULT"

# 测试通过 Nginx
NGINX_RESULT=$(curl -s http://127.0.0.1/api/health 2>/dev/null || echo "Nginx未监听80端口")
echo "  Nginx转发测试: $NGINX_RESULT"

echo ""
echo "========================================"
echo "  部署完成!"
echo "========================================"
echo ""
echo "  游戏页面: http://$DOMAIN/"
echo "  管理后台: http://$DOMAIN/admin"
echo "  健康检查: http://$DOMAIN/api/health"
echo ""
echo "  后端日志: tail -f /var/log/haihe_server.log"
echo "  Nginx日志: tail -f /var/log/nginx/haihe_error.log"
echo ""
echo "  如需停止后端: pkill -f 'python.*server.py'"
echo "  如需重启后端: cd $APP_DIR && nohup python3 server.py > /var/log/haihe_server.log 2>&1 &"
echo ""
