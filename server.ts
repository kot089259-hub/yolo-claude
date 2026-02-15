import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
let openai: OpenAI | null = null;

if (apiKey) {
    openai = new OpenAI({ apiKey });
} else {
    console.warn("⚠️ OPENAI_API_KEY が設定されていません。字幕のAI修正機能は無効化されます。");
}

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

        const subtitlesRaw = transcription.subtitles || [];
        let subtitles = subtitlesRaw;
        const words = transcription.words || [];

        // OpenAIで字幕を洗練 (APIキーがあり、単語データがある場合)
        if (words.length > 0) {
            if (openai) {
                console.log("🤖 OpenAIで字幕を洗練中...");
                try {
                    const refined = await refineSubtitles(words);
                    if (refined.length > 0) {
                        subtitles = refined;
                        console.log(`✅ OpenAIによる洗練完了: ${subtitles.length}セグメント`);
                    }
                } catch (error: any) {
                    console.error("⚠️ OpenAI処理エラー (フォールバックします):", error.message);
                }
            } else {
                console.log("🛠️ OpenAIキーがないため、ローカルルールベースで字幕を整形します...");
                const refined = refineSubtitlesLocally(words, subtitlesRaw);
                if (refined.length > 0) {
                    subtitles = refined;
                    console.log(`✅ ローカルルールによる整形完了: ${subtitles.length}セグメント`);
                }
            }
        } else {
            console.log(`✅ ${subtitles.length}個のセグメントを検出 (単語データなし)`);
        }

        // 一時的な音声ファイルを削除
        fs.unlinkSync(audioPath);

        // 字幕データをJSONファイルとしても保存
        const subtitlePath = path.join(
            __dirname,
            "public",
            `${path.parse(filename).name}_subtitles.json`
        );
        fs.writeFileSync(subtitlePath, JSON.stringify(subtitles, null, 2));

        // 現在のプロジェクトファイルを更新（Remotion Studioが参照する）
        const projectPath = path.join(__dirname, "public", "current_project.json");
        fs.writeFileSync(projectPath, JSON.stringify({ videoFileName: filename }, null, 2));
        console.log(`📁 現在のプロジェクトを更新: ${filename}`);

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
        const props = JSON.stringify({ videoFileName: filename });
        execSync(
            `npx remotion render MyComp "${outputPath}" --codec=h264 --props='${props}'`,
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

// OpenAIを使用した字幕洗練・再アライメント関数
async function refineSubtitles(words: any[]): Promise<any[]> {
    if (!openai) return [];

    const fullText = words.map((w: any) => w.word).join("");

    // あまりに長すぎる場合は分割処理が必要だが、今回は簡易的に一括処理
    const prompt = `
以下のテキストは動画の音声認識結果です。
字幕として読みやすくするために、自然な位置で改行し、適切な句読点を追加してください。

ルール:
1. 元の文章の意味、単語、言い回しは絶対に変更しないこと（フィラーの削除もしない）。
2. 一つの字幕セグメントがあまり長くならないようにすること（最大でも20文字程度を目安に）。
3. 出力はJSON形式で、キー "segments" に文字列の配列を入れてください。

テキスト:
${fullText}
`;

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content:
                    "あなたはプロの字幕編集者です。JSON形式のみを出力してください。",
            },
            { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
    });

    const content = completion.choices[0].message.content;
    if (!content) throw new Error("No content from OpenAI");

    let segments: string[] = [];
    try {
        const parsed = JSON.parse(content);
        segments = parsed.segments || parsed;
    } catch (e) {
        console.error("JSON parse error:", content);
        throw e;
    }

    // アライメント処理（単語単位のタイムスタンプを使って再配置）
    return alignSubtitles(words, segments);
}

// ローカルルールベースでの字幕整形関数（rawSegmentsベース方式）
// Whisperの文レベルのsegmentsは自然な日本語の区切りを保つ（「にもかかわらず」は分断しない）
// wordsは日本語で1文字単位なので分割には使えない。rawSegmentsをそのまま活用する。
// 長すぎるセグメントのみ「句読点」位置で分割する。句読点がなければ分割しない。
function refineSubtitlesLocally(_words: any[], rawSegments: any[]): any[] {
    const MAX_CHARS = 24;

    const outputSegments: any[] = [];

    for (const seg of rawSegments) {
        const text = (seg.text || "").trim();
        if (text.length === 0) continue;

        // 短いセグメントはそのまま出力
        if (text.length <= MAX_CHARS) {
            outputSegments.push({
                start: seg.start,
                end: seg.end,
                text: text,
            });
            continue;
        }

        // 長いセグメント → 句読点位置で分割を試みる
        const punctPositions: number[] = [];
        for (let i = 0; i < text.length; i++) {
            if ('、。！？!?,'.includes(text[i])) {
                punctPositions.push(i + 1); // 句読点の直後の位置
            }
        }

        if (punctPositions.length === 0) {
            // 句読点がない → 分割せずそのまま出力（変な分断より長い方がマシ）
            outputSegments.push({
                start: seg.start,
                end: seg.end,
                text: text,
            });
            continue;
        }

        // 句読点位置で最適な分割を見つける
        const parts: string[] = [];
        let pos = 0;

        while (pos < text.length) {
            const remaining = text.length - pos;
            if (remaining <= MAX_CHARS) {
                parts.push(text.slice(pos));
                break;
            }

            // MAX_CHARS以内で最も後ろの句読点を探す
            let bestSplit = -1;
            for (const p of punctPositions) {
                const relPos = p - pos;
                if (relPos >= 3 && relPos <= MAX_CHARS) {
                    bestSplit = p;
                }
            }

            // 見つからなければ、MAX_CHARS以降の最初の句読点を探す
            if (bestSplit === -1) {
                for (const p of punctPositions) {
                    if (p > pos + MAX_CHARS) {
                        bestSplit = p;
                        break;
                    }
                }
            }

            // それでも見つからなければ残り全部を1つにする
            if (bestSplit === -1 || bestSplit <= pos) {
                parts.push(text.slice(pos));
                break;
            }

            parts.push(text.slice(pos, bestSplit));
            pos = bestSplit;
        }

        // 各パーツに時間を割り当て（文字位置で線形補間）
        const segDuration = seg.end - seg.start;
        const totalChars = text.length;
        let charOffset = 0;

        for (const part of parts) {
            const startRatio = charOffset / totalChars;
            const endRatio = (charOffset + part.length) / totalChars;

            outputSegments.push({
                start: Math.round((seg.start + segDuration * startRatio) * 100) / 100,
                end: Math.round((seg.start + segDuration * endRatio) * 100) / 100,
                text: part,
            });

            charOffset += part.length;
        }
    }

    // ギャップ埋め: 連続するセグメント間の短い空白を埋める（チカチカ防止）
    for (let i = 0; i < outputSegments.length - 1; i++) {
        const gap = outputSegments[i + 1].start - outputSegments[i].end;
        if (gap > 0 && gap < 0.5) {
            outputSegments[i].end = outputSegments[i + 1].start;
        }
    }

    return outputSegments;
}

function alignSubtitles(originalWords: any[], newSegments: string[]) {
    const alignedSubtitles = [];

    // 前処理: 文字単位のタイムスタンプマップを作成
    const timings: { char: string; start: number; end: number }[] = [];

    for (const w of originalWords) {
        const wordStr = w.word;
        for (const char of wordStr) {
            if (!isPunctuation(char)) {
                timings.push({
                    char: char,
                    start: w.start,
                    end: w.end
                });
            }
        }
    }

    let currentTimingIndex = 0;

    for (const segmentText of newSegments) {
        // セグメント内の「意味のある文字」をカウント
        let segmentContentLength = 0;
        for (const char of segmentText) {
            if (!isPunctuation(char)) {
                segmentContentLength++;
            }
        }

        if (segmentContentLength === 0) continue;

        if (currentTimingIndex >= timings.length) break;

        const startIndex = currentTimingIndex;
        let endIndex = startIndex + segmentContentLength - 1;
        if (endIndex >= timings.length) {
            endIndex = timings.length - 1;
        }

        const start = timings[startIndex].start;
        const end = timings[endIndex].end;

        alignedSubtitles.push({
            start,
            end,
            text: segmentText,
        });

        currentTimingIndex = endIndex + 1;
    }

    return alignedSubtitles;
}

function isPunctuation(char: string) {
    return /[\s\t\n\r!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~！＠＃＄％＾＆＊（）＿＋－＝「」｛｝；’：”＼｜、。・＜＞？＿～]/.test(char);
}
