import { useNavigate } from "react-router-dom";
import CaptionTool from "../components/CaptionTool";

function Caption({ setToast }) {
  const navigate = useNavigate();

  return (
    <div className="page-wrap page-wrap-wide">
      <button className="back-link" onClick={() => navigate("/")}>
        &lt;- Back to Home
      </button>
      <h2>Auto Caption</h2>
      <CaptionTool setToast={setToast} />
    </div>
  );
}

export default Caption;
