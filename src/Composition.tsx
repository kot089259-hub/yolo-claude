import React from "react";
import {
  OffthreadVideo,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import {
  SubtitleOverlay,
  SubtitleSegment,
  SubtitleStyle,
} from "./SubtitleOverlay";

export type AudioTrack = {
  filename: string;
  startTime: number;
  volume: number;
};

export type TrimSettings = {
  startTime: number;
  endTime: number | null;
};

export type TransitionSettings = {
  fadeIn: number;
  fadeOut: number;
};

export type SpeedSection = {
  start: number;
  end: number;
  speed: number;
};

export type ImageOverlayItem = {
  filename: string;
  startTime: number;
  endTime: number;
  posX: number; // %
  posY: number; // %
  width: number; // px
  opacity: number; // 0-1
  animation: "none" | "fadeIn" | "pop";
};

export type FilterSettings = {
  brightness: number; // 0-200 (100=normal)
  contrast: number;   // 0-200
  saturate: number;   // 0-200
  sepia: number;      // 0-100
  grayscale: number;  // 0-100
  hueRotate: number;  // 0-360
  blur: number;       // 0-20px
};

export type KenBurnsSettings = {
  enabled: boolean;
  startScale: number;
  endScale: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
};

export type TextOverlayItem = {
  text: string;
  startTime: number;
  endTime: number;
  posX: number;      // %
  posY: number;      // %
  fontSize: number;
  fontFamily: string;
  fontColor: string;
  bgColor: string;
  bgOpacity: number;
  bold: boolean;
  animation: "none" | "fadeIn" | "slideUp" | "pop" | "typewriter";
};

export type EditSettings = {
  trim: TrimSettings;
  transition: TransitionSettings;
  speedSections: SpeedSection[];
  additionalVideos: string[];
  imageOverlays?: ImageOverlayItem[];
  filters?: FilterSettings;
  kenBurns?: KenBurnsSettings;
  textOverlays?: TextOverlayItem[];
};

export type CompositionProps = {
  videoFileName: string;
  subtitles: SubtitleSegment[];
  subtitleStyle?: SubtitleStyle;
  audioTracks?: AudioTrack[];
  editSettings?: EditSettings;
};

// ── Video with transition + filters + Ken Burns ──
const VideoLayer: React.FC<{
  src: string;
  transition: TransitionSettings;
  durationInFrames: number;
  playbackRate?: number;
  startFrom?: number;
  filters?: FilterSettings;
  kenBurns?: KenBurnsSettings;
}> = ({ src, transition, durationInFrames, playbackRate, startFrom, filters, kenBurns }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Transition opacity
  const fadeInFrames = transition.fadeIn * fps;
  const fadeOutFrames = transition.fadeOut * fps;
  let opacity = 1;
  if (fadeInFrames > 0) {
    opacity = Math.min(opacity, interpolate(frame, [0, fadeInFrames], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    }));
  }
  if (fadeOutFrames > 0) {
    opacity = Math.min(opacity, interpolate(frame, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    }));
  }

  // CSS Filters
  let filterStr = "";
  if (filters) {
    const parts: string[] = [];
    if (filters.brightness !== 100) parts.push(`brightness(${filters.brightness}%)`);
    if (filters.contrast !== 100) parts.push(`contrast(${filters.contrast}%)`);
    if (filters.saturate !== 100) parts.push(`saturate(${filters.saturate}%)`);
    if (filters.sepia > 0) parts.push(`sepia(${filters.sepia}%)`);
    if (filters.grayscale > 0) parts.push(`grayscale(${filters.grayscale}%)`);
    if (filters.hueRotate > 0) parts.push(`hue-rotate(${filters.hueRotate}deg)`);
    if (filters.blur > 0) parts.push(`blur(${filters.blur}px)`);
    filterStr = parts.join(" ");
  }

  // Ken Burns
  let transform = "";
  if (kenBurns?.enabled) {
    const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
    const scale = interpolate(progress, [0, 1], [kenBurns.startScale, kenBurns.endScale]);
    const tx = interpolate(progress, [0, 1], [kenBurns.startX, kenBurns.endX]);
    const ty = interpolate(progress, [0, 1], [kenBurns.startY, kenBurns.endY]);
    transform = `scale(${scale}) translate(${tx}%, ${ty}%)`;
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
      <OffthreadVideo
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          opacity,
          filter: filterStr || undefined,
          transform: transform || undefined,
          transformOrigin: "center center",
        }}
        playbackRate={playbackRate}
        startFrom={startFrom}
      />
    </div>
  );
};

// ── Image Overlay ──
const ImageOverlay: React.FC<{
  item: ImageOverlayItem;
}> = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const startFrame = item.startTime * fps;
  const localFrame = frame - startFrame;

  let opacity = item.opacity;
  if (item.animation === "fadeIn") {
    opacity *= interpolate(localFrame, [0, 8], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
  }
  let scale = 1;
  if (item.animation === "pop") {
    scale = interpolate(localFrame, [0, 4, 6, 8], [0, 1.15, 0.95, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
    opacity *= interpolate(localFrame, [0, 3], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
  }

  return (
    <Img
      src={staticFile(item.filename)}
      style={{
        position: "absolute",
        left: `${item.posX}%`,
        top: `${item.posY}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        width: item.width,
        opacity,
      }}
    />
  );
};

// ── Text Overlay (フリーテロップ) ──
const TextOverlay: React.FC<{
  item: TextOverlayItem;
}> = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const startFrame = item.startTime * fps;
  const localFrame = frame - startFrame;

  let opacity = 1;
  let translateY = 0;
  let scale = 1;
  let displayText = item.text;

  switch (item.animation) {
    case "fadeIn":
      opacity = interpolate(localFrame, [0, 8], [0, 1], {
        extrapolateLeft: "clamp", extrapolateRight: "clamp",
      });
      break;
    case "slideUp":
      opacity = interpolate(localFrame, [0, 6], [0, 1], {
        extrapolateLeft: "clamp", extrapolateRight: "clamp",
      });
      translateY = interpolate(localFrame, [0, 8], [30, 0], {
        extrapolateLeft: "clamp", extrapolateRight: "clamp",
      });
      break;
    case "pop": {
      scale = interpolate(localFrame, [0, 4, 6, 8], [0, 1.15, 0.95, 1], {
        extrapolateLeft: "clamp", extrapolateRight: "clamp",
      });
      opacity = interpolate(localFrame, [0, 3], [0, 1], {
        extrapolateLeft: "clamp", extrapolateRight: "clamp",
      });
      break;
    }
    case "typewriter": {
      const visibleChars = Math.min(item.text.length, Math.floor(localFrame * 2));
      displayText = item.text.slice(0, Math.max(1, visibleChars));
      break;
    }
  }

  const r = parseInt(item.bgColor.slice(1, 3), 16);
  const g = parseInt(item.bgColor.slice(3, 5), 16);
  const b = parseInt(item.bgColor.slice(5, 7), 16);

  return (
    <div
      style={{
        position: "absolute",
        left: `${item.posX}%`,
        top: `${item.posY}%`,
        transform: `translate(-50%, -50%) translateY(${translateY}px) scale(${scale})`,
        opacity,
        padding: "0 20px",
      }}
    >
      <div
        style={{
          backgroundColor: `rgba(${r},${g},${b},${item.bgOpacity})`,
          color: item.fontColor,
          fontSize: item.fontSize,
          fontWeight: item.bold ? "bold" : "normal",
          fontFamily: `'${item.fontFamily}', sans-serif`,
          padding: "10px 24px",
          borderRadius: 8,
          textAlign: "center",
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          textShadow: "0 2px 4px rgba(0,0,0,0.5)",
        }}
      >
        {displayText}
      </div>
    </div>
  );
};

// ── Main Composition ──
export const MyComposition: React.FC<CompositionProps> = ({
  videoFileName,
  subtitles,
  subtitleStyle,
  audioTracks = [],
  editSettings,
}) => {
  const { fps, durationInFrames } = useVideoConfig();

  const trim = editSettings?.trim || { startTime: 0, endTime: null };
  const transition = editSettings?.transition || { fadeIn: 0, fadeOut: 0 };
  const additionalVideos = editSettings?.additionalVideos || [];
  const imageOverlays = editSettings?.imageOverlays || [];
  const filters = editSettings?.filters;
  const kenBurns = editSettings?.kenBurns;
  const speedSections = editSettings?.speedSections || [];
  const globalSpeed = speedSections.length > 0 ? speedSections[0].speed : 1;
  const startFromFrame = Math.round(trim.startTime * fps);

  return (
    <div style={{ flex: 1, backgroundColor: "black", position: "relative" }}>
      {/* メイン動画 */}
      <VideoLayer
        src={staticFile(videoFileName)}
        transition={transition}
        durationInFrames={durationInFrames}
        playbackRate={globalSpeed}
        startFrom={startFromFrame}
        filters={filters}
        kenBurns={kenBurns}
      />

      {/* 追加動画 */}
      {additionalVideos.map((vid, i) => (
        <Sequence key={`vid-${i}`} from={durationInFrames}>
          <OffthreadVideo
            src={staticFile(vid)}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </Sequence>
      ))}

      {/* 画像オーバーレイ */}
      {imageOverlays.map((item, i) => {
        const startFrame = Math.round(item.startTime * fps);
        const dur = Math.round((item.endTime - item.startTime) * fps);
        return (
          <Sequence key={`img-${i}`} from={startFrame} durationInFrames={dur}>
            <ImageOverlay item={item} />
          </Sequence>
        );
      })}

      {/* 字幕 */}
      {subtitles.length > 0 && (
        <SubtitleOverlay subtitles={subtitles} style={subtitleStyle} />
      )}

      {/* フリーテロップ */}
      {(editSettings?.textOverlays || []).map((item, i) => {
        const startFrame = Math.round(item.startTime * fps);
        const dur = Math.round((item.endTime - item.startTime) * fps);
        return (
          <Sequence key={`txt-${i}`} from={startFrame} durationInFrames={dur}>
            <TextOverlay item={item} />
          </Sequence>
        );
      })}

      {/* オーディオ */}
      {audioTracks.map((track, i) => (
        <Sequence key={`audio-${i}`} from={Math.round(track.startTime * fps)}>
          <Audio src={staticFile(track.filename)} volume={track.volume} />
        </Sequence>
      ))}
    </div>
  );
};
