function WaveformViewer() {
  return (
    <section className="card waveform-card">
      <h3>Waveform</h3>
      <div className="wave-track original">
        {Array.from({ length: 72 }).map((_, idx) => (
          <span key={`o-${idx}`} style={{ height: `${8 + ((idx * 5) % 24)}px` }} />
        ))}
      </div>
      <p className="small-text">Original</p>

      <div className="wave-track enhanced">
        {Array.from({ length: 72 }).map((_, idx) => (
          <span key={`e-${idx}`} style={{ height: `${10 + ((idx * 9) % 28)}px` }} />
        ))}
      </div>
      <p className="small-text">Enhanced</p>
    </section>
  );
}

export default WaveformViewer;
