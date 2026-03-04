#!/bin/bash
# ===================================
# 動画編集ツール セットアップ & 起動
# ダブルクリックで実行してください
# ===================================

# スクリプトのあるディレクトリに移動
cd "$(dirname "$0")"

echo ""
echo "🎬 動画編集ツールを起動します..."
echo ""

# ── 1. Homebrew ──
if ! command -v brew &>/dev/null; then
    echo "📦 Homebrewをインストールしています（初回のみ）..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Apple Silicon対応
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    echo "✅ Homebrew インストール完了"
else
    echo "✅ Homebrew: インストール済み"
fi

# brewのパスを確保
if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ── 2. Node.js ──
if ! command -v node &>/dev/null; then
    echo "📦 Node.jsをインストールしています（初回のみ）..."
    brew install node@20
    brew link node@20
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
if [ ! -d "node_modules" ]; then
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

# ── 6. .envを読み込み ──
if [ -f ".env" ]; then
    export $(cat .env | grep -v '^#' | xargs)
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
