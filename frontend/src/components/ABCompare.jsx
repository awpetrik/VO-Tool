function ABCompare({ originalUrl, enhancedUrl }) {
  if (!originalUrl && !enhancedUrl) return null;

  return (
    <section className="card compare-card">
      <h3>Before &amp; After</h3>
      <div className="compare-grid">
        <div className="player-box">
          <p className="small-text">Original</p>
          <audio controls src={originalUrl} className="full-audio" />
        </div>
        <button className="pill active">A/B</button>
        <div className="player-box">
          <p className="small-text">Enhanced</p>
          <audio controls src={enhancedUrl} className="full-audio" />
        </div>
      </div>
    </section>
  );
}

export default ABCompare;
