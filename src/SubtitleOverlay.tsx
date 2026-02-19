import React from "react";
import {
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
} from "remotion";

export type AnimationType =
    | "none"
    | "fadeIn"
    | "slideUp"
    | "slideDown"
    | "pop"
    | "typewriter"
    | "bounce";

export type SubtitleSegment = {
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
    animation?: AnimationType;
};

export type SubtitleStyle = {
    fontFamily: string;
    fontSize: number;
    fontColor: string;
    bgColor: string;
    bgOpacity: number;
    position: "top" | "center" | "bottom" | "custom";
    posX: number;
    posY: number;
    bold: boolean;
    animation: AnimationType;
};

export const defaultSubtitleStyle: SubtitleStyle = {
    fontFamily: "Noto Sans JP",
    fontSize: 42,
    fontColor: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 0.75,
    position: "bottom",
    posX: 50,
    posY: 90,
    bold: true,
    animation: "fadeIn",
};

const SingleSubtitle: React.FC<{
    subtitle: SubtitleSegment;
    style: SubtitleStyle;
}> = ({ subtitle, style: s }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    const segFont = subtitle.fontFamily || s.fontFamily;
    const segSize = subtitle.fontSize || s.fontSize;
    const segColor = subtitle.fontColor || s.fontColor;
    const segBg = subtitle.bgColor || s.bgColor;
    const segBold =
        subtitle.bold !== undefined ? subtitle.bold : s.bold;
    const segAnim = subtitle.animation || s.animation;

    const r = parseInt(segBg.slice(1, 3), 16);
    const g = parseInt(segBg.slice(3, 5), 16);
    const b = parseInt(segBg.slice(5, 7), 16);
    const bgRgba = `rgba(${r}, ${g}, ${b}, ${s.bgOpacity})`;

    const startFrame = subtitle.start * fps;
    const localFrame = frame - startFrame;

    // アニメーション計算
    let opacity = 1;
    let translateY = 0;
    let scale = 1;
    let displayText = subtitle.text;

    switch (segAnim) {
        case "none":
            break;

        case "fadeIn":
            opacity = interpolate(localFrame, [0, 8], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            break;

        case "slideUp":
            opacity = interpolate(localFrame, [0, 6], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            translateY = interpolate(localFrame, [0, 8], [40, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            break;

        case "slideDown":
            opacity = interpolate(localFrame, [0, 6], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            translateY = interpolate(localFrame, [0, 8], [-40, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            break;

        case "pop":
            scale = spring({
                frame: localFrame,
                fps,
                config: { damping: 8, stiffness: 200, mass: 0.5 },
            });
            opacity = interpolate(localFrame, [0, 3], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            break;

        case "bounce":
            scale = spring({
                frame: localFrame,
                fps,
                config: { damping: 5, stiffness: 150, mass: 0.8 },
            });
            opacity = interpolate(localFrame, [0, 3], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            });
            break;

        case "typewriter": {
            opacity = 1;
            const totalChars = subtitle.text.length;
            const charsPerFrame = 2;
            const visibleChars = Math.min(
                totalChars,
                Math.floor(localFrame * charsPerFrame)
            );
            displayText = subtitle.text.slice(0, Math.max(1, visibleChars));
            break;
        }
    }

    // 位置計算
    const hasSegmentPos =
        subtitle.posX !== undefined && subtitle.posY !== undefined;
    let positionStyle: React.CSSProperties;

    if (hasSegmentPos) {
        positionStyle = {
            position: "absolute",
            left: `${subtitle.posX}%`,
            top: `${subtitle.posY}%`,
            transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        };
    } else if (s.position === "custom") {
        positionStyle = {
            position: "absolute",
            left: `${s.posX}%`,
            top: `${s.posY}%`,
            transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        };
    } else {
        const presetY =
            s.position === "top" ? "8%" : s.position === "center" ? "50%" : "90%";
        positionStyle = {
            position: "absolute",
            left: "50%",
            top: presetY,
            transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        };
    }

    return (
        <div
            style={{
                ...positionStyle,
                display: "flex",
                justifyContent: "center",
                opacity,
                width: "100%",
            }}
        >
            <div
                style={{
                    backgroundColor: bgRgba,
                    color: segColor,
                    fontSize: segSize,
                    fontWeight: segBold ? "bold" : "normal",
                    fontFamily: `'${segFont}', sans-serif`,
                    padding: "14px 32px",
                    borderRadius: 10,
                    textAlign: "center",
                    lineHeight: 1.4,
                    textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                }}
            >
                {displayText}
            </div>
        </div>
    );
};

export const SubtitleOverlay: React.FC<{
    subtitles: SubtitleSegment[];
    style?: SubtitleStyle;
}> = ({ subtitles, style: customStyle }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const currentTime = frame / fps;
    const s = { ...defaultSubtitleStyle, ...customStyle };

    const currentSubtitle = subtitles.find(
        (sub) => currentTime >= sub.start && currentTime <= sub.end
    );

    if (!currentSubtitle) return null;

    return <SingleSubtitle subtitle={currentSubtitle} style={s} />;
};
