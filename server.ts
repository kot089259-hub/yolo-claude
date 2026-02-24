import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ヘルスチェック（Render用）
app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "2026-02-24-v2" });
});

// upload.htmlをルートで配信
app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "upload.html"));
});

// 動画ファイルのアップロード先を public/ に設定
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        const dir = path.join(__dirname, "public");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (_req, file, cb) => {
        // 安全なファイル名（日本語ファイル名の文字化け・長すぎ対策）
        const ext = path.extname(file.originalname) || ".mp4";
        const safeName = `upload_${Date.now()}${ext}`;
        cb(null, safeName);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 2000 * 1024 * 1024 }, // 2GB max
});

// 動画アップロードAPI
app.post("/api/upload", upload.single("video"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "ファイルがありません" });
        return;
    }

    // multerが保存した実際のファイル名を使用（安全なファイル名: upload_xxxxx.ext）
    const savedFilename = req.file.filename;

    // current_config.json を更新して Remotion Studio が最新の動画を使うようにする
    const configPath = path.join(__dirname, "public", "current_config.json");
    fs.writeFileSync(configPath, JSON.stringify({ videoFileName: savedFilename }, null, 2));
    console.log(`📁 現在の動画を設定: ${savedFilename} (元: ${req.file.originalname})`);

    res.json({
        filename: savedFilename,
        path: `/public/${savedFilename}`,
        size: req.file.size,
    });
});

// Whisper API呼び出しヘルパー（curlで直接呼ぶ — spawnSyncで安全に実行）
function whisperTranscribe(filePath: string, apiKey: string): { text: string; segments: any[] } {
    const fileSize = fs.statSync(filePath).size;
    console.log(`📤 Whisper APIに送信中... (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    const result = spawnSync("curl", [
        "-s",
        "--connect-timeout", "60",
        "--max-time", "600",
        "-X", "POST",
        "https://api.openai.com/v1/audio/transcriptions",
        "-H", `Authorization: Bearer ${apiKey}`,
        "-F", `file=@${filePath}`,
        "-F", "model=whisper-1",
        "-F", "language=ja",
        "-F", "response_format=verbose_json",
        "-F", "prompt=日本語の音声を正確に文字起こししてください。絵文字や特殊記号は使わず、句読点を含む通常の日本語テキストのみを出力してください。"
    ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 660000 });

    // プロセスエラー（curl自体が起動できない等）
    if (result.error) {
        console.error("❌ curlプロセスエラー:", result.error.message);
        throw new Error(`curlの実行に失敗: ${result.error.message}`);
    }

    // curl終了コードチェック
    if (result.status !== 0) {
        console.error(`❌ curl終了コード: ${result.status}`);
        console.error("stderr:", result.stderr || "(空)");
        console.error("stdout:", result.stdout?.substring(0, 200) || "(空)");
        throw new Error(`curl失敗 (終了コード${result.status}): ${result.stderr || "接続エラーまたはタイムアウト"}`);
    }

    const stdout = result.stdout || "";
    if (!stdout.trim()) {
        throw new Error("APIからの応答が空です");
    }

    console.log("📥 API応答受信 (先頭100文字):", stdout.substring(0, 100));

    const data = JSON.parse(stdout);
    if (data.error) {
        throw new Error(`OpenAI APIエラー: ${data.error.message || JSON.stringify(data.error)}`);
    }
    return {
        text: data.text || "",
        segments: data.segments || [],
    };
}

// 音声文字起こしAPI（OpenAI Whisper API）
app.post("/api/transcribe", async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    if (!process.env.OPENAI_API_KEY) {
        console.log("⚠️ OPENAI_API_KEYが未設定のため、文字起こしをスキップします（プロジェクト読込で字幕を復元できます）");
        res.json({ subtitles: [], text: "" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);
    const baseName = path.parse(filename).name;
    const audioPath = path.join(__dirname, "public", `${baseName}.wav`);

    try {
        // 1. FFmpegで音声を抽出
        console.log("🎵 音声を抽出中...");
        execSync(
            `ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`,
            { stdio: "pipe" }
        );

        const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24MB（25MB制限に余裕を持たせる）
        const audioFileSize = fs.statSync(audioPath).size;
        const apiKey = process.env.OPENAI_API_KEY;

        let subtitles: any[] = [];
        let text = "";

        if (audioFileSize <= MAX_FILE_SIZE) {
            // ── ファイルサイズが25MB以下：そのままAPIに送信 ──
            console.log(
                `📝 OpenAI Whisper APIで文字起こし中... (${(audioFileSize / 1024 / 1024).toFixed(1)}MB)`
            );

            const result = await whisperTranscribe(audioPath, apiKey);
            text = result.text;
            subtitles = result.segments.map((seg: any, i: number) => ({
                index: i,
                start: Math.round(seg.start * 100) / 100,
                end: Math.round(seg.end * 100) / 100,
                text: seg.text.trim(),
            }));
        } else {
            // ── ファイルサイズが25MB超：分割してAPIに送信 ──
            const durationStr = execSync(
                `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
                { encoding: "utf-8" }
            ).trim();
            const totalDuration = parseFloat(durationStr);

            const numChunks = Math.ceil(audioFileSize / MAX_FILE_SIZE);
            const chunkDuration = Math.ceil(totalDuration / numChunks);

            console.log(
                `📝 音声ファイルが大きいため ${numChunks} 分割してAPIに送信します (${(audioFileSize / 1024 / 1024).toFixed(1)}MB, ${totalDuration.toFixed(1)}秒)`
            );

            const chunkDir = path.join(__dirname, "public", `${baseName}_chunks`);
            if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

            const allSegments: any[] = [];
            const allTexts: string[] = [];

            for (let i = 0; i < numChunks; i++) {
                const startTime = i * chunkDuration;
                const chunkPath = path.join(chunkDir, `chunk_${i}.wav`);

                execSync(
                    `ffmpeg -y -i "${audioPath}" -ss ${startTime} -t ${chunkDuration} -acodec pcm_s16le -ar 16000 -ac 1 "${chunkPath}"`,
                    { stdio: "pipe" }
                );

                console.log(`  📤 チャンク ${i + 1}/${numChunks} を送信中... (${startTime}秒〜)`);

                const result = await whisperTranscribe(chunkPath, apiKey);
                allTexts.push(result.text);

                for (const seg of result.segments) {
                    allSegments.push({
                        start: Math.round((seg.start + startTime) * 100) / 100,
                        end: Math.round((seg.end + startTime) * 100) / 100,
                        text: seg.text.trim(),
                    });
                }

                fs.unlinkSync(chunkPath);
            }

            fs.rmdirSync(chunkDir);
            text = allTexts.join("");
            subtitles = allSegments.map((seg, i) => ({ index: i, ...seg }));
        }

        console.log(`✅ OpenAI Whisper API: ${subtitles.length}個のセグメントを検出`);

        // 一時的な音声ファイルを削除
        fs.unlinkSync(audioPath);

        // 字幕データをJSONファイルとしても保存
        const subtitlePath = path.join(
            __dirname,
            "public",
            `${baseName}_subtitles.json`
        );
        fs.writeFileSync(subtitlePath, JSON.stringify(subtitles, null, 2));

        res.json({ subtitles, text });
    } catch (error: any) {
        console.error("❌ 文字起こしエラー:", error.message);
        // 一時ファイルのクリーンアップ
        if (fs.existsSync(audioPath)) {
            try { fs.unlinkSync(audioPath); } catch { }
        }
        res.status(500).json({ error: error.message });
    }
});

// 動画のメタデータを取得するAPI
app.post("/api/video-info", (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);

    try {
        const result = execSync(
            `ffprobe -v error -show_entries stream=width,height,duration,r_frame_rate -show_entries format=duration -of json "${videoPath}"`,
            { encoding: "utf-8" }
        );
        const info = JSON.parse(result);
        const videoStream = info.streams?.find(
            (s: any) => s.width && s.height
        );

        res.json({
            width: videoStream?.width || 1920,
            height: videoStream?.height || 1080,
            duration: parseFloat(info.format?.duration || videoStream?.duration || "0"),
            fps: videoStream?.r_frame_rate
                ? eval(videoStream.r_frame_rate)
                : 30,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 字幕データ保存API（手動編集後の保存用）
app.post("/api/save-subtitles", (req, res) => {
    const { filename, subtitles } = req.body;
    if (!filename || !subtitles) {
        res.status(400).json({ error: "filenameとsubtitlesが必要です" });
        return;
    }

    try {
        const baseName = path.parse(filename).name;
        const subtitlePath = path.join(
            __dirname,
            "public",
            `${baseName}_subtitles.json`
        );
        fs.writeFileSync(subtitlePath, JSON.stringify(subtitles, null, 2));
        console.log(`💾 字幕データを保存: ${baseName}_subtitles.json`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 字幕スタイル保存API
app.post("/api/save-style", (req, res) => {
    const { filename, style } = req.body;
    if (!filename || !style) {
        res.status(400).json({ error: "filenameとstyleが必要です" });
        return;
    }

    try {
        const baseName = path.parse(filename).name;
        const stylePath = path.join(
            __dirname,
            "public",
            `${baseName}_style.json`
        );
        fs.writeFileSync(stylePath, JSON.stringify(style, null, 2));
        console.log(`🎨 スタイル設定を保存: ${baseName}_style.json`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// オーディオファイルアップロードAPI
app.post("/api/upload-audio", upload.single("audio"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "ファイルが必要です" });
        return;
    }
    console.log(`🔊 音声ファイルをアップロード: ${req.file.filename}`);
    res.json({ filename: req.file.filename });
});

// オーディオトラック設定保存API
app.post("/api/save-audio", (req, res) => {
    const { filename, audioTracks } = req.body;
    if (!filename || !audioTracks) {
        res.status(400).json({ error: "filenameとaudioTracksが必要です" });
        return;
    }

    try {
        const baseName = path.parse(filename).name;
        const audioPath = path.join(
            __dirname,
            "public",
            `${baseName}_audio.json`
        );
        fs.writeFileSync(audioPath, JSON.stringify(audioTracks, null, 2));
        console.log(`🔊 オーディオ設定を保存: ${baseName}_audio.json`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 動画編集設定保存API
app.post("/api/save-edit", (req, res) => {
    const { filename, editSettings } = req.body;
    if (!filename || !editSettings) {
        res.status(400).json({ error: "filenameとeditSettingsが必要です" });
        return;
    }

    try {
        const baseName = path.parse(filename).name;
        const editPath = path.join(
            __dirname,
            "public",
            `${baseName}_edit.json`
        );
        fs.writeFileSync(editPath, JSON.stringify(editSettings, null, 2));
        console.log(`🎬 編集設定を保存: ${baseName}_edit.json`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 動画ファイルアップロードAPI（追加動画用）
app.post("/api/upload-video", upload.single("video"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "ファイルが必要です" });
        return;
    }
    console.log(`🎬 追加動画をアップロード: ${req.file.filename}`);
    res.json({ filename: req.file.filename });
});

// 画像ファイルアップロードAPI（オーバーレイ用）
app.post("/api/upload-image", upload.single("image"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "ファイルが必要です" });
        return;
    }
    console.log(`🖼️ 画像をアップロード: ${req.file.filename}`);
    res.json({ filename: req.file.filename });
});

// ── ディスク自動クリーンアップ（1時間以上前のファイルを削除） ──
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10分ごと
const MAX_FILE_AGE_MS = 60 * 60 * 1000; // 1時間

function cleanupOldFiles() {
    const now = Date.now();
    const dirs = [
        path.join(__dirname, "public"),
        path.join(__dirname, "output"),
    ];
    let deleted = 0;
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            // 設定ファイルやindex系は除外
            if (file === "current_config.json" || file === ".gitkeep") continue;
            const filePath = path.join(dir, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && (now - stat.mtimeMs) > MAX_FILE_AGE_MS) {
                    fs.unlinkSync(filePath);
                    deleted++;
                }
            } catch { }
        }
    }
    if (deleted > 0) console.log(`🧹 クリーンアップ: ${deleted}ファイル削除`);
}

setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);
console.log("🧹 自動クリーンアップ有効 (1時間以上前のファイルを10分ごとに削除)");

// ── 同時レンダリング制限 ──
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;
let previewInProgress = false;

// ── レンダリングジョブ管理（ディスク永続化 — public/ に保存） ──
function setJobStatus(jobId: string, status: any) {
    try {
        const jobPath = path.join(__dirname, "public", `${jobId}.job.json`);
        fs.writeFileSync(jobPath, JSON.stringify(status));
        console.log(`📋 ジョブ状態保存: ${jobId} → ${status.status} (${jobPath})`);
    } catch (err: any) {
        console.error(`❌ ジョブ状態保存エラー: ${jobId}`, err.message);
    }
}
function getJobStatus(jobId: string): any | null {
    const jobPath = path.join(__dirname, "public", `${jobId}.job.json`);
    const exists = fs.existsSync(jobPath);
    console.log(`🔍 ジョブ状態確認: ${jobId} → exists=${exists} (${jobPath})`);
    if (exists) return JSON.parse(fs.readFileSync(jobPath, "utf-8"));
    return null;
}

// ── プレビューレンダリング（5秒間の短いクリップ） ──
app.post("/api/preview", async (req, res) => {
    const { filename, currentTime, subtitles, subtitleStyle, editSettings } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    // 同時プレビュー制限（1件のみ）
    if (previewInProgress) {
        res.status(429).json({ error: "別のプレビューが処理中です。少々お待ちください。" });
        return;
    }
    previewInProgress = true;

    const videoPath = path.join(__dirname, "public", filename);
    if (!fs.existsSync(videoPath)) {
        previewInProgress = false;
        res.status(404).json({ error: "動画ファイルが見つかりません" });
        return;
    }

    try {
        const { generateASSFile, getVideoInfo } = await import("./ffmpegRender");
        const videoInfo = getVideoInfo(videoPath);

        // プレビュー範囲: currentTimeから5秒間
        const startTime = Math.max(0, (currentTime || 0));
        const endTime = Math.min(startTime + 5, videoInfo.duration);

        // 1080p出力サイズ計算
        const outHeight = 1080;
        const outWidth = Math.round(videoInfo.width * outHeight / videoInfo.height / 2) * 2;

        // ASS字幕生成
        const textOverlays = editSettings?.textOverlays || [];
        const subs = subtitles || [];
        const hasSubtitles = subs.length > 0 || textOverlays.length > 0;
        const previewId = `preview_${Date.now()}`;
        const previewPath = path.join(__dirname, "output", `${previewId}.mp4`);
        let assPath = "";
        let assFilter = "";

        if (hasSubtitles) {
            assPath = previewPath.replace(/\.mp4$/, ".ass");
            const assContent = generateASSFile(subs, subtitleStyle || {}, textOverlays, outWidth, outHeight);
            fs.writeFileSync(assPath, assContent, "utf-8");
            const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
            assFilter = `,ass='${escapedPath}'`;
        }

        // プレビューは720pで高速レンダリング（メモリ節約）
        const command = [
            "ffmpeg -y -threads 1",
            `-ss ${startTime}`,
            `-to ${endTime}`,
            `-i "${videoPath}"`,
            `-vf "scale=-2:720${assFilter}"`,
            "-c:v libx264 -preset ultrafast -crf 32",
            "-c:a aac -b:a 64k",
            "-movflags +faststart",
            `"${previewPath}"`,
        ].join(" ");

        console.log(`👁️ プレビュー生成: ${startTime.toFixed(1)}s〜${endTime.toFixed(1)}s`);

        // 非同期で実行（イベントループをブロックしない）
        const { exec } = await import("child_process");
        exec(command, { timeout: 30000 }, (error) => {
            previewInProgress = false;

            // ASSファイル削除
            if (assPath && fs.existsSync(assPath)) {
                try { fs.unlinkSync(assPath); } catch { }
            }

            if (error) {
                console.error("❌ プレビューエラー:", error.message);
                res.status(500).json({ error: "プレビュー生成に失敗しました" });
                return;
            }

            // プレビュー動画を返す
            res.sendFile(previewPath, () => {
                try { fs.unlinkSync(previewPath); } catch { }
            });
        });

    } catch (error: any) {
        previewInProgress = false;
        console.error("❌ プレビューエラー:", error.message);
        res.status(500).json({ error: "プレビュー生成に失敗しました" });
    }
});

// MP4レンダリングAPI（非同期 — FFmpegをバックグラウンドで実行）
app.post("/api/render", async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    // 同時レンダリング数チェック
    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
        res.status(429).json({ error: `現在${activeRenders}件のレンダリングが実行中です。しばらくお待ちください。` });
        return;
    }
    activeRenders++;

    const baseName = path.parse(filename).name;
    const jobId = `${baseName}_${Date.now()}`;
    setJobStatus(jobId, { status: "rendering" });

    console.log(`🎬 レンダリングジョブ受付 (job: ${jobId})`);

    // ★ 先にレスポンスを返す
    res.json({ jobId });

    // ★ 重い処理はレスポンス送信後に非同期で実行
    setImmediate(async () => {
        try {
            const outputDir = path.join(__dirname, "output");
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

            const videoPath = path.join(__dirname, "public", filename);
            const outputPath = path.join(outputDir, `${baseName}_rendered.mp4`);
            const relOutput = `output/${baseName}_rendered.mp4`;
            const publicDir = path.join(__dirname, "public");

            // 設定ファイル読み込み
            const readJSON = (suffix: string) => {
                const p = path.join(publicDir, `${baseName}${suffix}`);
                if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
                return null;
            };

            const subtitles = readJSON("_subtitles.json") || [];
            const subtitleStyle = readJSON("_style.json") || undefined;
            const editSettings = readJSON("_edit.json") || {};

            console.log(`🔧 FFmpeg軽量モード準備中 (job: ${jobId})...`);

            // ★ 軽量モード: 複雑なフィルターを使わず、字幕+720pのみ
            const { generateASSFile, getVideoInfo } = await import("./ffmpegRender");

            const videoInfo = getVideoInfo(videoPath);
            console.log(`📐 動画情報: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}秒`);

            // ASS字幕生成（字幕がある場合のみ）
            // ★ 1080p出力に合わせたASS解像度を計算（文字が小さくならないように）
            const outHeight = 1080;
            const outWidth = Math.round(videoInfo.width * outHeight / videoInfo.height / 2) * 2; // 偶数に丸め
            const textOverlays = editSettings.textOverlays || [];
            const hasSubtitles = subtitles.length > 0 || textOverlays.length > 0;
            let assPath = "";
            let assFilter = "";

            if (hasSubtitles) {
                assPath = outputPath.replace(/\.mp4$/, ".ass");
                const assContent = generateASSFile(
                    subtitles,
                    subtitleStyle || {},
                    textOverlays,
                    outWidth,
                    outHeight
                );
                fs.writeFileSync(assPath, assContent, "utf-8");
                const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
                assFilter = `,ass='${escapedPath}'`;
            }

            // トリム
            const trimArgs: string[] = [];
            if (editSettings.trim?.startTime && editSettings.trim.startTime > 0) {
                trimArgs.push(`-ss ${editSettings.trim.startTime}`);
            }
            if (editSettings.trim?.endTime) {
                trimArgs.push(`-to ${editSettings.trim.endTime}`);
            }

            // ★ シンプルなFFmpegコマンド（1080p + 字幕）
            const command = [
                "ffmpeg -y",
                ...trimArgs,
                `-i "${videoPath}"`,
                `-vf "scale=-2:1080${assFilter}"`,
                "-c:v libx264 -preset fast -crf 23",
                "-c:a aac -b:a 128k",
                "-movflags +faststart",
                `"${outputPath}"`,
            ].join(" ");

            console.log(`🎬 FFmpeg実行開始 (job: ${jobId})`);
            console.log(`   CMD: ${command.slice(0, 200)}...`);

            // ★ spawn を使用（exec と違い出力をメモリにバッファリングしない）
            const { spawn } = await import("child_process");
            const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });

            child.stderr?.on("data", (data: Buffer) => {
                const str = data.toString();
                if (str.includes("frame=") || str.includes("Error") || str.includes("error")) {
                    console.log(`  [ffmpeg] ${str.trim().slice(0, 120)}`);
                }
            });

            child.on("close", (code: number | null) => {
                activeRenders--;
                if (fs.existsSync(assPath)) {
                    try { fs.unlinkSync(assPath); } catch { }
                }
                if (code === 0) {
                    console.log(`✅ レンダリング完了 (job: ${jobId})`);
                    setJobStatus(jobId, {
                        status: "done",
                        path: relOutput,
                        filename: `${baseName}_rendered.mp4`,
                    });
                } else {
                    console.error(`❌ FFmpeg終了コード: ${code} (job: ${jobId})`);
                    setJobStatus(jobId, {
                        status: "error",
                        error: `FFmpegがエラーコード ${code} で終了しました`,
                    });
                }
            });

            child.on("error", (err: Error) => {
                activeRenders--;
                console.error(`❌ FFmpegエラー (job: ${jobId}):`, err.message);
                setJobStatus(jobId, { status: "error", error: err.message });
            });

        } catch (error: any) {
            activeRenders--;
            console.error(`❌ レンダリング準備エラー (job: ${jobId}):`, error.message);
            setJobStatus(jobId, { status: "error", error: error.message });
        }
    });
});

// レンダリングステータス確認API（ディスクから読み込み — 再起動に耐える）
app.get("/api/render-status/:jobId", (req, res) => {
    const job = getJobStatus(req.params.jobId);
    if (!job) {
        res.status(404).json({ error: "ジョブが見つかりません" });
        return;
    }
    res.json(job);
});

// レンダリング済みファイルを配信
app.use("/output", express.static(path.join(__dirname, "output")));

// 字幕エクスポートAPI (SRT / VTT)
app.post("/api/export-subtitles", (req, res) => {
    const { subtitles, format } = req.body;
    if (!subtitles || !format) {
        res.status(400).json({ error: "subtitlesとformat(srt/vtt)が必要です" });
        return;
    }

    const formatTime = (seconds: number, sep: string) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms).padStart(3, "0")}`;
    };

    let content = "";

    if (format === "srt") {
        content = subtitles
            .map((sub: any, i: number) => {
                return `${i + 1}\n${formatTime(sub.start, ",")} --> ${formatTime(sub.end, ",")}\n${sub.text}\n`;
            })
            .join("\n");
    } else if (format === "vtt") {
        content = "WEBVTT\n\n";
        content += subtitles
            .map((sub: any, i: number) => {
                return `${i + 1}\n${formatTime(sub.start, ".")} --> ${formatTime(sub.end, ".")}\n${sub.text}\n`;
            })
            .join("\n");
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
});

// サムネイル生成API
app.post("/api/thumbnail", async (req, res) => {
    const { filename, time } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);
    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const baseName = path.parse(filename).name;
    const thumbName = `${baseName}_thumb.jpg`;
    const thumbPath = path.join(outputDir, thumbName);
    const timestamp = time || 0;

    try {
        const { execSync } = await import("child_process");
        execSync(
            `ffmpeg -y -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 "${thumbPath}"`,
            { stdio: "pipe" }
        );
        console.log(`🖼️ サムネイル生成: ${thumbName} (${timestamp}秒)`);
        res.json({ success: true, path: `output/${thumbName}`, filename: thumbName });
    } catch (error: any) {
        res.status(500).json({ error: "サムネイル生成に失敗: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
});
