function WaveformViewer({ originalUrl = "", enhancedUrl = "", embedded = false, showTitle = true }) {
  return (
    <section className={embedded ? "waveform-card" : "card waveform-card"}>
      {showTitle && <h3>Waveform</h3>}
      <div className="wave-track original">
        {Array.from({ length: 72 }).map((_, idx) => (
          <span key={`o-${idx}`} style={{ height: `${8 + ((idx * 5) % 24)}px` }} />
        ))}
      </div>
      <p className="small-text">Original {originalUrl ? "ready" : "waiting for source"}</p>

      <div className="wave-track enhanced">
        {Array.from({ length: 72 }).map((_, idx) => (
          <span key={`e-${idx}`} style={{ height: `${10 + ((idx * 9) % 28)}px` }} />
        ))}
      </div>
      <p className="small-text">Enhanced {enhancedUrl ? "ready" : "available after processing"}</p>
    </section>
  );
}

export default WaveformViewer;
