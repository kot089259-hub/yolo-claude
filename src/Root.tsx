import "./index.css";
import { Composition, staticFile } from "remotion";
import { getVideoMetadata } from "@remotion/media-utils";
import { MyComposition, CompositionProps } from "./Composition";
import { SubtitleSegment, SubtitleStyle } from "./SubtitleOverlay";
import type { AudioTrack, EditSettings } from "./Composition";

const FPS = 30;

const defaultProps: CompositionProps = {
  videoFileName: "IMG_8326.MOV",
  subtitles: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MyComp"
        component={MyComposition}
        durationInFrames={300}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
        calculateMetadata={async ({ props }) => {
          // 現在のプロジェクトファイルから動画ファイル名を取得
          let videoFileName = props.videoFileName;
          try {
            const projectRes = await fetch(staticFile("current_project.json"));
            if (projectRes.ok) {
              const project = await projectRes.json();
              if (project.videoFileName) {
                videoFileName = project.videoFileName;
              }
            }
          } catch { }

          const src = staticFile(videoFileName);
          const metadata = await getVideoMetadata(src);

          let subtitles: SubtitleSegment[] = props.subtitles;
          let subtitleStyle: SubtitleStyle | undefined = props.subtitleStyle;
          let audioTracks: AudioTrack[] | undefined = props.audioTracks;
          let editSettings: EditSettings | undefined = props.editSettings;

          const baseName = videoFileName.replace(/\.[^.]+$/, "");

          // 字幕データ
          if (!subtitles || subtitles.length === 0) {
            try {
              const res = await fetch(staticFile(`${baseName}_subtitles.json`));
              if (res.ok) subtitles = await res.json();
            } catch { }
          }

          // スタイル設定
          if (!subtitleStyle) {
            try {
              const res = await fetch(staticFile(`${baseName}_style.json`));
              if (res.ok) subtitleStyle = await res.json();
            } catch { }
          }

          // オーディオトラック
          if (!audioTracks || audioTracks.length === 0) {
            try {
              const res = await fetch(staticFile(`${baseName}_audio.json`));
              if (res.ok) audioTracks = await res.json();
            } catch { }
          }

          // 編集設定
          if (!editSettings) {
            try {
              const res = await fetch(staticFile(`${baseName}_edit.json`));
              if (res.ok) editSettings = await res.json();
            } catch { }
          }

          // トリムとスピードを考慮した実際の再生時間を計算
          let videoDuration = metadata.durationInSeconds;
          const trim = editSettings?.trim;
          if (trim) {
            const start = trim.startTime || 0;
            const end = trim.endTime || videoDuration;
            videoDuration = end - start;
          }

          // スピード調整（最初のセクションのspeedを全体に適用）
          const speed = editSettings?.speedSections?.[0]?.speed || 1;
          videoDuration = videoDuration / speed;

          return {
            durationInFrames: Math.max(1, Math.ceil(videoDuration * FPS)),
            width: Math.round(metadata.width),
            height: Math.round(metadata.height),
            fps: FPS,
            props: { ...props, videoFileName, subtitles, subtitleStyle, audioTracks, editSettings },
          };
        }}
      />
    </>
  );
};

