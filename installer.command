#!/bin/bash
# =============================================
# 🎬 動画編集ツール インストーラー
# このファイルをダブルクリックするだけでOK！
# =============================================

REPO_URL="https://github.com/kot089259-hub/yolo-claude.git"
INSTALL_DIR="$HOME/video-editor"
API_KEY="__OPENAI_API_KEY__"

# エラー時にウィンドウを閉じない
trap 'echo ""; echo "❌ エラーが発生しました。このウィンドウのメッセージを確認してください。"; echo "Enterを押して終了..."; read' ERR

clear
echo ""
echo "========================================="
echo "  🎬 動画編集ツール セットアップ"
echo "========================================="
echo ""

# ── 1. Homebrew ──
if ! command -v brew &>/dev/null; then
    echo "📦 Homebrewをインストールしています..."
    echo "   （パスワードを求められたらMacのログインパスワードを入力してください）"
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    fi
    echo "✅ Homebrew インストール完了"
else
    echo "✅ Homebrew: OK"
fi

if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ── 2. Node.js ──
if ! command -v node &>/dev/null; then
    echo "📦 Node.jsをインストールしています..."
    brew install node@20
    brew link node@20 --overwrite
    echo "✅ Node.js インストール完了"
else
    echo "✅ Node.js: $(node -v)"
fi

# ── 3. FFmpeg ──
if ! command -v ffmpeg &>/dev/null; then
    echo "📦 FFmpegをインストールしています..."
    brew install ffmpeg
    echo "✅ FFmpeg インストール完了"
else
    echo "✅ FFmpeg: OK"
fi

# ── 4. リポジトリ取得 ──
if [ -d "$INSTALL_DIR" ]; then
    echo "📥 最新版に更新しています..."
    cd "$INSTALL_DIR"
    git pull origin main || true
else
    echo "📥 ダウンロードしています..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# ── 5. パッケージインストール ──
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    echo "📦 パッケージをインストールしています..."
    npm install
    echo "✅ パッケージインストール完了"
else
    echo "✅ パッケージ: OK"
fi

# ── 6. APIキー設定 ──
if [ "$API_KEY" != "__OPENAI_API_KEY__" ] && [ -n "$API_KEY" ]; then
    echo "OPENAI_API_KEY=$API_KEY" > .env
    echo "✅ APIキー: 設定済み"
elif [ -f ".env" ]; then
    echo "✅ APIキー: 設定済み"
else
    echo "⚠️  APIキー未設定（文字起こし機能は使えません）"
fi

# ── 環境変数読み込み ──
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

# ── 起動 ──
echo ""
echo "========================================="
echo "  🚀 起動中..."
echo "  ブラウザが自動で開きます"
echo "  終了するにはこのウィンドウを閉じてください"
echo "========================================="
echo ""

sleep 2 && open http://localhost:3001 &
npx tsx server.ts

# サーバーが停止した場合
echo ""
echo "サーバーが停止しました。Enterを押して終了..."
read
