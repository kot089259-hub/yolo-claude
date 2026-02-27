import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { exec, execSync, spawnSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);

// "30000/1001" 形式のFPS文字列を安全にパース（eval()を使わない）
function parseFraction(str: string): number {
    const parts = str.split("/");
    if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (den !== 0) return num / den;
    }
    const n = parseFloat(str);
    return isNaN(n) ? 30 : n;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ── クラッシュ防止: 未処理エラーのキャッチ ──
process.on("uncaughtException", (err) => {
    console.error("🔥 未処理の例外:", err.message);
    console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
    console.error("🔥 未処理のPromise拒否:", reason);
});

// ── 出力ディレクトリの確保 ──
const outputDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── タイムスタンプ付きログ ──
const log = (emoji: string, ...args: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${emoji}`, ...args);
};

// ── レートリミット（IP単位: 60リクエスト/分） ──
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const requests = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (requests.length >= RATE_LIMIT) {
        res.status(429).json({ error: "リクエストが多すぎます。1分後にお試しください。" });
        return;
    }
    requests.push(now);
    if (requests.length > 0) {
        rateLimitMap.set(ip, requests);
    } else {
        rateLimitMap.delete(ip);
    }
    next();
});

// 定期的に空エントリを掃除（5分毎）
setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of rateLimitMap) {
        const valid = times.filter(t => now - t < RATE_WINDOW_MS);
        if (valid.length === 0) rateLimitMap.delete(ip);
        else rateLimitMap.set(ip, valid);
    }
}, 5 * 60 * 1000);

// ── リクエストタイムアウト（5分） ──
app.use((_req, res, next) => {
    res.setTimeout(5 * 60 * 1000, () => {
        res.status(408).json({ error: "リクエストがタイムアウトしました" });
    });
    next();
});

// ── ファイル名サニタイズ関数（パス走査防止） ──
function sanitizeFilename(filename: string): string {
    // パスセパレータを除去、先頭ドットも除去
    return path.basename(filename).replace(/^\.+/, "").replace(/[<>:"|?*]/g, "_");
}

// ── ディスク容量チェック ──
async function checkDiskSpace(): Promise<{ available: boolean; freeMB: number }> {
    try {
        const { stdout } = await execAsync(`df -m "${__dirname}"`);
        const lines = stdout.split("\n");
        if (lines.length >= 2) {
            const parts = lines[1].split(/\s+/);
            const freeMB = parseInt(parts[3], 10);
            return { available: freeMB > 100, freeMB }; // 100MB以上で利用可能
        }
    } catch { }
    return { available: true, freeMB: -1 }; // チェック失敗時は許可
}

// ── メモリ監視（400MB超過でクリーンアップ強制実行） ──
const MEMORY_THRESHOLD_MB = 400;
setInterval(() => {
    const rss = process.memoryUsage().rss / 1024 / 1024;
    if (rss > MEMORY_THRESHOLD_MB) {
        log("⚠️", `メモリ使用量 ${Math.round(rss)}MB > ${MEMORY_THRESHOLD_MB}MB — クリーンアップ実行`);
        if (typeof cleanupOldFiles === "function") cleanupOldFiles();
        if (global.gc) global.gc(); // --expose-gc フラグ有効時のみ
    }
}, 30 * 1000); // 30秒ごと

// ── ハードウェアエンコーダ検出（macOS VideoToolbox） ──
let useHWEncoder = false;
let hwEncoderName = "";
try {
    const encoders = execSync("ffmpeg -encoders 2>/dev/null", { encoding: "utf-8" });
    if (encoders.includes("h264_videotoolbox")) {
        useHWEncoder = true;
        hwEncoderName = "h264_videotoolbox";
        console.log("🚀 ハードウェアエンコーダ検出: h264_videotoolbox (M-chip GPU加速)");
    }
} catch {
    console.log("ℹ️ FFmpegエンコーダ検出スキップ — ソフトウェアエンコードを使用");
}

// ── 同時レンダリング制限（早期宣言 — ヘルスチェックで参照） ──
const MAX_CONCURRENT_RENDERS = 4;
let activeRenders = 0;
let previewInProgress = false;

// ── レンダリングキュー ──
interface QueuedJob {
    jobId: string;
    filename: string;
}
const renderQueue: QueuedJob[] = [];

function processQueue() {
    while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
        const job = renderQueue.shift()!;
        // キュー内の残りジョブのpositionを更新
        renderQueue.forEach((j, idx) => {
            setJobStatus(j.jobId, { status: "queued", position: idx + 1 });
        });
        executeRender(job.jobId, job.filename);
    }
}

// ── ヘルスチェック（Render用 — 詳細情報付き）──
app.get("/health", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: "ok",
        version: "2026-02-27-v2",
        uptime: Math.round(process.uptime()),
        memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        activeRenders,
        previewInProgress,
    });
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

// Whisper API呼び出しヘルパー（リトライ付き）
const WHISPER_MAX_RETRIES = 3;
async function whisperTranscribe(filePath: string, apiKey: string): Promise<{ text: string; segments: any[] }> {
    const fileSize = fs.statSync(filePath).size;
    let lastError = "";

    for (let attempt = 1; attempt <= WHISPER_MAX_RETRIES; attempt++) {
        console.log(`📤 Whisper API送信... (${(fileSize / 1024 / 1024).toFixed(1)}MB, 試行${attempt}/${WHISPER_MAX_RETRIES})`);

        try {
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

            if (result.error) {
                throw new Error(`curlの実行に失敗: ${result.error.message}`);
            }
            if (result.status !== 0) {
                throw new Error(`curl失敗 (終了コード${result.status}): ${result.stderr || "接続エラー"}`);
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
        } catch (err: any) {
            lastError = err.message;
            console.error(`⚠️ Whisper API 試行${attempt}失敗:`, lastError);
            if (attempt < WHISPER_MAX_RETRIES) {
                console.log(`🔄 ${3}秒後にリトライ...`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    throw new Error(`Whisper API ${WHISPER_MAX_RETRIES}回失敗: ${lastError}`);
}

// ── セグメント分割位置のスコアリング ──
function scoreSplitPosition(text: string, pos: number): number {
    if (pos <= 0 || pos >= text.length) return -1;
    const before = text[pos - 1];

    // 文末句読点の後
    if ('。！？!?'.includes(before)) return 100;
    // 読点・カンマの後
    if ('、,，'.includes(before)) return 80;
    // 閉じ括弧の後
    if ('」』）】'.includes(before)) return 75;

    // 複数文字の接続表現の後
    const lookback = text.slice(Math.max(0, pos - 4), pos);
    const connectors3 = ['けれど', 'ながら', 'ですが', 'ますが', 'ところ', 'ように'];
    for (const c of connectors3) {
        if (lookback.endsWith(c)) return 70;
    }
    const connectors2 = ['けど', 'から', 'ので', 'のに', 'ても', 'って', 'たら', 'まで', 'より', 'ます', 'です', 'した', 'する', 'ある', 'いる', 'ない', 'った'];
    for (const c of connectors2) {
        if (lookback.endsWith(c)) return 65;
    }

    // 助詞の後（前が漢字・カタカナのとき）
    if ('はがをにでともへの'.includes(before) && pos >= 2) {
        const prev = text[pos - 2];
        const code = prev.codePointAt(0) || 0;
        const isKanjiOrKata =
            (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0x30A0 && code <= 0x30FF) ||
            (code >= 0x3400 && code <= 0x4DBF);
        if (isKanjiOrKata) return 50;
    }

    return 0;
}

// ── セグメント後処理: 全ての文法的区切り（句読点・接続表現）で分割 ──
function splitAtGrammarBoundaries(segments: any[]): any[] {
    const result: any[] = [];

    for (const seg of segments) {
        const text = seg.text.trim();
        const duration = seg.end - seg.start;

        if (text.length <= 3) {
            result.push(seg);
            continue;
        }

        // テキスト内の全ての文法的区切り位置を検出
        const splitPoints: number[] = [];
        for (let i = 1; i < text.length; i++) {
            const before = text[i - 1];

            // 句読点の後
            if ('。！？!?'.includes(before)) { splitPoints.push(i); continue; }
            if ('、,，'.includes(before)) { splitPoints.push(i); continue; }
            if ('」』）】'.includes(before)) { splitPoints.push(i); continue; }

            // 接続表現の後
            const lookback = text.slice(Math.max(0, i - 4), i);
            const connectors = ['けれど', 'ながら', 'ですが', 'ますが', 'ところ', 'ように',
                                'けど', 'から', 'ので', 'のに', 'ても', 'って', 'たら', 'まで',
                                'ます', 'です', 'した', 'する', 'ない', 'った'];
            if (connectors.some(c => lookback.endsWith(c))) {
                // 直前の句読点と重複しないようチェック
                if (splitPoints.length === 0 || splitPoints[splitPoints.length - 1] !== i) {
                    splitPoints.push(i);
                }
            }
        }

        // 区切り位置がなければそのまま
        if (splitPoints.length === 0) {
            result.push(seg);
            continue;
        }

        // テキストを各区切りで分割し、時間を文字数比率で按分
        const parts: string[] = [];
        let prevIdx = 0;
        for (const sp of splitPoints) {
            const part = text.slice(prevIdx, sp).trim();
            if (part) parts.push(part);
            prevIdx = sp;
        }
        const lastPart = text.slice(prevIdx).trim();
        if (lastPart) parts.push(lastPart);

        if (parts.length <= 1) {
            result.push(seg);
            continue;
        }

        const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
        let currentTime = seg.start;

        for (let i = 0; i < parts.length; i++) {
            const ratio = parts[i].length / totalChars;
            const partEnd = i === parts.length - 1
                ? seg.end
                : Math.round((currentTime + duration * ratio) * 100) / 100;
            result.push({
                start: Math.round(currentTime * 100) / 100,
                end: partEnd,
                text: parts[i],
            });
            currentTime = partEnd;
        }
    }

    return result.map((seg, i) => ({ ...seg, index: i }));
}

// ── セグメント後処理: 短すぎるセグメントを前後と結合 ──
function mergeShortSegments(segments: any[], minDuration = 1.5, minChars = 8, maxMergedDuration = 5.0, maxMergedChars = 35): any[] {
    if (segments.length <= 1) return segments;

    const result: any[] = [];

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const duration = seg.end - seg.start;
        const text = seg.text.trim();

        // 短すぎるセグメント（時間 or 文字数）を検出
        const isTooShort = duration < minDuration || text.length < minChars;

        if (!isTooShort || result.length === 0) {
            result.push({ ...seg });
            continue;
        }

        // 前のセグメントと結合を試みる
        const prev = result[result.length - 1];
        const gapToPrev = seg.start - prev.end;
        const mergedWithPrevDuration = seg.end - prev.start;
        const mergedWithPrevChars = prev.text.trim().length + text.length;

        // 次のセグメントとの結合候補
        const next = i + 1 < segments.length ? segments[i + 1] : null;
        const gapToNext = next ? next.start - seg.end : Infinity;

        // 前と結合: 間隔が短く、結合後の制限内
        if (gapToPrev < 0.3 &&
            mergedWithPrevDuration <= maxMergedDuration &&
            mergedWithPrevChars <= maxMergedChars) {
            prev.end = seg.end;
            prev.text = prev.text.trim() + text;
            continue;
        }

        // 次と結合: 次のセグメントがあり、間隔が短い場合
        if (next && gapToNext < 0.3) {
            const mergedWithNextDuration = next.end - seg.start;
            const mergedWithNextChars = text.length + next.text.trim().length;
            if (mergedWithNextDuration <= maxMergedDuration &&
                mergedWithNextChars <= maxMergedChars) {
                // 次のセグメントに現セグメントのテキストを前置
                segments[i + 1] = {
                    ...next,
                    start: seg.start,
                    text: text + next.text.trim(),
                };
                continue;
            }
        }

        // 結合できない場合はそのまま追加
        result.push({ ...seg });
    }

    return result.map((seg, i) => ({ ...seg, index: i }));
}

// 音声文字起こしAPI（OpenAI Whisper API）
app.post("/api/transcribe", async (req, res) => {
    const rawFilename = req.body.filename;
    if (!rawFilename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }
    const filename = sanitizeFilename(rawFilename);

    if (!process.env.OPENAI_API_KEY) {
        console.log("⚠️ OPENAI_API_KEYが未設定のため、文字起こしをスキップします（プロジェクト読込で字幕を復元できます）");
        res.json({ subtitles: [], text: "" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);
    const baseName = path.parse(filename).name;
    const audioPath = path.join(__dirname, "public", `${baseName}.wav`);

    try {
        // 1. FFmpegで音声を抽出（非同期 — 他リクエストをブロックしない）
        console.log("🎵 音声を抽出中...");
        await execAsync(
            `ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`,
            { maxBuffer: 10 * 1024 * 1024 }
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
            const { stdout: durationStdout } = await execAsync(
                `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`
            );
            const durationStr = durationStdout.trim();
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

                await execAsync(
                    `ffmpeg -y -i "${audioPath}" -ss ${startTime} -t ${chunkDuration} -acodec pcm_s16le -ar 16000 -ac 1 "${chunkPath}"`,
                    { maxBuffer: 10 * 1024 * 1024 }
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
        console.log(`📋 Whisper生データ(先頭5件):`, subtitles.slice(0, 5).map((s: any) => `[${s.start}-${s.end}] "${s.text}" (${s.text.length}字, ${(s.end-s.start).toFixed(1)}s)`));

        // 1. 短すぎるセグメントを前後と結合（Whisperの過剰分割を修正）
        const beforeMerge = subtitles.length;
        subtitles = mergeShortSegments(subtitles);
        console.log(`🔗 セグメント結合: ${beforeMerge}個 → ${subtitles.length}個`);
        console.log(`📋 結合後(先頭5件):`, subtitles.slice(0, 5).map((s: any) => `[${s.start}-${s.end}] "${s.text}" (${s.text.length}字, ${(s.end-s.start).toFixed(1)}s)`));

        // 2. 文法的な区切り（句読点、接続表現）で分割
        const beforeSplit = subtitles.length;
        subtitles = splitAtGrammarBoundaries(subtitles);
        console.log(`✂️ 文法分割: ${beforeSplit}個 → ${subtitles.length}個`);
        console.log(`📋 分割後(先頭5件):`, subtitles.slice(0, 5).map((s: any) => `[${s.start}-${s.end}] "${s.text}" (${s.text.length}字, ${(s.end-s.start).toFixed(1)}s)`));

        // 3. 分割で短くなりすぎたセグメントを再結合
        const beforeReMerge = subtitles.length;
        subtitles = mergeShortSegments(subtitles);
        if (subtitles.length !== beforeReMerge) {
            console.log(`🔗 再結合: ${beforeReMerge}個 → ${subtitles.length}個`);
        }

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
app.post("/api/video-info", async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }

    const videoPath = path.join(__dirname, "public", filename);

    try {
        const { stdout } = await execAsync(
            `ffprobe -v error -show_entries stream=width,height,duration,r_frame_rate -show_entries format=duration -of json "${videoPath}"`
        );
        const info = JSON.parse(stdout);
        const videoStream = info.streams?.find(
            (s: any) => s.width && s.height
        );

        res.json({
            width: videoStream?.width || 1920,
            height: videoStream?.height || 1080,
            duration: parseFloat(info.format?.duration || videoStream?.duration || "0"),
            fps: videoStream?.r_frame_rate
                ? parseFraction(videoStream.r_frame_rate)
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



// ── レンダリングジョブ管理（ディスク永続化 — public/ に保存） ──
function setJobStatus(jobId: string, status: any) {
    try {
        const jobPath = path.join(__dirname, "public", `${jobId}.job.json`);
        fs.writeFileSync(jobPath, JSON.stringify(status));
        // 進捗更新のログは抑制（ノイズ防止）
        if (status.progress === undefined) {
            console.log(`📋 ジョブ状態保存: ${jobId} → ${status.status} (${jobPath})`);
        }
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

        // プレビューは720p — 縦動画対応でスケール軸を動的に選択
        const isVertical = videoInfo.height > videoInfo.width;
        let outWidth: number, outHeight: number, scaleFilter: string;
        if (isVertical) {
            outWidth = Math.min(720, videoInfo.width);
            outWidth = Math.round(outWidth / 2) * 2;
            outHeight = Math.round(videoInfo.height * outWidth / videoInfo.width / 2) * 2;
            scaleFilter = `scale=${outWidth}:-2`;
        } else {
            outHeight = 720;
            outWidth = Math.round(videoInfo.width * outHeight / videoInfo.height / 2) * 2;
            scaleFilter = `scale=-2:720`;
        }

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
            `-vf "${scaleFilter}${assFilter}"`,
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

// ── executeRender: レンダリング実行関数（キューから呼ばれる） ──
function executeRender(jobId: string, filename: string) {
    activeRenders++;
    setJobStatus(jobId, { status: "rendering" });
    console.log(`🎬 レンダリング実行開始 (job: ${jobId}, active: ${activeRenders}/${MAX_CONCURRENT_RENDERS})`);

    setImmediate(async () => {
        const baseName = path.parse(filename).name;
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
            const audioTracks: { filename: string; startTime: number; volume: number }[] = readJSON("_audio.json") || [];

            console.log(`🔧 FFmpeg軽量モード準備中 (job: ${jobId})...`);

            const { generateASSFile, getVideoInfo } = await import("./ffmpegRender");

            const videoInfo = getVideoInfo(videoPath);
            console.log(`📐 動画情報: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}秒`);

            // ★ 1080p出力 — 縦動画対応でスケール軸を動的に選択
            const isVertical = videoInfo.height > videoInfo.width;
            let outWidth: number, outHeight: number, scaleFilter: string;
            if (isVertical) {
                outWidth = Math.min(1080, videoInfo.width);
                outWidth = Math.round(outWidth / 2) * 2;
                outHeight = Math.round(videoInfo.height * outWidth / videoInfo.width / 2) * 2;
                scaleFilter = `scale=${outWidth}:-2`;
            } else {
                outHeight = 1080;
                outWidth = Math.round(videoInfo.width * outHeight / videoInfo.height / 2) * 2;
                scaleFilter = `scale=-2:1080`;
            }

            console.log(`📐 レンダリング: ${videoInfo.width}x${videoInfo.height} → ${outWidth}x${outHeight} (${isVertical ? '縦' : '横'})`);
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

            // ★ ビデオフィルターチェーン構築
            const videoFilters: string[] = [];

            // スケーリング（常に適用）
            videoFilters.push(scaleFilter);

            // 字幕（ASS）
            if (assFilter) {
                videoFilters.push(assFilter.replace(/^,/, ''));
            }

            // 再生速度（1.0以外の場合）
            const speed = editSettings.speedSections?.[0]?.speed;
            if (speed && speed !== 1) {
                videoFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
            }

            // フィルター（明るさ・コントラスト・彩度・色相・セピア・グレースケール・ブラー）
            const f = editSettings.filters;
            if (f) {
                const eqParts: string[] = [];
                if (f.brightness && f.brightness !== 100) {
                    eqParts.push(`brightness=${((f.brightness - 100) / 100).toFixed(2)}`);
                }
                if (f.contrast && f.contrast !== 100) {
                    eqParts.push(`contrast=${(f.contrast / 100).toFixed(2)}`);
                }
                if (f.saturate && f.saturate !== 100) {
                    eqParts.push(`saturation=${(f.saturate / 100).toFixed(2)}`);
                }
                if (eqParts.length > 0) {
                    videoFilters.push(`eq=${eqParts.join(':')}`);
                }
                if (f.hueRotate && f.hueRotate !== 0) {
                    videoFilters.push(`hue=h=${f.hueRotate}`);
                }
                if (f.sepia && f.sepia > 0) {
                    // セピア近似: 彩度下げ + 暖色化
                    const sepiaStr = (f.sepia / 100).toFixed(2);
                    videoFilters.push(`colorbalance=rs=${sepiaStr}:gs=${(f.sepia * 0.5 / 100).toFixed(2)}:bs=-${sepiaStr}`);
                }
                if (f.grayscale && f.grayscale > 0) {
                    if (f.grayscale >= 100) {
                        videoFilters.push(`format=gray,format=yuv420p`);
                    } else {
                        videoFilters.push(`eq=saturation=${(1 - f.grayscale / 100).toFixed(2)}`);
                    }
                }
                if (f.blur && f.blur > 0) {
                    const sigma = Math.max(1, Math.round(f.blur * 2));
                    videoFilters.push(`gblur=sigma=${sigma}`);
                }
            }

            // Ken Burns（ズーム + パン）
            const kb = editSettings.kenBurns;
            if (kb?.enabled) {
                const ss = kb.startScale || 1.0;
                const es = kb.endScale || 1.2;
                const sx = kb.startX || 0;
                const ex = kb.endX || 0;
                const sy = kb.startY || 0;
                const ey = kb.endY || 0;
                // zoompanフィルタ: ズームとパンを同時制御
                videoFilters.push(
                    `zoompan=z='${ss.toFixed(2)}+(${(es - ss).toFixed(4)})*on/duration*1':x='iw/2-(iw/zoom/2)+(${sx}+(${ex}-${sx})*on/duration*1)*iw/100':y='ih/2-(ih/zoom/2)+(${sy}+(${ey}-${sy})*on/duration*1)*ih/100':d=1:s=${outWidth}x${outHeight}:fps=${videoInfo.fps || 30}`
                );
            }

            // フェードイン/アウト
            const fadeIn = editSettings.transition?.fadeIn;
            const fadeOut = editSettings.transition?.fadeOut;
            if (fadeIn && fadeIn > 0) {
                videoFilters.push(`fade=t=in:st=0:d=${fadeIn}`);
            }
            if (fadeOut && fadeOut > 0) {
                // フェードアウトは動画の最後からの相対位置
                const duration = videoInfo.duration || 60;
                const trimEnd = editSettings.trim?.endTime || duration;
                const trimStart = editSettings.trim?.startTime || 0;
                const effectiveDuration = trimEnd - trimStart;
                const fadeOutStart = Math.max(0, effectiveDuration - fadeOut);
                videoFilters.push(`fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOut}`);
            }

            // ★ 音声フィルター + 追加音声トラック構築
            const audioInputs: string[] = [];
            const audioFilterParts: string[] = [];
            let hasAudioMix = false;

            // 再生速度が変わる場合は音声テンポも変更
            let mainAudioFilter = "";
            if (speed && speed !== 1) {
                mainAudioFilter = `atempo=${speed}`;
            }
            // 音声フェード
            const afadeParts: string[] = [];
            if (fadeIn && fadeIn > 0) {
                afadeParts.push(`afade=t=in:st=0:d=${fadeIn}`);
            }
            if (fadeOut && fadeOut > 0) {
                const duration = videoInfo.duration || 60;
                const trimEnd = editSettings.trim?.endTime || duration;
                const trimStart = editSettings.trim?.startTime || 0;
                const effectiveDuration = trimEnd - trimStart;
                const fadeOutStart = Math.max(0, effectiveDuration - fadeOut);
                afadeParts.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOut}`);
            }
            if (mainAudioFilter) afadeParts.unshift(mainAudioFilter);

            // 追加音声トラック
            const validAudioTracks: typeof audioTracks = [];
            for (const track of audioTracks) {
                const trackPath = path.join(publicDir, track.filename);
                if (fs.existsSync(trackPath)) {
                    audioInputs.push(`-i "${trackPath}"`);
                    validAudioTracks.push(track);
                } else {
                    console.warn(`⚠️ 音声トラックが見つかりません: ${track.filename}`);
                }
            }

            // ★ filter_complex 構築（音声トラックがある場合は必須）
            let filterArg = "";
            let mapArgs = "";

            if (validAudioTracks.length > 0) {
                // filter_complex に映像・音声フィルターを統合
                const complexParts: string[] = [];

                // 映像チェーン: [0:v] → filters → [vout]
                complexParts.push(`[0:v]${videoFilters.join(',')}[vout]`);

                // 元動画の音声
                const mainAudioChain = afadeParts.length > 0 ? afadeParts.join(',') : 'volume=1.0';
                complexParts.push(`[0:a]${mainAudioChain}[a0]`);

                // 追加音声トラック
                for (let i = 0; i < validAudioTracks.length; i++) {
                    const t = validAudioTracks[i];
                    const inputIdx = i + 1;
                    const delayMs = Math.round((t.startTime || 0) * 1000);
                    const vol = t.volume ?? 1.0;
                    complexParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${vol}[a${inputIdx}]`);
                }

                // amixで全音声を合成
                const amixInputs = Array.from({ length: validAudioTracks.length + 1 }, (_, i) => `[a${i}]`).join('');
                complexParts.push(`${amixInputs}amix=inputs=${validAudioTracks.length + 1}:duration=longest:dropout_transition=0[aout]`);

                filterArg = `-filter_complex "${complexParts.join(';')}"`;
                mapArgs = '-map "[vout]" -map "[aout]"';
            } else {
                // 音声トラックなし → 通常の -vf + 音声フィルター
                filterArg = `-vf "${videoFilters.join(',')}"`;
                if (afadeParts.length > 0) {
                    filterArg += ` -af "${afadeParts.join(',')}"`;
                }
            }

            // ★ FFmpegコマンド（1080p + 字幕 + 編集設定）— HWエンコーダ優先
            // VideoToolbox: -q:v 1(最高品質)〜100(最低品質)、35=高品質
            const hwAccelDecode = useHWEncoder ? "-hwaccel videotoolbox" : "";
            const videoCodec = useHWEncoder
                ? `-c:v ${hwEncoderName} -q:v 35 -allow_sw 1`
                : "-c:v libx264 -preset medium -crf 18";
            const command = [
                "ffmpeg -y",
                hwAccelDecode,
                "-threads 0",
                "-progress pipe:1",
                ...trimArgs,
                `-i "${videoPath}"`,
                ...audioInputs,
                filterArg,
                mapArgs,
                videoCodec,
                "-c:a aac -b:a 192k",
                "-movflags +faststart",
                `"${outputPath}"`,
            ].filter(Boolean).join(" ");

            console.log(`🎬 FFmpeg実行開始 (job: ${jobId})`);
            console.log(`   CMD: ${command.slice(0, 200)}...`);

            // ★ spawn を使用（exec と違い出力をメモリにバッファリングしない）
            const { spawn } = await import("child_process");
            const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });

            // FFmpegタイムアウト（10分）
            const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
            let killed = false;
            const timer = setTimeout(() => {
                killed = true;
                console.error(`⏰ FFmpegタイムアウト (job: ${jobId}) — プロセスを強制終了`);
                child.kill("SIGKILL");
            }, FFMPEG_TIMEOUT_MS);

            // FFmpeg進捗パーシング（-progress pipe:1 のstdout + stderrの両方から取得）
            const totalDuration = videoInfo.duration;
            let lastProgressUpdate = 0;

            const updateProgress = (currentTimeSec: number) => {
                if (totalDuration <= 0) return;
                const progress = Math.min(99, Math.round((currentTimeSec / totalDuration) * 100));
                if (progress > lastProgressUpdate) {
                    lastProgressUpdate = progress;
                    setJobStatus(jobId, { status: "rendering", progress });
                }
            };

            // stdout: -progress pipe:1 の出力（out_time_ms=123456 形式、確実）
            child.stdout?.on("data", (data: Buffer) => {
                const str = data.toString();
                const lines = str.split("\n");
                for (const line of lines) {
                    const m = line.match(/out_time_ms=(\d+)/);
                    if (m) {
                        const timeSec = parseInt(m[1]) / 1000000;
                        updateProgress(timeSec);
                    }
                }
            });

            // stderr: フォールバック（time=HH:MM:SS.ms 形式）
            child.stderr?.on("data", (data: Buffer) => {
                const str = data.toString();
                if (str.includes("frame=") || str.includes("Error") || str.includes("error")) {
                    console.log(`  [ffmpeg] ${str.trim().slice(0, 120)}`);
                }
                const timeMatch = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1]);
                    const mins = parseInt(timeMatch[2]);
                    const secs = parseFloat(timeMatch[3]);
                    updateProgress(hours * 3600 + mins * 60 + secs);
                }
            });

            child.on("close", (code: number | null) => {
                clearTimeout(timer);
                activeRenders--;
                if (fs.existsSync(assPath)) {
                    try { fs.unlinkSync(assPath); } catch { }
                }
                if (killed) {
                    setJobStatus(jobId, {
                        status: "error",
                        error: "FFmpegがタイムアウトしました（10分）",
                    });
                } else if (code === 0) {
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
                processQueue();
            });

            child.on("error", (err: Error) => {
                clearTimeout(timer);
                activeRenders--;
                console.error(`❌ FFmpegエラー (job: ${jobId}):`, err.message);
                setJobStatus(jobId, { status: "error", error: err.message });
                processQueue();
            });

        } catch (error: any) {
            activeRenders--;
            console.error(`❌ レンダリング準備エラー (job: ${jobId}):`, error.message);
            setJobStatus(jobId, { status: "error", error: error.message });
            processQueue();
        }
    });
}

// MP4レンダリングAPI（非同期 — FFmpegをバックグラウンドで実行）
app.post("/api/render", async (req, res) => {
    const rawFilename = req.body.filename;
    if (!rawFilename) {
        res.status(400).json({ error: "filenameが必要です" });
        return;
    }
    const filename = sanitizeFilename(rawFilename);

    // ディスク容量チェック
    const disk = await checkDiskSpace();
    if (!disk.available) {
        res.status(507).json({ error: `ディスク容量不足です (残り${disk.freeMB}MB)。古いファイルが削除されるのをお待ちください。` });
        return;
    }

    const baseName = path.parse(filename).name;
    const jobId = `${baseName}_${Date.now()}`;

    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
        // キューに追加
        const position = renderQueue.length + 1;
        renderQueue.push({ jobId, filename });
        setJobStatus(jobId, { status: "queued", position });
        console.log(`📋 レンダリングキューに追加 (job: ${jobId}, position: ${position})`);
        res.json({ jobId, status: "queued", position });
        return;
    }

    console.log(`🎬 レンダリングジョブ受付 (job: ${jobId})`);
    res.json({ jobId });
    executeRender(jobId, filename);
});

// バッチレンダリングAPI — 複数動画を一括キュー投入
app.post("/api/render-batch", async (req, res) => {
    const { filenames } = req.body;
    if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
        res.status(400).json({ error: "filenames配列が必要です" });
        return;
    }

    const disk = await checkDiskSpace();
    if (!disk.available) {
        res.status(507).json({ error: `ディスク容量不足です (残り${disk.freeMB}MB)` });
        return;
    }

    const jobs: { jobId: string; queued: boolean; position: number }[] = [];

    for (const rawFilename of filenames) {
        const filename = sanitizeFilename(rawFilename);
        const baseName = path.parse(filename).name;
        const jobId = `${baseName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        if (activeRenders < MAX_CONCURRENT_RENDERS) {
            jobs.push({ jobId, queued: false, position: 0 });
            executeRender(jobId, filename);
        } else {
            const position = renderQueue.length + 1;
            renderQueue.push({ jobId, filename });
            setJobStatus(jobId, { status: "queued", position });
            jobs.push({ jobId, queued: true, position });
        }
    }

    console.log(`📋 バッチレンダリング受付: ${jobs.length}件 (即時: ${jobs.filter(j => !j.queued).length}, キュー: ${jobs.filter(j => j.queued).length})`);
    res.json({ jobs });
});

// キューステータス確認API
app.get("/api/queue-status", (_req, res) => {
    res.json({
        activeRenders,
        maxConcurrent: MAX_CONCURRENT_RENDERS,
        queueLength: renderQueue.length,
        queuedJobs: renderQueue.map((j, i) => ({ jobId: j.jobId, position: i + 1 })),
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

// 静的ファイル配信
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));

// カスタムフォント配信（ブラウザプレビュー用）
app.use("/fonts", express.static(path.join(__dirname, "fonts")));

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
        await execAsync(
            `ffmpeg -y -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 "${thumbPath}"`
        );
        console.log(`🖼️ サムネイル生成: ${thumbName} (${timestamp}秒)`);
        res.json({ success: true, path: `output/${thumbName}`, filename: thumbName });
    } catch (error: any) {
        res.status(500).json({ error: "サムネイル生成に失敗: " + error.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
});

// ── グレースフルシャットダウン ──
function gracefulShutdown(signal: string) {
    console.log(`\n⚡ ${signal}受信 — グレースフルシャットダウン開始...`);
    server.close(() => {
        console.log("✅ HTTP接続を全てクローズ");
        process.exit(0);
    });
    // 10秒で強制終了
    setTimeout(() => {
        console.error("⚠️ タイムアウト — 強制終了");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
