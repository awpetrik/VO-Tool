import { useNavigate } from "react-router-dom";

function Hero() {
  const navigate = useNavigate();

  return (
    <section className="hero-section">
      <div className="hero-content">
        <span className="hero-badge">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
            <path d="M12 19v3" />
            <path d="M8 22h8" />
          </svg>
          Built for spoken audio
        </span>
        <h1>Make every<br/>word clearer.</h1>
        <p>
          Remove noise, shape voice clarity, and create captions that are ready to review, export, and share in Bahasa Indonesia or English.
        </p>
        <div className="hero-cta-row">
          <button className="btn btn-primary btn-hero" onClick={() => navigate("/enhance")}>
            Enhance a Recording
          </button>
          <button className="btn btn-accent-outline btn-hero" onClick={() => navigate("/caption")}>
            Generate Captions
          </button>
        </div>
      </div>
      <div className="hero-illustration">
        <div className="hero-illustration-panel" aria-hidden="true" />
        <img src="/images/hero.webp" alt="Voice enhancement illustration" className="hero-image" />
      </div>
    </section>
  );
}

export default Hero;
