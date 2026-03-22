import { useNavigate } from "react-router-dom";
import { Mic } from "lucide-react";

function Hero() {
  const navigate = useNavigate();

  return (
    <section className="hero-section">
      <div className="hero-content">
        <span className="hero-badge">
          <Mic size={13} strokeWidth={2.4} aria-hidden="true" />
          Built for spoken audio
        </span>
        <h1>Make every word clearer.</h1>
        <p className="hero-lead">
          Clean dialogue, accurate captions, and faster review in one focused workflow.
        </p>
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
        <div className="hero-proof-row" aria-label="Key capabilities">
          <span className="proof-chip">Noise cleanup</span>
          <span className="proof-chip">Hybrid AI captions</span>
          <span className="proof-chip">Editable .SRT export</span>
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
