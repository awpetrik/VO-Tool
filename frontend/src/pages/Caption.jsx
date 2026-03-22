import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import CaptionTool from "../components/CaptionTool";

function Caption({ setToast }) {
  const navigate = useNavigate();

  return (
    <div className="page-wrap page-wrap-wide">
      <div className="page-header">
        <button className="back-link" onClick={() => navigate("/")} aria-label="Back to Home">
          <ChevronLeft size={14} strokeWidth={2.5} aria-hidden="true" />
          Back
        </button>
        <h2 className="page-title">Auto Caption</h2>
      </div>
      <CaptionTool setToast={setToast} />
    </div>
  );
}

export default Caption;
