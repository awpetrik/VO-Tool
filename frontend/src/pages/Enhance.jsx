import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronLeft, Mic, Radio, Headphones, PhoneCall, Users, SlidersHorizontal } from "lucide-react";
import Recorder from "../components/Recorder";
import Uploader from "../components/Uploader";
import WaveformViewer from "../components/WaveformViewer";
import EnhancementControls from "../components/EnhancementControls";
import ABCompare from "../components/ABCompare";
import DownloadButton from "../components/DownloadButton";

const API_BASE = "http://localhost:8000";

const REVIEW_ICONS = {
  Podcast: Radio,
  "Voice Over": Mic,
  Vocal: Headphones,
  "Call Recording": PhoneCall,
  Interview: Users,
};

const STEPS = [
  { id: 1, label: "Source" },
  { id: 2, label: "Settings" },
  { id: 3, label: "Enhance" },
  { id: 4, label: "Review" },
  { id: 5, label: "Export" },
];

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

function buildSettingsSignature(settings) {
  return JSON.stringify(settings);
}

function CheckIcon() {
  return (
    <Check size={12} strokeWidth={2.5} aria-hidden="true" />
  );
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
  const [activeStep, setActiveStep] = useState(1);
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [lastProcessedSettingsSignature, setLastProcessedSettingsSignature] = useState("");
  const [rerunReason, setRerunReason] = useState("");
  const [cleanReport, setCleanReport] = useState(null);
  const [settings, setSettings] = useState({
    noise_reduction: 80,
    clarity: 70,
    de_reverb: 30,
    compression: 70,
    normalize: true,
    clean_settings: {
      filler_removal: false,
      silence_trim: false,
      max_pause_sec: 0.8,
      custom_fillers: "",
    },
  });
  const originalUrlRef = useRef("");
  const enhancedUrlRef = useRef("");
  const wizardRef = useRef(null);
  const currentSettingsSignature = buildSettingsSignature(settings);

  const markDone = (stepId) =>
    setCompletedSteps((prev) => new Set([...prev, stepId]));

  const canAccess = (stepId) => {
    if (completedSteps.has(stepId)) return true;
    if (!completedSteps.size) return stepId === 1;
    return stepId <= Math.max(...completedSteps) + 1;
  };

  const scrollToWizard = () => {
    requestAnimationFrame(() => {
      if (!wizardRef.current) return;
      const rect = wizardRef.current.getBoundingClientRect();
      const scrollTarget = window.scrollY + rect.top - 76;
      window.scrollTo({ top: Math.max(0, scrollTarget), behavior: "smooth" });
    });
  };

  const goTo = (stepId) => {
    if (!canAccess(stepId)) return;
    setActiveStep(stepId);
    scrollToWizard();
  };

  const revokeManagedUrl = (ref, nextUrl = "") => {
    if (ref.current && ref.current !== nextUrl) {
      URL.revokeObjectURL(ref.current);
    }
    ref.current = nextUrl;
  };

  const clearEnhancedResult = () => {
    revokeManagedUrl(enhancedUrlRef, "");
    setEnhancedUrl("");
    setEnhancedBlob(null);
    setCleanReport(null);
    setProgressLog([]);
    setProgressPct(0);
  };

  const handleAudioReady = (file) => {
    const nextOriginalUrl = file ? URL.createObjectURL(file) : "";
    revokeManagedUrl(originalUrlRef, nextOriginalUrl);
    setOriginalFile(file);
    setOriginalUrl(nextOriginalUrl);
    clearEnhancedResult();
    setLastProcessedSettingsSignature("");
    setRerunReason("");

    if (file) {
      setCompletedSteps(new Set([1]));
      setActiveStep(2);
    } else {
      setCompletedSteps(new Set());
      setActiveStep(1);
    }
  };

  useEffect(() => {
    if (enhancedBlob) {
      markDone(1);
      markDone(2);
      markDone(3);
      setActiveStep(4);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enhancedBlob]);

  useEffect(() => {
    if (!lastProcessedSettingsSignature || lastProcessedSettingsSignature === currentSettingsSignature) {
      return;
    }

    clearEnhancedResult();
    setCompletedSteps((prev) => new Set(Array.from(prev).filter((stepId) => stepId <= 2)));
    setLastProcessedSettingsSignature("");
    setRerunReason("Settings changed. Run enhancement again to refresh the compare and export result.");

    if (activeStep > 3) {
      setActiveStep(3);
    }
  }, [activeStep, currentSettingsSignature, lastProcessedSettingsSignature]);

  useEffect(() => {
    return () => {
      revokeManagedUrl(originalUrlRef, "");
      revokeManagedUrl(enhancedUrlRef, "");
    };
  }, []);

  const processEnhancement = async () => {
    if (!originalFile) {
      setToast({ type: "error", title: "Error", message: "Please record or upload audio first." });
      return;
    }

    setIsProcessing(true);
    setProgressLog([]);
    setProgressPct(0);
    setRerunReason("");

    try {
      const formData = new FormData();
      formData.append("file", originalFile);
      formData.append("settings", JSON.stringify(settings));

      const res = await fetch(`${API_BASE}/enhance`, { method: "POST", body: formData });
      if (!res.ok) throw new Error("Enhancement failed.");

      let token = null;
      let errorMsg = null;
      let nextCleanReport = null;

      await readSSEStream(res, (event) => {
        if (event.step === "error") { errorMsg = event.error || event.label; return; }
        setProgressPct(event.pct);
        if (event.step !== "done") {
          setProgressLog((prev) => [...prev, event]);
        } else {
          token = event.token;
          nextCleanReport = event.clean_report || null;
        }
      });

      if (errorMsg) throw new Error(errorMsg);
      if (!token) throw new Error("Processing did not complete.");

      const dlRes = await fetch(`${API_BASE}/enhance/result/${token}`);
      if (!dlRes.ok) throw new Error("Failed to retrieve enhanced audio.");

      const blob = await dlRes.blob();
      const url = URL.createObjectURL(blob);
      revokeManagedUrl(enhancedUrlRef, url);
      setEnhancedBlob(blob);
      setEnhancedUrl(url);
      setCleanReport(nextCleanReport);
      setLastProcessedSettingsSignature(currentSettingsSignature);
      setToast({ type: "success", title: "Done", message: "Audio enhanced successfully." });
    } catch (error) {
      setToast({ type: "error", title: "Error", message: error.message });
    } finally {
      setIsProcessing(false);
    }
  };

  const sourceName = originalFile?.name || "No source selected";
  const presetLabel = activePreset === "Custom" ? "Custom profile" : activePreset;
  const normalizeLabel = settings.normalize ? "Normalize on" : "Normalize off";

  return (
    <div className="page-wrap page-wrap-wide">
      <div className="page-header">
        <button className="back-link" onClick={() => navigate("/")} aria-label="Back to Home">
          <ChevronLeft size={14} strokeWidth={2.5} aria-hidden="true" />
          Back
        </button>
        <h2 className="page-title">Enhance Voice</h2>
      </div>

      <div className="caption-wizard" ref={wizardRef}>
        <nav className="stepper-bar" aria-label="Enhancement workflow steps">
          {STEPS.map((step, idx) => {
            const done = completedSteps.has(step.id);
            const active = activeStep === step.id;
            const accessible = canAccess(step.id);
            return (
              <div key={step.id} className="stepper-item-wrap">
                <button
                  type="button"
                  className={`stepper-item${active ? " active" : ""}${done ? " done" : ""}${!accessible ? " locked" : ""}`}
                  onClick={() => goTo(step.id)}
                  disabled={!accessible}
                  aria-current={active ? "step" : undefined}
                  aria-label={`Step ${step.id}: ${step.label}${done ? " (completed)" : ""}`}
                >
                  <span className="stepper-bubble">
                    {done && !active ? <CheckIcon /> : step.id}
                  </span>
                  <span className="stepper-label">{step.label}</span>
                </button>
                {idx < STEPS.length - 1 && (
                  <span className={`stepper-line${done ? " done" : ""}`} aria-hidden="true" />
                )}
              </div>
            );
          })}
        </nav>

        <div className="step-body">
          {activeStep === 1 ? (
            <section className="step-card">
              <header className="step-header">
                <span className="section-kicker">Step 1</span>
                <h3>Choose your source</h3>
                <p>Upload a file or record directly before applying enhancement settings.</p>
              </header>
              <div className="tab-switch">
                <button type="button" className={inputMode === "upload" ? "active" : ""} onClick={() => setInputMode("upload")}>Upload</button>
                <button type="button" className={inputMode === "record" ? "active" : ""} onClick={() => setInputMode("record")}>Record</button>
              </div>
              {inputMode === "record" ? (
                <Recorder onAudioReady={handleAudioReady} />
              ) : (
                <Uploader accept=".mp3,.wav,.m4a,.ogg" onAudioReady={handleAudioReady} />
              )}
              {originalFile && (
                <div className="step-advance-row">
                  <div className="caption-status-bar">
                    <span className="pill-badge muted">Ready</span>
                    <span className="caption-status-name">{sourceName}</span>
                  </div>
                  <button type="button" className="btn btn-primary" onClick={() => { markDone(1); goTo(2); }}>
                    Next: Settings
                  </button>
                </div>
              )}
            </section>
          ) : completedSteps.has(1) ? (
            <button type="button" className="step-summary-card" onClick={() => goTo(1)}>
              <div className="step-summary-left">
                <span className="step-summary-check"><CheckIcon /></span>
                <div>
                  <span className="step-summary-title">Source</span>
                  <span className="step-summary-detail">{sourceName}</span>
                </div>
              </div>
              <span className="step-summary-edit">Edit</span>
            </button>
          ) : null}

          {activeStep === 2 ? (
            <section className="step-card">
              <header className="step-header">
                <span className="section-kicker">Step 2</span>
                <h3>Enhancement settings</h3>
                <p>Choose a preset, fine-tune the sliders, then continue to processing.</p>
              </header>
              <div className="settings-grid settings-grid-split">
                <div className="settings-panel">
                  <EnhancementControls
                    settings={settings}
                    setSettings={setSettings}
                    activePreset={activePreset}
                    setActivePreset={setActivePreset}
                    embedded
                    showTitle={false}
                  />
                </div>
                <div className="settings-panel settings-panel-soft enhance-side-panel">
                  <div className="enhance-side-source">
                    <span className="enhance-side-source-dot" aria-hidden="true" />
                    <span className="enhance-side-source-name" title={sourceName}>{sourceName}</span>
                  </div>
                  <WaveformViewer originalUrl={originalUrl} enhancedUrl={enhancedUrl} embedded showTitle={false} />
                </div>
              </div>
              <div className="step-advance-row">
                <button type="button" className="btn btn-outline" onClick={() => goTo(1)}>Back</button>
                <button type="button" className="btn btn-primary" onClick={() => { markDone(2); goTo(3); }}>
                  Next: Enhance
                </button>
              </div>
            </section>
          ) : completedSteps.has(2) ? (
            <button type="button" className="step-summary-card" onClick={() => goTo(2)}>
              <div className="step-summary-left">
                <span className="step-summary-check"><CheckIcon /></span>
                <div>
                  <span className="step-summary-title">Settings</span>
                  <span className="step-summary-detail">{presetLabel} · {normalizeLabel}</span>
                </div>
              </div>
              <span className="step-summary-edit">Edit</span>
            </button>
          ) : null}

          {activeStep === 3 ? (
            <section className="step-card">
              <header className="step-header step-header-inline">
                <div>
                  <span className="section-kicker">Step 3</span>
                  <h3>Run enhancement</h3>
                </div>
                <div className="caption-summary-pills">
                  <span className="pill-badge muted">{presetLabel}</span>
                  <span className="pill-badge muted">NR {settings.noise_reduction}</span>
                  <span className="pill-badge muted">Clarity {settings.clarity}</span>
                </div>
              </header>
              <button
                type="button"
                className="btn btn-accent btn-full btn-tall"
                onClick={processEnhancement}
                disabled={isProcessing}
              >
                {isProcessing ? "Enhancing your audio…" : "Enhance Audio"}
              </button>
              {rerunReason && !isProcessing && (
                <p className="inline-status-note">{rerunReason}</p>
              )}
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
              <div className="step-advance-row">
                <button type="button" className="btn btn-outline" onClick={() => goTo(2)}>Back</button>
              </div>
            </section>
          ) : completedSteps.has(3) ? (
            <button type="button" className="step-summary-card" onClick={() => goTo(3)}>
              <div className="step-summary-left">
                <span className="step-summary-check"><CheckIcon /></span>
                <div>
                  <span className="step-summary-title">Enhanced</span>
                  <span className="step-summary-detail">Processed with {presetLabel}</span>
                </div>
              </div>
              <span className="step-summary-edit">Re-run</span>
            </button>
          ) : null}

          {activeStep === 4 && enhancedBlob && (
            <section className="step-card step-card-review">
              <header className="step-header step-header-inline">
                <div>
                  <span className="section-kicker">Step 4</span>
                  <h3>Review &amp; compare</h3>
                </div>
                <div className="caption-summary-pills">
                  <span className="pill-badge muted">{presetLabel}</span>
                  <span className="pill-badge muted">{format}</span>
                  <button type="button" className="btn btn-primary" onClick={() => { markDone(4); goTo(5); }}>
                    Done — Export
                  </button>
                </div>
              </header>
              <div className="review-workspace">
                <div className="review-content-stack">
                  <ABCompare originalUrl={originalUrl} enhancedUrl={enhancedUrl} embedded showTitle={false} />
                </div>
                <aside className="review-player-panel">
                  {/* Preset header */}
                  {(() => {
                    const Icon = REVIEW_ICONS[activePreset] ?? SlidersHorizontal;
                    return (
                      <div className="rp-preset-header">
                        <span className="rp-preset-icon"><Icon size={17} strokeWidth={2} /></span>
                        <div className="rp-preset-info">
                          <span className="rp-preset-kicker">Active preset</span>
                          <span className="rp-preset-name">{presetLabel}</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Numeric stats */}
                  <div className="rp-stats">
                    {[
                      { label: "Noise Reduction", value: settings.noise_reduction },
                      { label: "Clarity",         value: settings.clarity },
                      { label: "De-reverb",       value: settings.de_reverb },
                      { label: "Compression",     value: settings.compression },
                    ].map(({ label, value }) => (
                      <div key={label} className="rp-stat-row">
                        <div className="rp-stat-head">
                          <span className="rp-stat-label">{label}</span>
                          <span className="rp-stat-value">{value}</span>
                        </div>
                        <div className="rp-stat-bar">
                          <div className="rp-stat-bar-fill" style={{ width: `${value}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Normalize status */}
                  <div className="rp-normalize-row">
                    <span className="rp-normalize-label">Normalize</span>
                    <span className={`rp-normalize-badge${settings.normalize ? " on" : ""}`}>
                      {settings.normalize ? "On · −14 LUFS" : "Off"}
                    </span>
                  </div>

                  <div className="rp-actions">
                    {cleanReport && (cleanReport.filler_removed > 0 || cleanReport.pause_trimmed > 0) && (
                      <p className="rp-cuts-report">
                        {cleanReport.filler_removed || 0} fillers removed · {((cleanReport.removed_ms || 0) / 1000).toFixed(1)}s trimmed
                      </p>
                    )}
                    <p className="rp-hint">Compare both tracks before exporting.</p>
                    <button type="button" className="btn btn-outline btn-full" onClick={() => goTo(2)}>
                      Adjust settings
                    </button>
                  </div>
                </aside>
              </div>
            </section>
          )}

          {activeStep === 5 ? (
            <section className="step-card">
              <header className="step-header step-header-inline">
                <div>
                  <span className="section-kicker">Step 5</span>
                  <h3>Export enhanced audio</h3>
                </div>
                <button type="button" className="btn btn-outline" onClick={() => goTo(4)}>
                  Back to Review
                </button>
              </header>
              <div className="export-meta">
                <div className="export-meta-item">
                  <span className="small-text">Source</span>
                  <strong>{sourceName}</strong>
                </div>
                <div className="export-meta-item">
                  <span className="small-text">Preset</span>
                  <strong>{presetLabel}</strong>
                </div>
                <div className="export-meta-item">
                  <span className="small-text">Normalize</span>
                  <strong>{settings.normalize ? "On" : "Off"}</strong>
                </div>
              </div>
              <div className="format-selector enhance-format-selector">
                <button type="button" className={`pill ${format === "WAV" ? "active" : ""}`} onClick={() => setFormat("WAV")}>
                  WAV
                </button>
                <button type="button" className={`pill ${format === "MP3" ? "active" : ""}`} onClick={() => setFormat("MP3")}>
                  MP3
                </button>
              </div>
              <DownloadButton enhancedBlob={enhancedBlob} format={format} onDownload={() => markDone(5)} />
              <p className="small-text">Use Review to compare A/B again before downloading a different format.</p>
            </section>
          ) : completedSteps.has(5) ? (
            <button type="button" className="step-summary-card step-summary-success" onClick={() => goTo(5)}>
              <div className="step-summary-left">
                <span className="step-summary-check"><CheckIcon /></span>
                <div>
                  <span className="step-summary-title">Exported</span>
                  <span className="step-summary-detail">enhanced_audio.{format.toLowerCase()}</span>
                </div>
              </div>
              <span className="step-summary-edit">Download again</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Enhance;
