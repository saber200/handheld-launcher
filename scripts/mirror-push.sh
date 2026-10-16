#!/usr/bin/env bash
#
# 本机直推国内镜像（2026-10-15 加）。
#
# 为什么值得单独一个脚本：GitHub Actions 的 runner 在境外，向 Gitee 上传 72MB
# 安装包时跨洋连接会假死（2026-10-15 两次实测：1800 秒只推出去 25~27MB，约
# 14KB/s；重试 5 次也推不完）。而发布物仓库是国内的，从本机推只要几十秒。
#
#   GITEE_TOKEN=<私人令牌> scripts/mirror-push.sh [TAG]
#
# TAG 缺省 = tauri.conf.json 的版本号加 v 前缀。令牌在
# https://gitee.com/profile/personal_access_tokens 生成（勾 projects 即可）。
#
# 与 CI 镜像作业（build-windows.yml 的 mirror）同一套闸门，一条不少：
#   下载探测（MZ 头）→ sha256 指纹命名 → 应用公钥验签 → 跳过已存在附件 →
#   上传（停顿自杀 + 重试）→ 附件闸 → 删同名旧指针 → 写新指针 →
#   自检 1/2（公开指针轮询）→ 自检 2/2（真下回来验签）。
# 任何一道闸不过，退出码非 0，绝不把坏镜像发出去。
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [ -z "${GITEE_TOKEN:-}" ]; then
  echo "✗ 缺 GITEE_TOKEN 环境变量。生成地址：https://gitee.com/profile/personal_access_tokens"
  echo "  用法：GITEE_TOKEN=xxx scripts/mirror-push.sh [TAG]"
  exit 1
fi

OWNER=saber200
REPO=fantasyhub-releases
API="https://gitee.com/api/v5/repos/$OWNER/$REPO"
GH_API="https://api.github.com/repos/$OWNER/$REPO"

# ── 版本与名字 ────────────────────────────────────────────────────────────────
VERSION=${2:-}
if [ -z "$VERSION" ]; then
  VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
fi
TAG=${1:-v$VERSION}
NAME="FantasyHub_${VERSION}_x64-setup.exe"
GH_URL="https://github.com/$OWNER/$REPO/releases/download/$TAG/$NAME"
echo "=== 目标：${TAG}（${NAME}）"

WORK=$(mktemp -d /tmp/mirror-push.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# ── 从 GitHub 拿发布物（公开仓，匿名 API 就够） ──────────────────────────────
echo "--- 探测 GitHub 发行版上的 $NAME"
code=$(curl -sSL --max-time 120 -r 0-1 -o /dev/null -w '%{http_code}' "$GH_URL" || echo 000)
case "$code" in 200|206) echo "  已就绪（HTTP ${code}）" ;;
  *) echo "✗ GitHub 发行版上还没有 ${NAME}（HTTP ${code}）—— 先等构建作业发布完"; exit 1 ;;
esac

echo "--- 下载安装包与签名"
curl -sSL --fail --retry 3 --max-time 1800 -o "$WORK/$NAME" "$GH_URL" || { echo "✗ 下载 $NAME 失败"; exit 1; }
curl -sSL --fail --retry 3 --max-time 300 -o "$WORK/$NAME.sig" "$GH_URL.sig" || { echo "✗ 下载 $NAME.sig 失败"; exit 1; }
SIZE=$(stat -f%z "$WORK/$NAME" 2>/dev/null || stat -c%s "$WORK/$NAME" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 10000000 ]; then echo "✗ $NAME 只有 $SIZE 字节，不像是安装包"; exit 1; fi
if ! head -c 2 "$WORK/$NAME" | grep -q "MZ"; then echo "✗ $NAME 的文件头不是 MZ，不是 Windows 可执行文件"; exit 1; fi
echo "  下载完成：$SIZE 字节"

# ── 指纹命名 + 第一道闸：应用公钥验签 ────────────────────────────────────────
SHA256=$( (sha256sum "$WORK/$NAME" 2>/dev/null || shasum -a 256 "$WORK/$NAME") | cut -d' ' -f1)
SHORT=$(printf '%s' "$SHA256" | cut -c1-12)
GITEE_NAME="FantasyHub_${VERSION}_${SHORT}_x64-setup.exe"
GITEE_URL="https://gitee.com/$OWNER/$REPO/releases/download/$TAG/$GITEE_NAME"
echo "  sha256 $SHA256"
echo "  Gitee 附件名 $GITEE_NAME"

echo "--- 用应用里写死的公钥验这份包（掌机会不会装的唯一判据）"
node scripts/verify-update.mjs "$WORK/$NAME" "$WORK/$NAME.sig" || { echo "✗ 这份包用应用公钥验不过 —— 别镜像，先查 CI 的签名私钥/构建产物"; exit 1; }

# ── Gitee：发行版与附件 ──────────────────────────────────────────────────────
ID_OF="import json,sys; d=json.load(sys.stdin); print(d.get('id') or ('ERR '+str(d)[:200]))"
mkrel() { curl -sS --max-time 60 -X POST "$API/releases" -d "access_token=$GITEE_TOKEN" -d "tag_name=$1" -d "name=$1" -d "target_commitish=master" -d "body=Windows 安装包（国内镜像）。" | python3 -c "$ID_OF"; }
getrel() { curl -sS --max-time 60 "$API/releases/tags/$1?access_token=$GITEE_TOKEN" | python3 -c "$ID_OF"; }
RID=$(mkrel "$TAG"); case "$RID" in ''|ERR*) RID=$(getrel "$TAG");; esac
LID=$(mkrel latest); case "$LID" in ''|ERR*) LID=$(getrel latest);; esac
case "$RID" in ''|ERR*) echo "✗ Gitee 上建版本发行版失败：$RID"; exit 1;; esac
case "$LID" in ''|ERR*) echo "✗ Gitee 上建 latest 发行版失败：$LID"; exit 1;; esac
echo "版本发行版 id: $RID / latest 发行版 id: $LID"

asset_names() { curl -sS --max-time 60 "$API/releases/$1?access_token=$GITEE_TOKEN" | python3 -c "import json,sys; print(' '.join(a.get('name','') for a in json.load(sys.stdin).get('assets',[])))"; }
HAVE=$(asset_names "$RID")
echo "Gitee 上已有的附件：$HAVE"
case " $HAVE " in
  *" $NAME "*) echo "::warning::Gitee 这个发行版里还留着不带指纹的旧附件 ${NAME}（占约 72 MB）。指针不会用它，但建议到 https://gitee.com/$OWNER/$REPO/releases/tag/$TAG 手动删掉" ;;
esac

for f in "$GITEE_NAME" "$GITEE_NAME.sig"; do
  case " $HAVE " in
    *" $f "*) echo "  已存在，跳过 $f" ;;
    *) for try in 1 2 3 4 5; do
         echo "=== 第 $try 次上传 $f"
         cp -f "$( [ "$f" = "$GITEE_NAME" ] && printf '%s' "$WORK/$NAME" || printf '%s' "$WORK/$NAME.sig" )" "$WORK/$f"
         curl -sS --max-time 1800 --speed-limit 20480 --speed-time 120 -X POST "$API/releases/$RID/attach_files" -F "access_token=$GITEE_TOKEN" -F "file=@$WORK/$f" -o "$WORK/up.json" -w "  HTTP %{http_code} / %{size_upload} 字节 / %{time_total}s\n"
         grep -q '"name"' "$WORK/up.json" 2>/dev/null && break
         echo "  这一次没传上去，30 秒后换一条新连接再试"
         sleep 30
       done ;;
  esac
done

# ── 附件闸：两个附件都真传上去了，才有资格写指针 ────────────────────────────
UPLOADED=""
for probe in 1 2 3; do
  UPLOADED=$(asset_names "$RID")
  [ -n "$UPLOADED" ] && break
  echo "  附件列表第 $probe 次没读到，10 秒后再试"
  sleep 10
done
for f in "$GITEE_NAME" "$GITEE_NAME.sig"; do
  case " $UPLOADED " in
    *" $f "*) echo "  附件确认已在 Gitee 上：$f" ;;
    *) echo "✗ $f 重试后仍未出现在 Gitee 附件列表 —— 绝不写指向不存在附件的指针"; exit 1 ;;
  esac
done

# ── 指针：先删同名旧指针 → 传新的 → 公开地址轮询确认 ────────────────────────
POINTER=latest.json
ptr_count() { curl -sS --max-time 60 "$API/releases/$LID?access_token=$GITEE_TOKEN" | python3 -c "import json,sys; print(len([a for a in json.load(sys.stdin).get('assets',[]) if a.get('name')=='latest.json']))"; }
# 附件 id 只有专用列表端点才给（2026-10-15 起普通 release 视图连带 token 都只回 name/browser_download_url）
ptr_ids() { curl -sS --max-time 60 "$API/releases/$LID/attach_files?access_token=$GITEE_TOKEN" | python3 -c "import json,sys; print(' '.join(str(a.get('id','')) for a in json.load(sys.stdin) if a.get('name')=='latest.json' and a.get('id')))"; }
echo "latest 里现有的指针附件份数：$(ptr_count)"
for round in 1 2 3; do
  IDS=$(ptr_ids)
  [ -z "$IDS" ] && { echo "  第 $round 轮：没有可删的旧指针（或接口没给附件 id）"; break; }
  for id in $IDS; do
    curl -sS --max-time 60 -X DELETE "$API/releases/latest/attach_files/$id?access_token=$GITEE_TOKEN" -o /dev/null -w "  删旧指针 id=${id}（tag 形态）HTTP %{http_code}\n"
    curl -sS --max-time 60 -X DELETE "$API/releases/$LID/attach_files/$id?access_token=$GITEE_TOKEN" -o /dev/null -w "  删旧指针 id=${id}（发行版 id 形态）HTTP %{http_code}\n"
  done
  sleep 3
done
LEFT=$(ptr_count)
echo "  删完还剩 $LEFT 份同名指针（>0 = 没删掉，公开地址可能还读旧的那份）"

if [ ! -s "$WORK/$NAME.sig" ]; then echo "✗ 签名文件不存在或为空 —— 没有签名绝不写指针"; exit 1; fi
# .sig 两种形态都认：tauri-action 产出的单行 base64（解码后才是四行文本）与原生四行。
python3 -c "import base64,sys; t=open(sys.argv[1]).read().strip(); d=base64.b64decode(t+chr(61)*((-len(t))%4)).decode('utf-8','replace') if (t and chr(10) not in t) else t; sys.exit(0 if 'untrusted comment:' in d else 1)" "$WORK/$NAME.sig" || { echo "✗ $WORK/$NAME.sig 内容不像 minisign 签名"; exit 1; }
SIG=$(cat "$WORK/$NAME.sig")
python3 -c "import datetime,json,sys; e={'signature':sys.argv[1].strip(),'url':sys.argv[2]}; d={'version':sys.argv[3],'notes':'国内镜像（Gitee）。','pub_date':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'platforms':{'windows-x86_64':dict(e),'windows-x86_64-nsis':dict(e)}}; open(sys.argv[4],'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False))" "$SIG" "$GITEE_URL" "$VERSION" "$WORK/$POINTER"
echo "--- 上传指针：$(head -c 120 "$WORK/$POINTER")…"
for try in 1 2 3; do
  curl -sS --max-time 300 -X POST "$API/releases/latest/attach_files" -F "access_token=$GITEE_TOKEN" -F "file=@$WORK/$POINTER" -o "$WORK/up2.json" -w "  HTTP %{http_code} / %{time_total}s\n"
  grep -q '"name"' "$WORK/up2.json" 2>/dev/null && break
  echo "  改用发行版 id 那条路再试一次"
  curl -sS --max-time 300 -X POST "$API/releases/$LID/attach_files" -F "access_token=$GITEE_TOKEN" -F "file=@$WORK/$POINTER" -o "$WORK/up2.json" -w "  HTTP %{http_code} / %{time_total}s\n"
  grep -q '"name"' "$WORK/up2.json" 2>/dev/null && break
  sleep 10
done
grep -q '"name"' "$WORK/up2.json" 2>/dev/null || { echo "✗ 指针 latest.json 三次尝试都没传上去"; exit 1; }
AFTER=$(ptr_count)
echo "  上传后 latest.json 的份数：${AFTER}（>1 = 还有旧指针没清掉）"

# ── 自检：站到掌机的角度，把它要读的指针、要下的包整个走一遍 ────────────────
echo "=== 自检 1/2：轮询公开指针（版本号 + 附件名都要是本次这一份，最长 5 分钟）"
ok_ptr=0
for i in $(seq 1 20); do
  curl -sSL --max-time 60 "https://gitee.com/$OWNER/$REPO/releases/download/latest/latest.json?t=$(date +%s)-$i" -o "$WORK/ptr.json" -w "  第 $i 次：HTTP %{http_code}\n"
  LINE=$(python3 -c "import json;d=json.load(open('$WORK/ptr.json'));p=d.get('platforms',{}).get('windows-x86_64-nsis',{});print(d.get('version','?'),p.get('url','?'))" 2>/dev/null || echo '? ?')
  read -r GOT GOT_URL <<< "$LINE"
  ok_url=0; case "$GOT_URL" in *"/$GITEE_NAME") ok_url=1 ;; esac
  echo "  第 $i 次读到：版本 ${GOT}，附件 $(basename "$GOT_URL")"
  [ "$GOT" = "$VERSION" ] && [ "$ok_url" = "1" ] && { ok_ptr=1; break; }
  sleep 15
done
[ "$ok_ptr" = "1" ] || { echo "✗ Gitee 上的指针还不是本次这份（应到 $VERSION 且附件名 ${GITEE_NAME}）"; exit 1; }

echo "=== 自检 2/2：把用户会下到的那份包真下回来验一遍（最长 20 分钟）"
ok_served=0
for i in 1 2 3 4 5; do
  curl -sSL --fail --max-time 1200 -o "$WORK/served.exe" "$GITEE_URL?t=$(date +%s)-$i" && break
  echo "  第 $i 次没下下来，20 秒后重试"
  sleep 20
done
[ -s "$WORK/served.exe" ] || { echo "✗ Gitee 上那份包下不下来"; exit 1; }
SERVED_SHA=$( (sha256sum "$WORK/served.exe" 2>/dev/null || shasum -a 256 "$WORK/served.exe") | cut -d' ' -f1)
if [ "$SERVED_SHA" != "$SHA256" ]; then echo "✗ 用户下到的字节（${SERVED_SHA}）和验过的字节（${SHA256}）不一致"; exit 1; fi
node scripts/verify-update.mjs "$WORK/served.exe" "$WORK/ptr.json" || { echo "✗ 用应用公钥验 Gitee 实际提供的包与指针失败"; exit 1; }

echo ""
echo "✅ 国内镜像 OK（${TAG}）"
echo "   安装包：$GITEE_URL"
echo "   指针：https://gitee.com/$OWNER/$REPO/releases/download/latest/latest.json → $VERSION"
