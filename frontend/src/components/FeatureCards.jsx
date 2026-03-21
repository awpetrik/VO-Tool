import { useNavigate } from "react-router-dom";

function FeatureCards() {
  const navigate = useNavigate();

  return (
    <section className="feature-section">
      <div className="feature-grid">
        <article className="feature-card">
          <div className="icon-box primary" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
              <path d="M12 19v3" />
              <path d="M8 22h8" />
            </svg>
          </div>
          <h3>Enhance Voice</h3>
          <p>Remove background noise, echo, and improve clarity</p>
          <button className="btn btn-primary" onClick={() => navigate("/enhance")}>
            Start enhancing
          </button>
        </article>

        <article className="feature-card">
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
          <p>Accurate word-level or line-level SRT captions</p>
          <button className="btn btn-accent" onClick={() => navigate("/caption")}>
            Start captioning
          </button>
        </article>

        <article className="feature-card">
          <div className="icon-box muted" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 7l-4 4 4 4" />
              <path d="M4 11h16" />
              <path d="M16 17l4-4-4-4" />
            </svg>
          </div>
          <h3>Before &amp; After</h3>
          <p>Compare original and enhanced audio side by side</p>
          <button className="btn btn-outline" onClick={() => navigate("/enhance")}>
            Try comparing
          </button>
        </article>
      </div>

      <div className="feature-rows">
        <div className="feature-row-item">
          <span className="feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3a15 15 0 0 1 0 18" />
              <path d="M12 3a15 15 0 0 0 0 18" />
            </svg>
          </span>
          <div>
            <strong>Bahasa Indonesia &amp; English</strong>
            <p>Multilingual caption support</p>
          </div>
        </div>
        <div className="feature-row-item">
          <span className="feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </span>
          <div>
            <strong>Export as .SRT</strong>
            <p>Standard subtitle format</p>
          </div>
        </div>
        <div className="feature-row-item">
          <span className="feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 21v-7" />
              <path d="M4 10V3" />
              <path d="M12 21v-4" />
              <path d="M12 14V3" />
              <path d="M20 21v-9" />
              <path d="M20 9V3" />
              <path d="M2 10h4" />
              <path d="M10 14h4" />
              <path d="M18 9h4" />
            </svg>
          </span>
          <div>
            <strong>Custom enhancement presets</strong>
            <p>Podcast, Vocal, Interview</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default FeatureCards;
