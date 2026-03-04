#!/bin/bash
# ===================================
# 動画編集ツール セットアップ & 起動
# ダブルクリックで実行してください
# ===================================

# スクリプトのあるディレクトリに移動
cd "$(dirname "$0")"

# エラー時にウィンドウを閉じない
trap 'echo ""; echo "❌ エラーが発生しました。このウィンドウのメッセージを確認してください。"; echo "Enterを押して終了..."; read' ERR

echo ""
echo "🎬 動画編集ツールを起動します..."
echo ""

# brewのパスを確保
if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ── 1. Homebrew ──
if ! command -v brew &>/dev/null; then
    echo "📦 Homebrewをインストールしています（初回のみ）..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    echo "✅ Homebrew インストール完了"
else
    echo "✅ Homebrew: インストール済み"
fi

# ── 2. Node.js ──
if ! command -v node &>/dev/null; then
    echo "📦 Node.jsをインストールしています（初回のみ）..."
    brew install node@20
    brew link node@20 --overwrite
    echo "✅ Node.js インストール完了"
else
    echo "✅ Node.js: $(node -v)"
fi

# ── 3. FFmpeg ──
if ! command -v ffmpeg &>/dev/null; then
    echo "📦 FFmpegをインストールしています（初回のみ）..."
    brew install ffmpeg
    echo "✅ FFmpeg インストール完了"
else
    echo "✅ FFmpeg: インストール済み"
fi

# ── 4. npm install（node_modulesがなければ） ──
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    echo "📦 パッケージをインストールしています（初回のみ）..."
    npm install
    echo "✅ パッケージインストール完了"
else
    echo "✅ パッケージ: インストール済み"
fi

# ── 5. .env確認 ──
if [ -f ".env" ]; then
    echo "✅ 環境設定: 設定済み"
else
    echo "⚠️  .envファイルがありません（文字起こし機能が使えません）"
fi

# ── 環境変数読み込み ──
if [ -f ".env" ]; then
    while IFS='=' read -r key value; do
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        key=$(echo "$key" | tr -d '[:space:]' | tr -d '\r' | sed 's/\xEF\xBB\xBF//')
        value=$(echo "$value" | tr -d '\r' | sed 's/\xEF\xBB\xBF//')
        export "$key=$value"
    done < .env
fi

# ── 起動 ──
echo ""
echo "🚀 サーバーを起動しています..."
echo "   ブラウザで http://localhost:3001 を開いてください"
echo "   終了するにはこのウィンドウを閉じてください"
echo ""

# ブラウザを自動で開く
sleep 2 && open http://localhost:3001 &

npx tsx server.ts

# サーバーが停止した場合
echo ""
echo "サーバーが停止しました。Enterを押して終了..."
read
