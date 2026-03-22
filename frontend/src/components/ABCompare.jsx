import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Pause, Play } from "lucide-react";

function PlayIcon() {
  return <Play size={20} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />;
}

function PauseIcon() {
  return <Pause size={20} strokeWidth={2.1} aria-hidden="true" />;
}

function formatAudioTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function WaveTrackPlayer({ label, url, tone }) {
  const containerRef = useRef(null);
  const waveRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showNativeFallback, setShowNativeFallback] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setReady(false);
    setLoadError(false);
    setShowNativeFallback(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    if (!url || !containerRef.current) {
      return undefined;
    }

    const isOriginal = tone === "original";
    const wave = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 88,
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
    const fallbackTimer = setTimeout(() => {
      setShowNativeFallback(true);
    }, 4200);

    wave.on("ready", () => {
      clearTimeout(fallbackTimer);
      setReady(true);
      const nextDuration = wave.getDuration();
      setDuration(nextDuration);
      if (nextDuration > 0) {
        setShowNativeFallback(false);
      }
    });
    wave.on("error", () => {
      clearTimeout(fallbackTimer);
      setLoadError(true);
      setShowNativeFallback(true);
    });
    wave.on("timeupdate", (time) => setCurrentTime(time));
    wave.on("play", () => setIsPlaying(true));
    wave.on("pause", () => setIsPlaying(false));
    wave.on("finish", () => {
      setIsPlaying(false);
      setCurrentTime(wave.getDuration());
    });

    return () => {
      clearTimeout(fallbackTimer);
      wave.destroy();
      waveRef.current = null;
    };
  }, [tone, url]);

  const togglePlayback = () => {
    if (!waveRef.current || !ready) return;
    void waveRef.current.playPause();
  };

  return (
    <article className={`soundcloud-track ${tone}${ready ? " is-ready" : ""}`}>
      <div className="soundcloud-track-top">
        <div>
          <p className="soundcloud-track-label">{label}</p>
          <p className="soundcloud-track-time">{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</p>
        </div>
        <span className={`soundcloud-track-status${ready ? " ready" : ""}`}>
          {loadError ? "waveform failed" : ready ? "ready" : "loading waveform"}
        </span>
      </div>
      <div className="soundcloud-player-shell">
        <button
          type="button"
          className={`soundcloud-play-button${isPlaying ? " playing" : ""}`}
          onClick={togglePlayback}
          disabled={!ready}
          aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="soundcloud-wave-region">
          <div ref={containerRef} className="soundcloud-wave-canvas" />
          {showNativeFallback && (
            <audio controls src={url} className="soundcloud-fallback-audio" />
          )}
        </div>
      </div>
    </article>
  );
}

function ABCompare({ originalUrl, enhancedUrl, embedded = false, showTitle = true }) {
  if (!originalUrl && !enhancedUrl) return null;

  return (
    <section className={embedded ? "compare-card soundcloud-compare" : "card compare-card soundcloud-compare"}>
      {showTitle && <h3>Before &amp; After</h3>}
      <div className="soundcloud-compare-grid">
        <WaveTrackPlayer label="Original" url={originalUrl} tone="original" />
        <div className="soundcloud-ab-badge" aria-hidden="true">A/B</div>
        <WaveTrackPlayer label="Enhanced" url={enhancedUrl} tone="enhanced" />
      </div>
    </section>
  );
}

export default ABCompare;
