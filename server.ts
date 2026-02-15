import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

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
        // 元のファイル名を保持
        cb(null, file.originalname);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
});

// 動画アップロードAPI
app.post("/api/upload", upload.single("video"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "ファイルがありません" });
        return;
    }
    res.json({
        filename: req.file.originalname,
        path: `/public/${req.file.originalname}`,
        size: req.file.size,
    });
});

// 音声文字起こしAPI（ローカルWhisper使用 - APIキー不要）
app.post("/api/transcribe", async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);
    const audioPath = path.join(
        __dirname,
        "public",
        `${path.parse(filename).name}.wav`
    );

    try {
        // 1. FFmpegで音声を抽出
        console.log("🎵 音声を抽出中...");
        execSync(
            `ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`,
            { stdio: "pipe" }
        );

        // 2. ローカルWhisperで文字起こし（APIキー不要）
        console.log("📝 ローカルWhisperで文字起こし中...(初回はモデルダウンロードがあります)");
        const scriptPath = path.join(__dirname, "transcribe.py");
        const result = execSync(
            `python3 "${scriptPath}" "${audioPath}" large`,
            { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300000 }
        );

        const transcription = JSON.parse(result.trim());

        if (transcription.error) {
            throw new Error(transcription.error);
        }

        const subtitles = transcription.subtitles || [];
        console.log(`✅ ${subtitles.length}個のセグメントを検出`);

        // 一時的な音声ファイルを削除
        fs.unlinkSync(audioPath);

        // 字幕データをJSONファイルとしても保存
        const subtitlePath = path.join(
            __dirname,
            "public",
            `${path.parse(filename).name}_subtitles.json`
        );
        fs.writeFileSync(subtitlePath, JSON.stringify(subtitles, null, 2));

        res.json({ subtitles, text: transcription.text });
    } catch (error: any) {
        console.error("❌ エラー:", error.message);
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

// MP4レンダリングAPI
app.post("/api/render", async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const baseName = path.parse(filename).name;
    const outputPath = path.join(outputDir, `${baseName}_rendered.mp4`);
    const relOutput = `output/${baseName}_rendered.mp4`;

    console.log(`🎬 レンダリング開始: ${baseName}`);

    try {
        const { execSync } = await import("child_process");
        execSync(
            `npx remotion render MyComp "${outputPath}" --codec=h264`,
            { cwd: __dirname, stdio: "inherit", timeout: 600000 }
        );
        console.log(`✅ レンダリング完了: ${relOutput}`);
        res.json({ success: true, path: relOutput, filename: `${baseName}_rendered.mp4` });
    } catch (error: any) {
        console.error("レンダリングエラー:", error.message);
        res.status(500).json({ error: "レンダリングに失敗しました: " + error.message });
    }
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
