import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Recorder from "../components/Recorder";
import Uploader from "../components/Uploader";
import WaveformViewer from "../components/WaveformViewer";
import EnhancementControls from "../components/EnhancementControls";
import ABCompare from "../components/ABCompare";
import DownloadButton from "../components/DownloadButton";

const API_BASE = "http://localhost:8001";

async function readSSEStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data:\s*/, "").trim();
      if (line) {
        try { onEvent(JSON.parse(line)); } catch { /* non-JSON chunk */ }
      }
    }
  }
}

function Enhance({ setToast }) {
  const navigate = useNavigate();
  const [inputMode, setInputMode] = useState("upload");
  const [originalFile, setOriginalFile] = useState(null);
  const [originalUrl, setOriginalUrl] = useState("");
  const [enhancedUrl, setEnhancedUrl] = useState("");
  const [enhancedBlob, setEnhancedBlob] = useState(null);
  const [format, setFormat] = useState("WAV");
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressLog, setProgressLog] = useState([]);
  const [progressPct, setProgressPct] = useState(0);
  const [activePreset, setActivePreset] = useState("Podcast");
  const [settings, setSettings] = useState({
    noise_reduction: 80,
    clarity: 70,
    de_reverb: 30,
    compression: 70,
    normalize: true,
  });

  const handleAudioReady = (file, url) => {
    setOriginalFile(file);
    setOriginalUrl(url);
    setEnhancedUrl("");
    setEnhancedBlob(null);
  };

  const processEnhancement = async () => {
    if (!originalFile) {
      setToast({ type: "error", title: "Error", message: "Please record or upload audio first." });
      return;
    }

    setIsProcessing(true);
    setProgressLog([]);
    setProgressPct(0);

    try {
      const formData = new FormData();
      formData.append("file", originalFile);
      formData.append("settings", JSON.stringify(settings));

      const res = await fetch(`${API_BASE}/enhance`, { method: "POST", body: formData });
      if (!res.ok) throw new Error("Enhancement failed.");

      let token = null;
      let errorMsg = null;

      await readSSEStream(res, (event) => {
        if (event.step === "error") { errorMsg = event.error || event.label; return; }
        setProgressPct(event.pct);
        if (event.step !== "done") {
          setProgressLog((prev) => [...prev, event]);
        } else {
          token = event.token;
        }
      });

      if (errorMsg) throw new Error(errorMsg);
      if (!token) throw new Error("Processing did not complete.");

      const dlRes = await fetch(`${API_BASE}/enhance/result/${token}`);
      if (!dlRes.ok) throw new Error("Failed to retrieve enhanced audio.");

      const blob = await dlRes.blob();
      const url = URL.createObjectURL(blob);
      setEnhancedBlob(blob);
      setEnhancedUrl(url);
      setToast({ type: "success", title: "Done", message: "Audio enhanced successfully." });
    } catch (error) {
      setToast({ type: "error", title: "Error", message: error.message });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="page-wrap">
      <button className="back-link" onClick={() => navigate("/")}>
        &lt;- Back to Home
      </button>
      <h2>Enhance Voice</h2>

      <section className="card">
        <div className="tab-switch">
          <button
            className={inputMode === "record" ? "active" : ""}
            onClick={() => setInputMode("record")}
          >
            Record
          </button>
          <button
            className={inputMode === "upload" ? "active" : ""}
            onClick={() => setInputMode("upload")}
          >
            Upload
          </button>
        </div>
        {inputMode === "record" ? (
          <Recorder onAudioReady={handleAudioReady} />
        ) : (
          <Uploader accept=".mp3,.wav,.m4a,.ogg" onAudioReady={handleAudioReady} />
        )}
      </section>

      <WaveformViewer />

      <EnhancementControls
        settings={settings}
        setSettings={setSettings}
        activePreset={activePreset}
        setActivePreset={setActivePreset}
      />

      <section className="card">
        <button
          className="btn btn-accent btn-full btn-tall"
          onClick={processEnhancement}
          disabled={isProcessing}
        >
          {isProcessing ? "Enhancing your audio…" : "Enhance Audio"}
        </button>
        {isProcessing && <div className="shimmer-bar" aria-hidden="true" />}
        {(isProcessing || progressLog.length > 0) && (
          <div className="progress-log" role="log" aria-live="polite">
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            {progressLog.map((s, i) => (
              <div
                key={i}
                className={`progress-log-item${i === progressLog.length - 1 && isProcessing ? " current" : " done"}`}
              >
                <span className="progress-log-icon" aria-hidden="true" />
                <span className="progress-log-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <ABCompare originalUrl={originalUrl} enhancedUrl={enhancedUrl} />

      <section className="card">
        <div className="format-selector">
          <button className={`pill ${format === "WAV" ? "active" : ""}`} onClick={() => setFormat("WAV")}>
            WAV
          </button>
          <button className={`pill ${format === "MP3" ? "active" : ""}`} onClick={() => setFormat("MP3")}>
            MP3
          </button>
        </div>
        <DownloadButton enhancedBlob={enhancedBlob} format={format} />
      </section>
    </div>
  );
}

export default Enhance;
