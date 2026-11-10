#!/bin/sh
# InstaBox keepalive — 续租 activity lease，机器就不会因为空闲被自动挂起。
#
# 一个文件搞定安装 / 续租 / 卸载，纯 POSIX sh（Alpine/BusyBox、Debian、OpenWrt），只依赖 curl。
#
#   安装（key 只写进本机 0600 的 .env，绝不落仓库、不进进程列表）
#     key=ibk_xxx bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)
#     machine=qqq 只保一台；machine= 留空 / all = 保活这把 key 名下全部机器
#
#   卸载
#     sh keepalive.sh uninstall                 （--keep-files 保留目录 / --keep-lease 不动租约）
#
#   手动用
#     sh keepalive.sh --once       续租一次，退出码 0/1（cron 用这个）
#     sh keepalive.sh --watch      前台常驻（systemd / OpenRC 用这个）
#     sh keepalive.sh --status     机器状态
#     sh keepalive.sh --release    释放租约，恢复正常空闲挂起
#
#   安装参数（也能写成环境变量）
#     key= / KEY= / INSTABOX_API_KEY=  API key（必填）
#     machine= / INSTABOX_MACHINE=     机器名或 m_... id；留空 / all = 全部
#     --lease NAME     租约名                    （默认 keepalive）
#     --ttl SECONDS    租约秒数 30-3600          （默认 300）
#     --dir PATH       安装目录                  （默认 /root/instabox-keepalive）
#     --service NAME   服务名                    （默认 instabox-keepalive）
#     --raw URL        raw 前缀，脚本自更新用     （默认本仓库 main）
#     --no-start       只装不启
#     --cron           强制走 cron（不用 systemd / OpenRC）
#
#   运行期变量（.env 或环境变量；环境变量优先）
#     INSTABOX_ENV_FILE      .env 路径（默认脚本同目录）
#     INSTABOX_RENEW_EVERY   两次续租的间隔秒数（默认租约的 3/5）
#     INSTABOX_AUTO_RESUME   1（默认）：机器被挂起/停掉时先 resume（stopped 用 start 兜底）再续租；0=只报错不唤醒
#     INSTABOX_API_URL       API 地址（默认 https://api.instabox.sh）
#
#   多账号：key=ibk_aaa,ibk_bbb,ibk_cc3（逗号分隔，无限叠加；单把也行）
#     每把 key 名下的机器各自保活；加 key 就往变量里续一段,ibk_xxx 再重装一次
#
# 机器被挂起后机器内部的定时器也会冻结，所以续租必须从机器外面打进来。
set -u

RAW=${RAW_BASE:-https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main}
DEF_DIR=${INSTALL_DIR:-/root/instabox-keepalive}
DIR=$DEF_DIR
SERVICE=${SERVICE_NAME:-instabox-keepalive}
LEASE=${INSTABOX_LEASE:-keepalive}
TTL=${INSTABOX_LEASE_TTL:-300}
NAME=${machine:-${INSTABOX_MACHINE:-}}
API_KEY=${key:-${KEY:-${IBK:-${INSTABOX_API_KEY:-}}}}
API=${INSTABOX_API_URL:-${api:-https://api.instabox.sh}}
WANT_START=1
FORCE_CRON=0

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo /nonexistent)

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
say() { printf '  %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
mask() {
	v=$1
	n=${#v}
	if [ "$n" -le 12 ]; then
		printf '%s' "$v"
	else
		printf '%s……%s' "$(printf %s "$v" | cut -c1-8)" "$(printf %s "$v" | cut -c$((n - 3))-$n)"
	fi
}

# ---- 运行时：读 .env、调 API、续租 ------------------------------------------
load_env() { # load_env [题目录]
	d=$1
	ENV_FILE=${INSTABOX_ENV_FILE:-$d/.env}
	# shellcheck disable=SC1090
	[ -f "$ENV_FILE" ] && . "$ENV_FILE"
	return 0
}

reload_runtime() { # .env / 环境变量里的值最终生效一次
	API=${INSTABOX_API_URL:-${api:-$API}}
	KEY=${INSTABOX_API_KEY:-${key:-${KEY:-${IBK:-${KEY:-}}}}}
	MACHINE=${INSTABOX_MACHINE:-${machine:-$NAME}}
	LEASE=${INSTABOX_LEASE:-$LEASE}
	TTL=${INSTABOX_LEASE_TTL:-$TTL}
	RENEW=${INSTABOX_RENEW_EVERY:-$((TTL * 3 / 5))}
	AUTO_RESUME=${INSTABOX_AUTO_RESUME:-1}
	ALL=0
	case "$MACHINE" in ""|all|ALL|All|'*') ALL=1 ;; esac
	return 0
}

HTTP_BODY=
HTTP_CODE=


# jget <json> <key> -> "key":… 里最左边那个值，去引号
jget() {
	printf '%s' "$1" | awk -v k="$2" '
		match($0, "\"" k "\":[^,}]*") {
			v = substr($0, RSTART + length(k) + 3, RLENGTH - length(k) - 3)
			gsub(/^[ 	]+|[ 	]+$/, "", v)
			gsub(/^"|"$/, "", v)
			gsub(/^[ 	]+|[ 	]+$/, "", v)
			print v
			exit
		}'
}

# http <METHOD> <PATH> [JSON_BODY] -> HTTP_CODE + HTTP_BODY
http() {
	method=$1
	path=$2
	data=${3:-}
	if [ -n "$data" ]; then
		resp=$(curl -sS -m 30 -X "$method" "$API$path" \
			-H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
			-d "$data" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
	else
		resp=$(curl -sS -m 30 -X "$method" "$API$path" \
			-H "X-API-Key: $KEY" -w '\n%{http_code}' 2>&1) || { HTTP_CODE=0; HTTP_BODY=$resp; return 1; }
	fi
	HTTP_CODE=$(printf '%s' "$resp" | tail -n 1)
	HTTP_BODY=$(printf '%s' "$resp" | sed '$d')
	[ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]
}

# 租约接口只认机器 id（传名字会 400），所以名字要先换成 id；`all` 就是把这把 key
# 能看到的机器全列出来。jq / python3 有就用，都没有就走 awk——按花括号深度扫，
# 裸 BusyBox 也能跑。
machines_list() { # -> 每行 "id<TAB>name"
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$HTTP_BODY" | jq -r '.machines[]? | "\(.id)\t\(.name)"'
	elif command -v python3 >/dev/null 2>&1; then
		printf '%s' "$HTTP_BODY" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for m in d.get("machines") or []:
    print("%s\t%s" % (m.get("id", ""), m.get("name", "")))'
	else
		printf '%s' "$HTTP_BODY" | awk '
			function getv(o, k,   s, r) {
				# 冒号后带/不带空格都要吃："k":"v" 和 "k": "v"
				s = index(o, "\"" k "\": \"")
				if (s == 0) {
					s = index(o, "\"" k "\":\"")
					if (s == 0) { return "" }
					r = substr(o, s + length(k) + 4)
				} else {
					r = substr(o, s + length(k) + 5)
				}
				return substr(r, 1, index(r, "\"") - 1)
			}
			function emit(o,   id, nm) {
				id = getv(o, "id")
				nm = getv(o, "name")
				if (id != "") { print id "\t" nm }
			}
			{
				line = $0
				# "machines":[ 或 "machines": [（冒号后带不带空格两种 API 形态都吃）；
				# busybox awk 不把 match() 当 pattern，用 if
				if (match(line, /"machines"[ 	]*:[ 	]*\[/)) {
					line = substr(line, RSTART + RLENGTH)
				} else {
					line = ""
				}
				depth = 0; buf = ""; started = 0
				for (p = 1; p <= length(line); p++) {
					c = substr(line, p, 1)
					if (c == "]") { if (depth == 0 && started == 1) { break } }
					if (c == "{") {
						depth++
						if (depth == 1) { buf = "{"; started = 1 } else { buf = buf c }
					} else {
						if (c == "}") {
							if (depth == 1) { emit(buf "}"); buf = "" } else { if (depth > 1) { buf = buf c } }
							depth--
						} else {
							if (depth >= 1) { buf = buf c }
						}
					}
				}
			}'
	fi
}

resolve() {
	[ "$ALL" -eq 1 ] && return 0
	case "$MACHINE" in
		m_*) MID=$MACHINE; LABEL=$MACHINE; return 0 ;;
	esac
	http GET "/v1/machines/$MACHINE" || { log "找不到机器 $MACHINE（HTTP $HTTP_CODE）: $HTTP_BODY"; return 1; }
	MID=$(jget "$HTTP_BODY" id)
	[ -n "$MID" ] || { log "没解析出机器 id: $HTTP_BODY"; return 1; }
	LABEL="$MACHINE（$MID）"
	return 0
}

preflight() {
	command -v curl >/dev/null 2>&1 || die "缺 curl（Alpine: apk add curl / Debian: apt-get install -y curl）"
	[ -n "$KEY" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	if [ "$ALL" -eq 0 ]; then
		[ -n "$MACHINE" ] || die "未设置 INSTABOX_MACHINE（填名字、填 all、或留空表示全部）"
	fi
	case "$TTL" in ''|*[!0-9]*) die "TTL 必须是数字: $TTL" ;; esac
	if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then
		die "TTL 必须在 30-3600 秒之间（当前 $TTL）"
	fi
	resolve || exit 1
}

# 机器被平台挂起（suspended）或停掉了：续租一律 409 machine_not_running，光续租是空转，
# 得先唤醒。wake_action 用带 Idempotency-Key 的 POST（换状态的接口缺这个头会 400）。
is_not_running() {
	[ "$HTTP_CODE" = "409" ] || return 1
	printf '%s' "$HTTP_BODY" | grep -Eqi 'not_running|suspended|stopped'
}

wake_action() { # wake_action <id> <resume|start> -> 打印 HTTP 码
	wc=$(curl -sS -m 30 -X POST "$API/v1/machines/$1/$2" \
		-H "X-API-Key: $KEY" -H "Idempotency-Key: ka-$2-$1-$$-$(date +%s)" \
		-o /dev/null -w '%{http_code}' 2>/dev/null) || wc=0
	printf '%s' "$wc"
}

wake_one() { # wake_one <id> <label>；0=已经 running
	c1=$(wake_action "$1" resume)
	if [ "$c1" = "202" ] || [ "$c1" = "200" ]; then
		log "唤醒 $2: resume HTTP $c1"
	else
		c2=$(wake_action "$1" start)
		log "唤醒 $2: resume HTTP $c1 → start HTTP $c2"
	fi
	i=0
	while [ "$i" -lt "${INSTABOX_WAKE_TRIES:-3}" ]; do
		sleep "${INSTABOX_WAKE_GAP:-5}"
		if http GET "/v1/machines/$1" && [ "$(jget "$HTTP_BODY" state)" = "running" ]; then
			return 0
		fi
		i=$((i + 1))
	done
	return 1
}

renew_one() { # renew_one <id> <label>
	if http PUT "/v1/machines/$1/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
		log "续租 ok $2/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
		return 0
	fi
	if [ "$AUTO_RESUME" = "1" ] && is_not_running; then
		if wake_one "$1" "$2" && http PUT "/v1/machines/$1/activity-leases/$LEASE" "{\"ttlSeconds\":$TTL}"; then
			log "续租 ok（唤醒后）$2/$LEASE 到期 $(jget "$HTTP_BODY" expiresAt)"
			return 0
		fi
	fi
	log "续租失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

release_one() { # release_one <id> <label>
	if http DELETE "/v1/machines/$1/activity-leases/$LEASE"; then
		log "已释放租约 $2/$LEASE"
		return 0
	fi
	if [ "$HTTP_CODE" = "404" ]; then
		log "租约本来就不存在 $2/$LEASE"
		return 0
	fi
	log "释放失败 $2/$LEASE HTTP $HTTP_CODE: $HTTP_BODY"
	return 1
}

status_one() { # status_one <id> <label>
	if ! http GET "/v1/machines/$1"; then
		log "读机器失败 $2 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	log "$2 state=$(jget "$HTTP_BODY" state) \
autoSuspendAfterSeconds=$(jget "$HTTP_BODY" autoSuspendAfterSeconds) \
autoSuspendedAt=$(jget "$HTTP_BODY" autoSuspendedAt)"
	return 0
}

each_machine() { # each_machine <fn> —— 对选中的机器逐台执行
	fn=$1
	if [ "$ALL" -eq 0 ]; then
		"$fn" "$MID" "$LABEL"
		return $?
	fi
	if ! http GET "/v1/machines"; then
		log "列机器失败 HTTP $HTTP_CODE: $HTTP_BODY"
		return 1
	fi
	list=$(machines_list) || { log "解析机器列表失败"; return 1; }
	count=$(printf '%s\n' "$list" | grep -c . || true)
	if [ "${count:-0}" -eq 0 ]; then
		log "这把 key 名下没有机器"
		return 1
	fi
	fail=${TMPDIR:-/tmp}/instabox-keepalive-fail.$$
	: > "$fail"
	printf '%s\n' "$list" | while IFS='	' read -r id name; do
		[ -n "$id" ] || continue
		"$fn" "$id" "${name:-$id}" || echo x >> "$fail"
	done
	bad=$(wc -l < "$fail" | tr -d ' ')
	rm -f "$fail"
	if [ "$bad" != "0" ]; then
		log "$bad/$count 台失败"
		return 1
	fi
	return 0
}

# 逗号分隔的 key 列表 -> 逐把执行（空段/重复跳过）
# KEY 第 1 把 = 主 key（空 KEY 报错在 preflight），后面每把都当独立账号跑一轮
each_key() { # each_key <fn> —— 对每把 key 执行一轮（fn 全局变量 kfn，避免与 each_machine 的 fn 踩踏）
	kfn=$1
	# 没给 key 的时候直接报错退出：以前这里会静默跑完 0 个账号、退码 0，
	# 定时任务看着"成功"，其实一次都没续
	[ -n "$(printf '%s' "$KEY" | tr -d ' 	\n')" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	printf '%s\n' "$KEY" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' > "${TMPDIR:-/tmp}/ibk-keys.$$"
	# 去重保序
	awk '!seen[$0]++' "${TMPDIR:-/tmp}/ibk-keys.$$" > "${TMPDIR:-/tmp}/ibk-keys.$$.uniq"
	mv "${TMPDIR:-/tmp}/ibk-keys.$$.uniq" "${TMPDIR:-/tmp}/ibk-keys.$$"
	total=$(wc -l < "${TMPDIR:-/tmp}/ibk-keys.$$" | tr -d ' ')
	n=0
	failkeys=${TMPDIR:-/tmp}/instabox-keys-fail.$$
	: > "$failkeys"
	while IFS= read -r k; do
		n=$((n + 1))
		KEY=$k
		if [ "$total" -gt 1 ]; then
			log "== 账号 $n/$total（key $(mask "$k")）=="
		fi
		if ! "$kfn"; then
			echo x >> "$failkeys"
		fi
	done < "${TMPDIR:-/tmp}/ibk-keys.$$"
	rm -f "${TMPDIR:-/tmp}/ibk-keys.$$" "$failkeys"
	# any 失败 -> 1（逐把互不影响，全跑完再统一退码）
	return 0
}

renew() { each_key renew_round; }

renew_round() { # 每把 key 一轮：校验 → 机器筛选 → 逐台续租
	preflight_nocall && resolve && each_machine renew_one
}

preflight_nocall() {
	command -v curl >/dev/null 2>&1 || die "缺 curl（Alpine: apk add curl / Debian: apt-get install -y curl）"
	[ -n "$KEY" ] || die "未设置 INSTABOX_API_KEY（或 key=…）"
	if [ "$ALL" -eq 0 ]; then
		[ -n "$MACHINE" ] || die "未设置 INSTABOX_MACHINE（填名字、填 all、或留空表示全部）"
	fi
	case "$TTL" in ''|*[!0-9]*) die "TTL 必须是数字: $TTL" ;; esac
	if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then
		die "TTL 必须在 30-3600 秒之间（当前 $TTL）"
	fi
	return 0
}
release() { each_key release_round; }
status() { each_key status_round; }

release_round() { preflight_nocall && resolve && each_machine release_one; }
status_round() { preflight_nocall && resolve && each_machine status_one; }

run_once() { # 一次续租（cron / 冒烟测试用）
	load_env "$SELF_DIR"
	reload_runtime
	renew
}
run_watch() { # 常驻（systemd / OpenRC 用）
	load_env "$SELF_DIR"
	reload_runtime
	preflight
	if [ "$ALL" -eq 1 ]; then TARGET="全部机器（按 key 自动发现）"; else TARGET=$LABEL; fi
	log "watch: 每 ${RENEW}s 续租 $TARGET/$LEASE（ttl ${TTL}s），API $API"
	while :; do
		renew || log "这一轮有失败，下一轮再试"
		sleep "$RENEW"
	done
}

# ---- 安装 --------------------------------------------------------------------
do_install() {
	if [ "$(id -u)" -ne 0 ]; then
		if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then
			log "需要 root，sudo 重跑一次"
			exec sudo -E sh "$0" install "$@"
		fi
		die "需要 root。非 root 机器： curl -Ls $RAW/keepalive.sh | sudo -E env key=你的KEY sh"
	fi

	while [ "$#" -gt 0 ]; do
		a=$1
		shift
		case "$a" in
			key=*|KEY=*|INSTABOX_API_KEY=*) API_KEY=${a#*=} ;;
			machine=*|INSTABOX_MACHINE=*) NAME=${a#*=} ;;
			--lease=*) LEASE=${a#*=} ;;
			--lease) LEASE=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--ttl=*) TTL=${a#*=} ;;
			--ttl) TTL=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--dir=*) DIR=${a#*=} ;;
			--dir) DIR=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--service=*) SERVICE=${a#*=} ;;
			--service) SERVICE=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--raw=*) RAW=${a#*=} ;;
			--raw) RAW=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--api=*) API=${a#*=} ;;
			--api) API=${1:-}; [ "$#" -gt 0 ] && shift ;;
			--no-start) WANT_START=0 ;;
			--cron) FORCE_CRON=1 ;;
			install) : ;;
			-h|--help) usage; exit 0 ;;
			*) die "未知安装参数: $a（看 --help）" ;;
		esac
	done

	# 没显式给 key 就沿用这台机器上已经装好的那份配置（重装/升级不会弄丢 key）
	if [ -z "$API_KEY" ] && [ -f "$DIR/.env" ]; then
		API_KEY=$(sed -n 's/^INSTABOX_API_KEY=//p' "$DIR/.env" | head -n 1)
		[ -n "$NAME" ] || NAME=$(sed -n 's/^INSTABOX_MACHINE=//p' "$DIR/.env" | head -n 1)
	fi
	[ -n "$API_KEY" ] || die "缺 key。用法： key=你的KEY bash <(curl -Ls $RAW/keepalive.sh)"

	case "$TTL" in ''|*[!0-9]*) die "TTL 必须是数字: $TTL" ;; esac
	if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then die "TTL 必须在 30-3600 秒之间"; fi

	log "安装参数：key=$(mask "$API_KEY") machine=${NAME:-全部} lease=$LEASE ttl=${TTL}s dir=$DIR"

	if ! command -v curl >/dev/null 2>&1; then
		log "装 curl"
		if command -v apk >/dev/null 2>&1; then apk add --no-cache curl
		elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl
		elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl
		elif command -v yum >/dev/null 2>&1; then yum install -y -q curl
		elif command -v opkg >/dev/null 2>&1; then opkg update && opkg install curl
		fi
	fi
	command -v curl >/dev/null 2>&1 || die "curl 装不上，请手动装好再跑"

	mkdir -p "$DIR" || die "建不了目录 $DIR"

	# 只有 $0 不是这份文件的真身时才需要搬；搬用 rename，避免正在跑的自己被写坏
	if [ "$SELF_DIR" = "$DIR" ] && [ -f "$DIR/keepalive.sh" ]; then
		say "脚本已在 $DIR/keepalive.sh，跳过复制"
	else
		tmp=$DIR/.keepalive.sh.new
		if [ -f "$0" ] && [ -r "$0" ] && [ "$SELF_DIR" != "/dev/fd" ]; then
			cp -f "$0" "$tmp" || die "复制脚本失败"
		else
			curl -fsSL -m 60 -o "$tmp" "$RAW/keepalive.sh" || die "下载 $RAW/keepalive.sh 失败"
		fi
		chmod 755 "$tmp"
		mv -f "$tmp" "$DIR/keepalive.sh" || die "落地 $DIR/keepalive.sh 失败"
		say "脚本已落地 $DIR/keepalive.sh"
	fi

	umask 077
	{
		printf 'INSTABOX_API_KEY=%s\n' "$API_KEY"
		printf 'INSTABOX_MACHINE=%s\n' "$NAME"
		printf 'INSTABOX_LEASE=%s\n' "$LEASE"
		printf 'INSTABOX_LEASE_TTL=%s\n' "$TTL"
	} > "$DIR/.env" || die "写 $DIR/.env 失败"
	chmod 600 "$DIR/.env"
	printf '%s\n' '.env' 'install.conf' > "$DIR/.gitignore"
	{
		printf 'INSTABOX_SERVICE=%s\n' "$SERVICE"
		printf 'INSTABOX_DIR=%s\n' "$DIR"
		printf 'INSTABOX_RAW=%s\n' "$RAW"
	} > "$DIR/install.conf"
	say "$DIR/.env 已写（权限 600，key 只在这里）"

	log "冒烟测试：先手动续租一次"
	if ! INSTABOX_ENV_FILE=$DIR/.env sh "$DIR/keepalive.sh" --once; then
		die "续租测试没过，先解决上面的报错再装服务（key、machine 名字最容易错）"
	fi
	say "续租成功"

	interval_min=$((TTL * 3 / 5 / 60))
	[ "$interval_min" -lt 1 ] && interval_min=1
	suite=
	if [ "$FORCE_CRON" -eq 0 ]; then
		if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
			suite=systemd
		elif command -v rc-update >/dev/null 2>&1 && [ -x /sbin/openrc-run ]; then
			suite=openrc
		fi
	fi
	[ -n "$suite" ] || suite=cron

	case "$suite" in
		systemd)
			cat > "/etc/systemd/system/$SERVICE.service" <<EOF_UNIT
[Unit]
Description=InstaBox keepalive (activity lease renewer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=INSTABOX_ENV_FILE=$DIR/.env
ExecStart=/bin/sh $DIR/keepalive.sh --watch
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF_UNIT
			systemctl daemon-reload
			[ "$WANT_START" -eq 1 ] && systemctl enable --now "$SERVICE.service" >/dev/null 2>&1
			say "systemd 服务 $SERVICE 已装（日志： journalctl -u $SERVICE -f）"
			;;
		openrc)
			cat > "/etc/init.d/$SERVICE" <<EOF_INIT
#!/sbin/openrc-run
name="instabox keepalive"
command="/bin/sh"
command_args="$DIR/keepalive.sh --watch"
command_background=true
pidfile="/run/$SERVICE.pid"
output_log="/var/log/$SERVICE.log"
error_log="/var/log/$SERVICE.log"
export INSTABOX_ENV_FILE="$DIR/.env"
EOF_INIT
			chmod 755 "/etc/init.d/$SERVICE"
			rc-update add "$SERVICE" default >/dev/null 2>&1
			[ "$WANT_START" -eq 1 ] && rc-service "$SERVICE" start >/dev/null 2>&1
			say "OpenRC 服务 $SERVICE 已装（日志： /var/log/$SERVICE.log）"
			;;
		cron)
			case "$interval_min" in
				1) schedule='* * * * *' ;;
				*) schedule="*/$interval_min * * * *" ;;
			esac
			line="$schedule INSTABOX_ENV_FILE=$DIR/.env /bin/sh $DIR/keepalive.sh --once >/dev/null 2>&1"
			( crontab -l 2>/dev/null | grep -vF "$DIR/keepalive.sh"; printf '%s\n' "$line" ) | crontab - || die "写 crontab 失败"
			say "cron 已装：$schedule（每 $interval_min 分钟一次）"
			;;
	esac

	echo
	if [ "$WANT_START" -eq 1 ]; then
		log "装好了。机器 ${NAME:-全部（按 key 自动发现）} 会被持续续租，就不会空闲挂起。"
	else
		log "装好了（--no-start，没启动）。启动： systemctl enable --now $SERVICE  或  rc-service $SERVICE start"
	fi
	say "看状态： sh $DIR/keepalive.sh --status"
	say "卸载：   sh $DIR/keepalive.sh uninstall"
	say "手动续租一次： sh $DIR/keepalive.sh --once"
}

# ---- 卸载 --------------------------------------------------------------------
do_uninstall() {
	KEEP_FILES=0
	KEEP_LEASE=0
	DIR_GIVEN=0
	# 直接在安装目录里跑这份脚本（最常见）：落点就是它自己，别猜
	if [ -f "$SELF_DIR/install.conf" ]; then DIR=$SELF_DIR; fi
	while [ "$#" -gt 0 ]; do
		a=$1
		shift
		case "$a" in
			--keep-files) KEEP_FILES=1 ;;
			--keep-lease) KEEP_LEASE=1 ;;
			-h|--help) usage; exit 0 ;;
			--dir=*) DIR=${a#*=}; DIR_GIVEN=1 ;;
			--dir) DIR=${1:-}; DIR_GIVEN=1; [ "$#" -gt 0 ] && shift ;;
			--service=*) SERVICE=${a#*=} ;;
			--service) SERVICE=${1:-}; [ "$#" -gt 0 ] && shift ;;
			*) die "未知参数: $a（看 --help）" ;;
		esac
	done
	[ "$(id -u)" -eq 0 ] || die "需要 root（curl -Ls $RAW/keepalive.sh | sudo -E sh -s uninstall）"

	# 装的时候把落点写进 install.conf，这里照它找人，不靠猜。从 /dev/fd 跑（curl | sh）
	# 或者别人把脚本拷到别处跑，就退回默认目录。
	if [ "$DIR_GIVEN" -eq 0 ] && [ ! -f "$DIR/install.conf" ] && [ -f "$DEF_DIR/install.conf" ]; then DIR=$DEF_DIR; fi
	if [ -f "$DIR/install.conf" ]; then
		v=$(sed -n 's/^INSTABOX_SERVICE=//p' "$DIR/install.conf" | head -n 1)
		[ -n "$v" ] && SERVICE=$v
		v=$(sed -n 's/^INSTABOX_RAW=//p' "$DIR/install.conf" | head -n 1)
		[ -n "$v" ] && RAW=$v
	fi

	# 1) 监督者。unit 只有确实指向这个目录才删——卸载绝不能顺手带走同名的别人的服务。
	UNIT=/etc/systemd/system/$SERVICE.service
	if [ -f "$UNIT" ]; then
		if grep -qF "$DIR/keepalive.sh" "$UNIT"; then
			systemctl disable --now "$SERVICE.service" >/dev/null 2>&1 || true
			rm -f "$UNIT"
			systemctl daemon-reload >/dev/null 2>&1 || true
			say "已停止并删除 systemd 服务 $SERVICE"
		else
			say "跳过 systemd 服务 $SERVICE：它不指向 $DIR"
		fi
	fi
	INIT=/etc/init.d/$SERVICE
	if [ -f "$INIT" ]; then
		if grep -qF "$DIR/keepalive.sh" "$INIT"; then
			rc-service "$SERVICE" stop >/dev/null 2>&1 || true
			rc-update del "$SERVICE" default >/dev/null 2>&1 || true
			rm -f "$INIT"
			say "已停止并删除 OpenRC 服务 $SERVICE"
		else
			say "跳过 OpenRC 服务 $SERVICE：它不指向 $DIR"
		fi
	fi
	if command -v crontab >/dev/null 2>&1; then
		BEFORE=$(crontab -l 2>/dev/null || true)
		AFTER=$(printf '%s\n' "$BEFORE" | grep -vF "$DIR/keepalive.sh" | grep -v '^$' || true)
		if [ "$AFTER" != "$BEFORE" ]; then
			printf '%s\n' "$AFTER" | crontab - 2>/dev/null || true
			say "已删掉 cron 条目"
		fi
	fi

	# 2) 租约：主动放掉，机器立刻恢复“空闲 30 分钟自动挂起”的正常行为
	if [ "$KEEP_LEASE" -eq 0 ] && [ -f "$DIR/keepalive.sh" ] && [ -f "$DIR/.env" ]; then
		INSTABOX_ENV_FILE=$DIR/.env sh "$DIR/keepalive.sh" --release || true
	fi

	# 3) 文件
	if [ "$KEEP_FILES" -eq 0 ]; then
		rm -rf "$DIR"
		say "已删除 $DIR"
	else
		say "保留 $DIR（--keep-files）"
	fi
	log "卸载完了。"
}

usage() {
	sed -n '2,/^set -u$/p' "$0" | sed -e 's/^# \?//' -e '$d'
}

case "${1:-}" in
	install)
		shift
		do_install "$@"
		;;
	uninstall|--uninstall|-U)
		shift
		do_uninstall "$@"
		;;
	--watch|-w) run_watch ;;
	--once|-1) run_once ;;
	--status|-s)
		load_env "$SELF_DIR"
		reload_runtime
		status
		;;
	--release|-r)
		load_env "$SELF_DIR"
		reload_runtime
		release
		;;
	-h|--help|help) usage ;;
	key=*|KEY=*|machine=*|INSTABOX_*=*|--lease*|--ttl*|--dir*|--service*|--raw*|--api*|--no-start|--cron)
		do_install "$@"
		;;
	'')
		# 不带参数 = 安装（`key=… bash <(curl …/keepalive.sh)` 的用法）
		# 已经装过的机器上再跑一次 = 按现有 .env 重装/升级
		do_install
		;;
	*)
		printf '未知参数: %s\n\n' "$1" >&2
		usage >&2
		exit 2
		;;
esac
