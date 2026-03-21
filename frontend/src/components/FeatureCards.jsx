import { useNavigate } from "react-router-dom";

function ArrowRight() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginLeft: 4 }}>
      <path d="M3 8h10M9 4l4 4-4 4"/>
    </svg>
  );
}

function FeatureCards() {
  const navigate = useNavigate();

  return (
    <section className="feature-section">
      <header className="feature-section-head">
        <div>
          <span className="section-kicker">Workflow</span>
          <h2>One workspace from cleanup to captions</h2>
        </div>
        <p>
          Pick a starting point below. You can enhance audio, generate captions, or compare quality side by side.
        </p>
      </header>

      <div className="feature-grid">
        <article className="feature-card feature-card-primary">
          <div className="feature-card-body">
            <div className="icon-box primary" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
                <path d="M12 19v3" />
                <path d="M8 22h8" />
              </svg>
            </div>
            <h3>Enhance Voice</h3>
            <p>Remove background noise, reduce echo, and improve speech clarity for editing or publishing.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-primary" onClick={() => navigate("/enhance")}>
              Start enhancing <ArrowRight />
            </button>
          </div>
        </article>

        <article className="feature-card">
          <div className="feature-card-body">
            <div className="icon-box accent" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M8 10h3" />
                <path d="M8 14h3" />
                <path d="M14 10h3" />
                <path d="M14 14h3" />
              </svg>
            </div>
            <h3>Generate Caption</h3>
            <p>Produce subtitle drafts fast, then review and export as clean line-level or word-level SRT.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-accent" onClick={() => navigate("/caption")}>
              Start captioning <ArrowRight />
            </button>
          </div>
        </article>

        <article className="feature-card">
          <div className="feature-card-body">
            <div className="icon-box muted" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 7l-4 4 4 4" />
                <path d="M4 11h16" />
                <path d="M16 17l4-4-4-4" />
              </svg>
            </div>
            <h3>Before &amp; After</h3>
            <p>Audit quality by comparing original and enhanced audio side by side before final export.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-outline" onClick={() => navigate("/enhance")}>
              Try comparing <ArrowRight />
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export default FeatureCards;
