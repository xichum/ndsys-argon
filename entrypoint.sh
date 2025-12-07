#!/bin/bash

set -e

# ================== 0. Configuration ==================
# Standard Ports
export TUIC_PORT=${TUIC_PORT:-""}
export HY2_PORT=${HY2_PORT:-"20343"}
export REALITY_PORT=${REALITY_PORT:-"20343"}

# Core & Path
export CORE_VER=${CORE_VER:-""} 
export NODE_PREFIX=${NODE_PREFIX:-"Server"}
export ENABLE_LOG=${ENABLE_LOG:-"false"}

# Remote Resources
export REMOTE_RES=${REMOTE_RES:-"true"}
export RES_CERT_URL=${RES_CERT_URL:-"https://chatgpt.coxx"}
export RES_KEY_URL=${RES_KEY_URL:-"https://chatgpt.coxx"}

# Timezone Setup (Docker Optimization)
if [ -n "$TZ" ]; then
    cp /usr/share/zoneinfo/"$TZ" /etc/localtime 2>/dev/null || echo "Timezone setting failed or already set."
    echo "$TZ" > /etc/timezone 2>/dev/null || true
fi

# ================== 1. Environment Setup ==================

# !!! CRITICAL FOR DOCKER: Always use /data for persistence !!!
export WORK_DIR="/data"
mkdir -p "$WORK_DIR"

META_FILE="${WORK_DIR}/.meta"
LOG_FILE="${WORK_DIR}/sys.log"

# ================== 2. Validation ==================

if [[ -z "$TUIC_PORT" && -z "$HY2_PORT" && -z "$REALITY_PORT" ]]; then
  echo -e "\e[1;31m[Error] No ports configured. Please set ENV variables.\e[0m"
  exit 1
fi

# ================== 3. Core Management ==================

get_ver() {
  local url=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/SagerNet/sing-box/releases/latest)
  local ver=""
  if [ -n "$url" ]; then
    ver=$(echo "$url" | grep -oE "v[0-9]+\.[0-9]+\.[0-9]+" | sed 's/v//' || true)
  fi
  if [ -z "$ver" ]; then echo "1.10.7"; else echo "$ver"; fi
}

if [ -z "$CORE_VER" ]; then
  echo -e "\e[1;33m[Updater] Checking registry...\e[0m"
  CORE_VER=$(get_ver)
fi

ARCH_RAW=$(uname -m)
case "${ARCH_RAW}" in
    x86_64|amd64) SYS_ARCH="amd64" ;;
    aarch64|arm64) SYS_ARCH="arm64" ;;
    s390x) SYS_ARCH="s390x" ;;
    *) echo "Error: Arch ${ARCH_RAW} not supported."; exit 1 ;;
esac

install_core() {
  local INSTALLED_VER=""
  local BIN_NAME=""
  if [ -f "$META_FILE" ]; then source "$META_FILE"; fi
  local BIN_PATH="${WORK_DIR}/${BIN_NAME}"

  if [ "$INSTALLED_VER" != "$CORE_VER" ] || [ -z "$BIN_NAME" ] || [ ! -f "$BIN_PATH" ]; then
    echo -e "\e[1;33m[Updater] Pulling Core v${CORE_VER}...\e[0m"
    if [ -n "$BIN_NAME" ]; then rm -f "$BIN_PATH"; fi
    
    local URL="https://github.com/SagerNet/sing-box/releases/download/v${CORE_VER}/sing-box-${CORE_VER}-linux-${SYS_ARCH}.tar.gz"
    local TGZ="${WORK_DIR}/pkg.tar.gz"
    
    if command -v curl >/dev/null; then curl -L -sS -o "$TGZ" "$URL"; else wget -q -O "$TGZ" "$URL"; fi
    
    local TMP_EXT="${WORK_DIR}/tmp_ext"
    mkdir -p "$TMP_EXT"
    tar -xzf "$TGZ" -C "$TMP_EXT"
    rm "$TGZ"
    
    local BIN_FOUND=$(find "$TMP_EXT" -type f -name "sing-box" | head -n 1)
    if [ -z "$BIN_FOUND" ]; then echo "Extraction failed."; rm -rf "$TMP_EXT"; exit 1; fi
    
    # Randomize filename
    local NEW_NAME="k$(head /dev/urandom | tr -dc a-z0-9 | head -c 7)d"
    mv "$BIN_FOUND" "${WORK_DIR}/${NEW_NAME}"
    chmod +x "${WORK_DIR}/${NEW_NAME}"
    rm -rf "$TMP_EXT"
    
    echo "INSTALLED_VER=${CORE_VER}" > "$META_FILE"
    echo "BIN_NAME=${NEW_NAME}" >> "$META_FILE"
    SYS_BIN="${WORK_DIR}/${NEW_NAME}"
    echo -e "\e[1;32m[Updater] Ready: ${NEW_NAME}\e[0m"
  else
    SYS_BIN="${WORK_DIR}/${BIN_NAME}"
    echo -e "\e[1;32m[Updater] Core is active.\e[0m"
  fi
}

install_core

# ================== 4. Identity & Keys ==================

ID_FILE="${WORK_DIR}/id.dat"

if [ -f "$ID_FILE" ]; then
  SYS_ID=$(cat "$ID_FILE")
else
  SYS_ID=$("$SYS_BIN" generate uuid 2>/dev/null)
  if [ -z "$SYS_ID" ] && [ -f /proc/sys/kernel/random/uuid ]; then
    SYS_ID=$(cat /proc/sys/kernel/random/uuid)
  fi
  if [ -z "$SYS_ID" ] && command -v uuidgen >/dev/null; then
    SYS_ID=$(uuidgen)
  fi
  if [[ ! "$SYS_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      echo -e "\e[1;31m[Error] Failed to generate UUID.\e[0m"
      exit 1
  fi
  echo "$SYS_ID" > "$ID_FILE"
fi

SEC_FILE="${WORK_DIR}/sec.dat"
if [ -f "$SEC_FILE" ]; then
  PRIV_KEY=$(grep "PrivateKey:" "$SEC_FILE" | awk '{print $2}')
  PUB_KEY=$(grep "PublicKey:" "$SEC_FILE" | awk '{print $2}')
else
  kout=$("$SYS_BIN" generate reality-keypair)
  echo "$kout" > "$SEC_FILE"
  PRIV_KEY=$(echo "$kout" | awk '/PrivateKey:/ {print $2}')
  PUB_KEY=$(echo "$kout" | awk '/PublicKey:/ {print $2}')
fi

# ================== 5. TLS Resource Logic ==================

CERT_P="${WORK_DIR}/cert.pem"
KEY_P="${WORK_DIR}/private.key"

init_tls() {
  local TMP_CERT="${WORK_DIR}/cert.tmp"
  local TMP_KEY="${WORK_DIR}/key.tmp"
  local DL_SUCCESS=0

  if [ "$REMOTE_RES" == "true" ]; then
    echo -e "\e[1;33m[TLS] Fetching remote credentials...\e[0m"
    for i in {1..2}; do
      if curl -L -sS -o "$TMP_CERT" "$RES_CERT_URL" && curl -L -sS -o "$TMP_KEY" "$RES_KEY_URL"; then
        if [ -s "$TMP_CERT" ] && [ -s "$TMP_KEY" ]; then
          mv -f "$TMP_CERT" "$CERT_P"
          mv -f "$TMP_KEY" "$KEY_P"
          chmod 600 "$KEY_P"
          echo -e "\e[1;32m[TLS] Remote updated successfully.\e[0m"
          DL_SUCCESS=1
          break
        fi
      fi
      [ $i -lt 2 ] && sleep 1
    done
    rm -f "$TMP_CERT" "$TMP_KEY"
    if [ $DL_SUCCESS -eq 1 ]; then return; fi
    echo -e "\e[1;31m[TLS] Remote download failed. Fallback to local.\e[0m"
  fi

  if [ -s "$CERT_P" ] && [ -s "$KEY_P" ]; then
    echo -e "\e[1;32m[TLS] Using valid local credentials.\e[0m"
    return
  fi

  echo -e "\e[1;33m[TLS] Generating self-signed via Core...\e[0m"
  local PAIRS=$("$SYS_BIN" generate tls-keypair bing.com 2>/dev/null)
  
  if [ -z "$PAIRS" ]; then
      echo -e "\e[1;31m[Error] Core failed to generate TLS keypair.\e[0m"
      exit 1
  fi

  echo "$PAIRS" | awk '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/' > "$KEY_P"
  echo "$PAIRS" | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > "$CERT_P"
  chmod 600 "$KEY_P"
  
  if [ ! -s "$KEY_P" ] || [ ! -s "$CERT_P" ]; then
      echo -e "\e[1;31m[Error] TLS parsing failed.\e[0m"
      exit 1
  fi
  echo -e "\e[1;32m[TLS] Self-signed certificates generated.\e[0m"
}

init_tls

# ================== 6. Configuration Build ==================

CFG_TMP="${WORK_DIR}/in_temp.json"
> "$CFG_TMP"

append_comma() {
  if [ -s "$CFG_TMP" ]; then echo "," >> "$CFG_TMP"; fi
}

if [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; then
  cat >> "$CFG_TMP" <<EOF
    {
      "type": "tuic",
      "tag": "tuic-in",
      "listen": "::",
      "listen_port": $TUIC_PORT,
      "users": [{"uuid": "$SYS_ID", "password": "admin"}],
      "congestion_control": "bbr",
      "tls": {"enabled": true, "alpn": ["h3"], "certificate_path": "$CERT_P", "key_path": "$KEY_P"}
    }
EOF
fi

if [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; then
  append_comma
  cat >> "$CFG_TMP" <<EOF
    {
      "type": "hysteria2",
      "tag": "hy2-in",
      "listen": "::",
      "listen_port": $HY2_PORT,
      "users": [{"password": "$SYS_ID"}],
      "masquerade": "https://bing.com",
      "tls": {"enabled": true, "alpn": ["h3"], "certificate_path": "$CERT_P", "key_path": "$KEY_P"}
    }
EOF
fi

if [ -n "$REALITY_PORT" ] && [ "$REALITY_PORT" != "0" ]; then
  append_comma
  cat >> "$CFG_TMP" <<EOF
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": $REALITY_PORT,
      "users": [{"uuid": "$SYS_ID", "flow": "xtls-rprx-vision"}],
      "tls": {
        "enabled": true,
        "server_name": "www.nazhumi.com",
        "reality": {
          "enabled": true,
          "handshake": {"server": "www.nazhumi.com", "server_port": 443},
          "private_key": "$PRIV_KEY",
          "short_id": [""]
        }
      }
    }
EOF
fi

if [ "$ENABLE_LOG" == "true" ]; then
  LOG_BLOCK="\"log\": { \"disabled\": false, \"level\": \"info\", \"output\": \"$LOG_FILE\" },"
else
  LOG_BLOCK="\"log\": { \"disabled\": true },"
fi

SYS_CFG="${WORK_DIR}/sys_conf.json"
cat > "$SYS_CFG" <<EOF
{
  $LOG_BLOCK
  "inbounds": [
$(cat "$CFG_TMP")
  ],
  "outbounds": [{"type": "direct"}]
}
EOF
rm "$CFG_TMP"

# ================== 7. Execution ==================

"$SYS_BIN" run -c "$SYS_CFG" >/dev/null 2>&1 &
PID=$!
echo -e "\e[1;36m[System] Process initiated (PID=$PID)\e[0m"

# ================== 8. Connection Info ==================

HOST_IP=$(curl -s --max-time 3 ipv4.ip.sb || echo "UNKNOWN_IP")
LINK_DAT="${WORK_DIR}/links.dat"
> "$LINK_DAT"

if [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; then
  echo "tuic://${SYS_ID}:admin@${HOST_IP}:${TUIC_PORT}?sni=bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#${NODE_PREFIX}-TUIC" >> "$LINK_DAT"
fi
if [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; then
  echo "hysteria2://${SYS_ID}@${HOST_IP}:${HY2_PORT}/?sni=bing.com&insecure=1#${NODE_PREFIX}-HY2" >> "$LINK_DAT"
fi
if [ -n "$REALITY_PORT" ] && [ "$REALITY_PORT" != "0" ]; then
  echo "vless://${SYS_ID}@${HOST_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=${PUB_KEY}&type=tcp#${NODE_PREFIX}-REALITY" >> "$LINK_DAT"
fi

if [ -s "$LINK_DAT" ]; then
    B64_STR=$(base64 "$LINK_DAT" | tr -d '\n')
    echo "$B64_STR" > "${WORK_DIR}/token.b64"
    echo -e "\n\e[1;32m=== Base64 Subscription ===\e[0m"
    echo "$B64_STR"
    echo -e "\e[1;32m===========================\e[0m"
else
    echo -e "\e[1;31mNo services enabled.\e[0m"
fi

# ================== 9. Daemon ==================

daemon_loop() {
  echo -e "\e[1;35m[Daemon] Active. Schedule: 02:20 UTC+8.\e[0m"
  local LAST_D=-1
  local RETRY_COUNT=0
  local MAX_RETRY=3
  local MAX_LOG_SIZE=5242880 # 5MB

  while true; do
    # 1. Log Management
    if [ -f "$LOG_FILE" ]; then
      local FILE_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
      if [ "$FILE_SIZE" -gt "$MAX_LOG_SIZE" ]; then
        echo "[System] Log file exceeded 5MB. Truncating..." > "$LOG_FILE"
      fi
    fi

    # 2. Process Monitoring
    if ! kill -0 "$PID" > /dev/null 2>&1; then
      if [ "$RETRY_COUNT" -ge "$MAX_RETRY" ]; then
        echo -e "\e[1;31m[Daemon] Max restarts reached ($MAX_RETRY). Exiting container.\e[0m"
        exit 1
      fi
      echo -e "\e[1;31m[Daemon] Unexpected exit. Rebooting ($((RETRY_COUNT+1))/${MAX_RETRY})...\e[0m"
      sleep 3
      "$SYS_BIN" run -c "$SYS_CFG" >/dev/null 2>&1 &
      PID=$!
      ((RETRY_COUNT++))
      echo "[Daemon] New PID: $PID"
    else
      RETRY_COUNT=0
    fi

    # 3. Scheduled Restart (02:20 UTC+8)
    now=$(date +%s)
    # 使用系统时区计算，或者回退到手动偏移
    if date -u >/dev/null 2>&1; then
        # 如果容器时区已设置正确 (通过 TZ 变量)
        H=$(date +%H)
        M=$(date +%M)
        D=$(date +%d)
    else
        # Fallback logic
        bj_time=$((now + 28800))
        H=$(( (bj_time / 3600) % 24 ))
        M=$(( (bj_time / 60) % 60 ))
        D=$(( bj_time / 86400 ))
    fi

    if [ "$H" -eq 02 ] && [ "$M" -eq 20 ] && [ "$D" -ne "$LAST_D" ]; then
      echo "[Daemon] Executing scheduled restart..."
      LAST_D=$D
      kill "$PID" 2>/dev/null || true
      sleep 2
    fi
    
    sleep 10
  done
}

daemon_loop
