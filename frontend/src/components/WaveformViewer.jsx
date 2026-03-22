import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Pause, Play } from "lucide-react";

function PlayIcon() {
  return <Play size={16} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />;
}

function PauseIcon() {
  return <Pause size={16} strokeWidth={2.1} aria-hidden="true" />;
}

function formatAudioTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function WaveformLane({ label, url, tone, emptyLabel }) {
  const containerRef = useRef(null);
  const waveRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    if (!url || !containerRef.current) return undefined;

    const isOriginal = tone === "original";
    const wave = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 58,
      barWidth: 3,
      barGap: 2,
      barRadius: 999,
      cursorWidth: 0,
      normalize: true,
      dragToSeek: true,
      waveColor: isOriginal ? "#d6e0ee" : "#c5d4e8",
      progressColor: isOriginal ? "#8ba2c2" : "#3d5a80",
    });

    waveRef.current = wave;
    wave.on("ready", () => {
      setReady(true);
      setDuration(wave.getDuration());
    });
    wave.on("timeupdate", (time) => setCurrentTime(time));
    wave.on("play", () => setIsPlaying(true));
    wave.on("pause", () => setIsPlaying(false));
    wave.on("finish", () => {
      setIsPlaying(false);
      setCurrentTime(wave.getDuration());
    });

    return () => {
      try { wave.pause(); } catch (_) {}
      wave.destroy();
      waveRef.current = null;
    };
  }, [tone, url]);

  const togglePlayback = () => {
    if (!waveRef.current || !ready) return;
    void waveRef.current.playPause();
  };

  return (
    <div className={`wave-mini-row ${tone}${ready ? " is-ready" : ""}`}>
      <div className="wave-mini-head">
        <span className="wave-mini-label">{label}</span>
        <span className="wave-mini-time">
          {url ? `${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}` : "--:-- / --:--"}
        </span>
      </div>

      {url ? (
        <div className="wave-mini-shell">
          <button
            type="button"
            className={`wave-mini-play${isPlaying ? " playing" : ""}`}
            onClick={togglePlayback}
            disabled={!ready}
            aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <div className="wave-mini-canvas-wrap">
            <div ref={containerRef} className="wave-mini-canvas" />
          </div>
        </div>
      ) : (
        <div className="wave-mini-placeholder" aria-hidden="true">
          {Array.from({ length: 48 }).map((_, idx) => (
            <span key={idx} style={{ height: `${10 + ((idx * 9) % 26)}px` }} />
          ))}
        </div>
      )}
    </div>
  );
}

function WaveformViewer({ originalUrl = "", enhancedUrl = "", embedded = false, showTitle = true }) {
  return (
    <section className={embedded ? "waveform-card" : "card waveform-card"}>
      {showTitle && <h3>Waveform</h3>}
      <div className="wave-mini-stack">
        <WaveformLane label="Original" url={originalUrl} tone="original" emptyLabel="Waiting for source" />
        {enhancedUrl && (
          <WaveformLane label="Enhanced" url={enhancedUrl} tone="enhanced" emptyLabel="" />
        )}
      </div>
    </section>
  );
}

export default WaveformViewer;
