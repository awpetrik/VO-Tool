import { useNavigate } from "react-router-dom";
import { ArrowLeftRight, ArrowRight, Captions, Mic } from "lucide-react";

function ArrowRightIcon() {
  return <ArrowRight size={13} strokeWidth={2.5} aria-hidden="true" style={{ marginLeft: 4 }} />;
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
              <Mic size={20} strokeWidth={2} />
            </div>
            <h3>Enhance Voice</h3>
            <p>Remove background noise, reduce echo, and improve speech clarity for editing or publishing.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-primary" onClick={() => navigate("/enhance")}>
              Start enhancing <ArrowRightIcon />
            </button>
          </div>
        </article>

        <article className="feature-card">
          <div className="feature-card-body">
            <div className="icon-box accent" aria-hidden="true">
              <Captions size={20} strokeWidth={2} />
            </div>
            <h3>Generate Caption</h3>
            <p>Produce subtitle drafts fast, then review and export as clean line-level or word-level SRT.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-accent" onClick={() => navigate("/caption")}>
              Start captioning <ArrowRightIcon />
            </button>
          </div>
        </article>

        <article className="feature-card">
          <div className="feature-card-body">
            <div className="icon-box muted" aria-hidden="true">
              <ArrowLeftRight size={20} strokeWidth={2} />
            </div>
            <h3>Before &amp; After</h3>
            <p>Audit quality by comparing original and enhanced audio side by side before final export.</p>
          </div>
          <div className="feature-card-footer">
            <button className="btn btn-outline" onClick={() => navigate("/enhance")}>
              Try comparing <ArrowRightIcon />
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export default FeatureCards;
