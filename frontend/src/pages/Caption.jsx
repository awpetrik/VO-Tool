import { useNavigate } from "react-router-dom";
import CaptionTool from "../components/CaptionTool";

function Caption({ setToast }) {
  const navigate = useNavigate();

  return (
    <div className="page-wrap page-wrap-wide">
      <div className="page-header">
        <button className="back-link" onClick={() => navigate("/")} aria-label="Back to Home">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>
          Back
        </button>
        <h2 className="page-title">Auto Caption</h2>
      </div>
      <CaptionTool setToast={setToast} />
    </div>
  );
}

export default Caption;
