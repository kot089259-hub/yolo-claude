import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ── 型定義 ──

interface SubtitleSegment {
    start: number;
    end: number;
    text: string;
    posX?: number;
    posY?: number;
    fontFamily?: string;
    fontSize?: number;
    fontColor?: string;
    bgColor?: string;
    bold?: boolean;
    animation?: string;
}

interface SubtitleStyle {
    fontFamily: string;
    fontSize: number;
    fontColor: string;
    bgColor: string;
    bgOpacity: number;
    position: "top" | "center" | "bottom" | "custom";
    posX: number;
    posY: number;
    bold: boolean;
    animation: string;
    outlineWidth: number;
    outlineColor: string;
}

interface FilterSettings {
    brightness: number;
    contrast: number;
    saturate: number;
    sepia: number;
    grayscale: number;
    hueRotate: number;
    blur: number;
}

interface KenBurnsSettings {
    enabled: boolean;
    startScale: number;
    endScale: number;
    startX: number;
    endX: number;
    startY: number;
    endY: number;
}

interface TrimSettings {
    startTime: number;
    endTime: number | null;
}

interface TransitionSettings {
    fadeIn: number;
    fadeOut: number;
}

interface TextOverlayItem {
    text: string;
    startTime: number;
    endTime: number;
    posX: number;
    posY: number;
    fontSize: number;
    fontFamily: string;
    fontColor: string;
    bgColor: string;
    bgOpacity: number;
    bold: boolean;
    animation: string;
}

interface ImageOverlayItem {
    filename: string;
    startTime: number;
    endTime: number;
    posX: number;
    posY: number;
    width: number;
    opacity: number;
    animation: string;
}

interface AudioTrack {
    filename: string;
    startTime: number;
    volume: number;
}

interface RenderOptions {
    videoPath: string;
    outputPath: string;
    publicDir: string;
    subtitles: SubtitleSegment[];
    subtitleStyle?: SubtitleStyle;
    trim?: TrimSettings;
    transition?: TransitionSettings;
    speed?: number;
    filters?: FilterSettings;
    kenBurns?: KenBurnsSettings;
    textOverlays?: TextOverlayItem[];
    imageOverlays?: ImageOverlayItem[];
    audioTracks?: AudioTrack[];
}

const defaultStyle: SubtitleStyle = {
    fontFamily: "Noto Sans CJK JP",
    fontSize: 42,
    fontColor: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 0.75,
    position: "bottom",
    posX: 50,
    posY: 90,
    bold: true,
    animation: "fadeIn",
    outlineWidth: 0,
    outlineColor: "#000000",
};

// ── Hex色 → ASS色変換 (&HBBGGRR) ──
function hexToASS(hex: string): string {
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    return `&H00${b}${g}${r}`.toUpperCase();
}

// ── 秒 → ASS タイムコード (h:mm:ss.cc) ──
function toASSTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ── 動画情報の取得 ──
export function getVideoInfo(videoPath: string): { width: number; height: number; duration: number; fps: number } {
    const info = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -show_entries format=duration -of json "${videoPath}"`,
        { encoding: "utf-8" }
    );
    const data = JSON.parse(info);
    const stream = data.streams?.[0] || {};
    const width = stream.width || 1920;
    const height = stream.height || 1080;

    // fps計算
    const fpsStr = stream.r_frame_rate || "30/1";
    const [num, den] = fpsStr.split("/").map(Number);
    const fps = den ? num / den : 30;

    // duration
    const duration = parseFloat(stream.duration || data.format?.duration || "0");

    return { width, height, duration, fps };
}

// ── ASS字幕ファイル生成 ──
export function generateASSFile(
    subtitles: SubtitleSegment[],
    style: SubtitleStyle,
    textOverlays: TextOverlayItem[],
    videoWidth: number,
    videoHeight: number
): string {
    const s = { ...defaultStyle, ...style };

    // ASS bgOpacity → alpha (00=不透明, FF=透明)
    const bgAlpha = Math.round((1 - s.bgOpacity) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    const bgColor = s.bgColor || "#000000";
    const bgASS = `&H${bgAlpha}${bgColor.slice(5, 7)}${bgColor.slice(3, 5)}${bgColor.slice(1, 3)}`.toUpperCase();

    // 位置 → alignment
    let alignment = 2; // bottom center
    if (s.position === "top") alignment = 8;
    else if (s.position === "center") alignment = 5;

    // 縁取り設定
    const outlineWidth = s.outlineWidth || 0;
    const outlineColor = s.outlineColor ? hexToASS(s.outlineColor) : '&H00000000';
    // BorderStyle: 1=縁取り+影, 3=背景ボックス
    const borderStyle = outlineWidth > 0 ? 1 : 3;

    // 縦動画対応: マージンを動画幅に応じて動的に計算
    const isVertical = videoHeight > videoWidth;
    const marginLR = Math.round(videoWidth * 0.05); // 左右マージン: 幅の5%
    const marginV = Math.round(videoHeight * 0.03);  // 上下マージン: 高さの3%

    // 縦動画の場合、フォントサイズが幅に対して大きすぎると改行が崩れるので上限を設定
    const maxFontSize = isVertical ? Math.round(videoWidth / 15) : s.fontSize;
    const effectiveFontSize = Math.min(s.fontSize, maxFontSize);

    const assContent = `[Script Info]
Title: Video Subtitles
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontFamily},${effectiveFontSize},${hexToASS(s.fontColor)},${hexToASS(s.fontColor)},${outlineColor},${bgASS},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},0,${alignment},${marginLR},${marginLR},${marginV},1
Style: Telop,Noto Sans CJK JP,${isVertical ? Math.round(videoWidth / 18) : 36},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,0,0,5,${marginLR},${marginLR},${Math.round(videoHeight * 0.01)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${subtitles
            .map((sub) => {
                const segFont = sub.fontFamily || s.fontFamily;
                const segSize = sub.fontSize || s.fontSize;
                const segColor = sub.fontColor ? hexToASS(sub.fontColor) : hexToASS(s.fontColor);
                const segBold = sub.bold !== undefined ? sub.bold : s.bold;
                const segAnim = sub.animation || s.animation;

                let overrides = "";

                // フォントオーバーライド
                if (sub.fontFamily) overrides += `\\fn${segFont}`;
                if (sub.fontSize) overrides += `\\fs${segSize}`;
                if (sub.fontColor) overrides += `\\c${segColor}`;
                if (sub.bold !== undefined) overrides += `\\b${segBold ? 1 : 0}`;

                // 背景色オーバーライド
                if (sub.bgColor) {
                    const subBgASS = `&H${bgAlpha}${sub.bgColor.slice(5, 7)}${sub.bgColor.slice(3, 5)}${sub.bgColor.slice(1, 3)}`.toUpperCase();
                    overrides += `\\4c${subBgASS}`;
                }

                // 位置オーバーライド
                if (sub.posX !== undefined && sub.posY !== undefined) {
                    const px = Math.round((sub.posX / 100) * videoWidth);
                    const py = Math.round((sub.posY / 100) * videoHeight);
                    overrides += `\\pos(${px},${py})`;
                } else if (s.position === "custom") {
                    const px = Math.round((s.posX / 100) * videoWidth);
                    const py = Math.round((s.posY / 100) * videoHeight);
                    overrides += `\\pos(${px},${py})`;
                }

                // アニメーション（fadeIn → \fad）
                if (segAnim === "fadeIn" || segAnim === "slideUp" || segAnim === "slideDown") {
                    overrides += `\\fad(300,0)`;
                }

                const text = overrides ? `{${overrides}}${sub.text}` : sub.text;
                return `Dialogue: 0,${toASSTime(sub.start)},${toASSTime(sub.end)},Default,,0,0,0,,${text}`;
            })
            .join("\n")}
${textOverlays
            .map((item) => {
                const px = Math.round((item.posX / 100) * videoWidth);
                const py = Math.round((item.posY / 100) * videoHeight);
                const color = hexToASS(item.fontColor);
                const bgA = Math.round((1 - item.bgOpacity) * 255).toString(16).padStart(2, "0").toUpperCase();
                const bg = `&H${bgA}${item.bgColor.slice(5, 7)}${item.bgColor.slice(3, 5)}${item.bgColor.slice(1, 3)}`.toUpperCase();
                const fade = item.animation === "fadeIn" ? `\\fad(300,0)` : "";

                const overrides = `\\fn${item.fontFamily}\\fs${item.fontSize}\\c${color}\\b${item.bold ? 1 : 0}\\4c${bg}\\pos(${px},${py})${fade}`;
                return `Dialogue: 1,${toASSTime(item.startTime)},${toASSTime(item.endTime)},Telop,,0,0,0,,{${overrides}}${item.text}`;
            })
            .join("\n")}`;

    return assContent;
}

// ── FFmpeg フィルターグラフ構築 ──
function buildFilterComplex(
    opts: RenderOptions,
    videoInfo: { width: number; height: number; duration: number; fps: number }
): { filterComplex: string; outputLabel: string } {
    const filters: string[] = [];
    let currentLabel = "0:v";
    let labelIdx = 0;

    const nextLabel = () => {
        labelIdx++;
        return `v${labelIdx}`;
    };

    // 1. 速度変更
    if (opts.speed && opts.speed !== 1) {
        const out = nextLabel();
        filters.push(`[${currentLabel}]setpts=PTS/${opts.speed}[${out}]`);
        currentLabel = out;
    }

    // 2. 色補正フィルター
    if (opts.filters) {
        const f = opts.filters;
        const eqParts: string[] = [];

        // brightness: 100=normal → eq: 0=normal, range -1 to 1
        if (f.brightness !== 100) {
            eqParts.push(`brightness=${((f.brightness - 100) / 100).toFixed(2)}`);
        }
        // contrast: 100=normal → eq: 1=normal, range 0 to 2
        if (f.contrast !== 100) {
            eqParts.push(`contrast=${(f.contrast / 100).toFixed(2)}`);
        }
        // saturation: 100=normal → eq: 1=normal
        if (f.saturate !== 100) {
            eqParts.push(`saturation=${(f.saturate / 100).toFixed(2)}`);
        }

        if (eqParts.length > 0) {
            const out = nextLabel();
            filters.push(`[${currentLabel}]eq=${eqParts.join(":")}[${out}]`);
            currentLabel = out;
        }

        // hue rotation
        if (f.hueRotate > 0) {
            const out = nextLabel();
            filters.push(`[${currentLabel}]hue=h=${f.hueRotate}[${out}]`);
            currentLabel = out;
        }

        // sepia (colorchannelmixer で近似)
        if (f.sepia > 0) {
            const amount = f.sepia / 100;
            const out = nextLabel();
            // sepia matrix interpolated with identity
            const r_r = 1 - amount + amount * 0.393;
            const r_g = amount * 0.769;
            const r_b = amount * 0.189;
            const g_r = amount * 0.349;
            const g_g = 1 - amount + amount * 0.686;
            const g_b = amount * 0.168;
            const b_r = amount * 0.272;
            const b_g = amount * 0.534;
            const b_b = 1 - amount + amount * 0.131;
            filters.push(
                `[${currentLabel}]colorchannelmixer=${r_r.toFixed(3)}:${r_g.toFixed(3)}:${r_b.toFixed(3)}:0:${g_r.toFixed(3)}:${g_g.toFixed(3)}:${g_b.toFixed(3)}:0:${b_r.toFixed(3)}:${b_g.toFixed(3)}:${b_b.toFixed(3)}:0[${out}]`
            );
            currentLabel = out;
        }

        // grayscale
        if (f.grayscale > 0) {
            const amount = f.grayscale / 100;
            const out = nextLabel();
            filters.push(
                `[${currentLabel}]colorchannelmixer=${(1 - amount + amount * 0.2126).toFixed(3)}:${(amount * 0.7152).toFixed(3)}:${(amount * 0.0722).toFixed(3)}:0:${(amount * 0.2126).toFixed(3)}:${(1 - amount + amount * 0.7152).toFixed(3)}:${(amount * 0.0722).toFixed(3)}:0:${(amount * 0.2126).toFixed(3)}:${(amount * 0.7152).toFixed(3)}:${(1 - amount + amount * 0.0722).toFixed(3)}:0[${out}]`
            );
            currentLabel = out;
        }

        // blur
        if (f.blur > 0) {
            const out = nextLabel();
            filters.push(`[${currentLabel}]boxblur=${f.blur}:${f.blur}[${out}]`);
            currentLabel = out;
        }
    }

    // 3. Ken Burns (zoompan)
    if (opts.kenBurns?.enabled) {
        const kb = opts.kenBurns;
        const totalFrames = Math.round(videoInfo.duration * videoInfo.fps);
        const out = nextLabel();
        // zoompan: zoom と x, y をフレーム番号に応じて線形補間
        const zoomExpr = `'${kb.startScale}+(${kb.endScale}-${kb.startScale})*on/${totalFrames}'`;
        // x, y は zoompanの座標系 (pixel offset from center)
        const xExpr = `'(iw-iw/zoom)/2+${kb.startX / 100}*(iw/zoom)*((${totalFrames}-on)/${totalFrames})+${kb.endX / 100}*(iw/zoom)*(on/${totalFrames})'`;
        const yExpr = `'(ih-ih/zoom)/2+${kb.startY / 100}*(ih/zoom)*((${totalFrames}-on)/${totalFrames})+${kb.endY / 100}*(ih/zoom)*(on/${totalFrames})'`;
        filters.push(
            `[${currentLabel}]zoompan=z=${zoomExpr}:x=${xExpr}:y=${yExpr}:d=1:s=${videoInfo.width}x${videoInfo.height}:fps=${videoInfo.fps}[${out}]`
        );
        currentLabel = out;
    }

    // 4. フェードイン/アウト
    if (opts.transition) {
        if (opts.transition.fadeIn > 0) {
            const out = nextLabel();
            filters.push(`[${currentLabel}]fade=t=in:st=0:d=${opts.transition.fadeIn}[${out}]`);
            currentLabel = out;
        }
        if (opts.transition.fadeOut > 0) {
            const out = nextLabel();
            const fadeStart = videoInfo.duration - opts.transition.fadeOut;
            filters.push(`[${currentLabel}]fade=t=out:st=${fadeStart.toFixed(2)}:d=${opts.transition.fadeOut}[${out}]`);
            currentLabel = out;
        }
    }

    return {
        filterComplex: filters.length > 0 ? filters.join(";") : "",
        outputLabel: currentLabel,
    };
}

// ── メインレンダリング準備関数（コマンドを返す、実行はしない） ──
export function prepareFFmpegRender(opts: RenderOptions): { command: string; assPath: string } {
    const videoInfo = getVideoInfo(opts.videoPath);
    console.log(`📐 動画情報: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}秒, ${videoInfo.fps.toFixed(1)}fps`);

    // 1. ASS字幕ファイル生成
    const assPath = opts.outputPath.replace(/\.mp4$/, ".ass");
    const assContent = generateASSFile(
        opts.subtitles || [],
        opts.subtitleStyle || defaultStyle,
        opts.textOverlays || [],
        videoInfo.width,
        videoInfo.height
    );
    fs.writeFileSync(assPath, assContent, "utf-8");
    console.log(`📝 ASS字幕ファイル生成: ${path.basename(assPath)}`);

    // 2. フィルターグラフ構築
    const { filterComplex, outputLabel } = buildFilterComplex(opts, videoInfo);

    // 3. FFmpegコマンド構築
    const inputArgs: string[] = [];
    const filterParts: string[] = [];
    let videoOut = outputLabel;

    // メイン動画入力
    const trimArgs: string[] = [];
    if (opts.trim?.startTime && opts.trim.startTime > 0) {
        trimArgs.push(`-ss ${opts.trim.startTime}`);
    }
    if (opts.trim?.endTime) {
        trimArgs.push(`-to ${opts.trim.endTime}`);
    }
    inputArgs.push(`${trimArgs.join(" ")} -i "${opts.videoPath}"`);

    // 画像オーバーレイ入力
    const imageOverlays = opts.imageOverlays || [];
    for (let i = 0; i < imageOverlays.length; i++) {
        const imgPath = path.join(opts.publicDir, imageOverlays[i].filename);
        if (fs.existsSync(imgPath)) {
            inputArgs.push(`-i "${imgPath}"`);
        }
    }

    // オーディオトラック入力
    const audioTracks = opts.audioTracks || [];
    for (const track of audioTracks) {
        const audioPath = path.join(opts.publicDir, track.filename);
        if (fs.existsSync(audioPath)) {
            inputArgs.push(`-i "${audioPath}"`);
        }
    }

    // フィルター: ビデオフィルター + 字幕
    if (filterComplex) {
        filterParts.push(filterComplex);
    }

    // ASS字幕を適用（字幕またはテロップがある場合）
    const hasSubtitles = (opts.subtitles && opts.subtitles.length > 0) || (opts.textOverlays && opts.textOverlays.length > 0);
    if (hasSubtitles) {
        const out = `vfinal`;
        const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
        if (filterComplex) {
            filterParts.push(`[${videoOut}]ass='${escapedAssPath}'[${out}]`);
        } else {
            filterParts.push(`[0:v]ass='${escapedAssPath}'[${out}]`);
        }
        videoOut = out;
    }

    // 画像オーバーレイフィルター
    let inputIdx = 1;
    for (let i = 0; i < imageOverlays.length; i++) {
        const item = imageOverlays[i];
        const imgPath = path.join(opts.publicDir, item.filename);
        if (!fs.existsSync(imgPath)) continue;

        const out = `vimg${i}`;
        const x = `(W*${item.posX / 100}-w/2)`;
        const y = `(H*${item.posY / 100}-h/2)`;
        const enableExpr = `between(t,${item.startTime},${item.endTime})`;

        const scaleLabel = `imgscale${i}`;
        filterParts.push(`[${inputIdx}:v]scale=${item.width}:-1[${scaleLabel}]`);
        filterParts.push(
            `[${videoOut}][${scaleLabel}]overlay=x=${x}:y=${y}:enable='${enableExpr}'[${out}]`
        );
        videoOut = out;
        inputIdx++;
    }

    // オーディオミックス
    let audioOut = "0:a";
    if (audioTracks.length > 0) {
        const audioInputs = ["[0:a]"];
        for (let i = 0; i < audioTracks.length; i++) {
            const track = audioTracks[i];
            const audioPath = path.join(opts.publicDir, track.filename);
            if (!fs.existsSync(audioPath)) continue;

            const delayLabel = `adelay${i}`;
            const delayMs = Math.round(track.startTime * 1000);
            filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${track.volume}[${delayLabel}]`);
            audioInputs.push(`[${delayLabel}]`);
            inputIdx++;
        }
        if (audioInputs.length > 1) {
            audioOut = "aout";
            filterParts.push(`${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=first[${audioOut}]`);
        }
    }

    // 速度変更時のオーディオ
    if (opts.speed && opts.speed !== 1) {
        const aout = "aspeed";
        filterParts.push(`[${audioOut}]atempo=${opts.speed}[${aout}]`);
        audioOut = aout;
    }

    // 完全なFFmpegコマンドを構築
    const filterStr = filterParts.length > 0 ? filterParts.join(";") : "";
    const mapVideo = filterStr && videoOut !== "0:v" ? `-map "[${videoOut}]"` : "-map 0:v";
    const mapAudio = audioOut !== "0:a" ? `-map "[${audioOut}]"` : "-map 0:a?";

    let cmd = `ffmpeg -y ${inputArgs.join(" ")}`;
    if (filterStr) {
        cmd += ` -filter_complex "${filterStr}"`;
    }
    cmd += ` ${mapVideo} ${mapAudio}`;
    cmd += ` -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k`;
    cmd += ` -movflags +faststart`;
    cmd += ` "${opts.outputPath}"`;

    return { command: cmd, assPath };
}

