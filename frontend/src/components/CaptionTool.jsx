import { useEffect, useMemo, useRef, useState } from "react";
import Recorder from "./Recorder";
import Uploader from "./Uploader";

const API_BASE = "http://localhost:8001";
const CAPTION_DRAFT_KEY = "voxora:caption-draft:v1";
const WHISPER_MODEL_OPTIONS = ["tiny", "base", "small", "large-v3"];
const AUDIO_DRAFT_DB = "voxora-caption-audio-db";
const AUDIO_DRAFT_STORE = "audioDraft";
const AUDIO_DRAFT_KEY = "latest";

function openAudioDraftDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(AUDIO_DRAFT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUDIO_DRAFT_STORE)) {
        db.createObjectStore(AUDIO_DRAFT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

async function saveAudioDraft(file) {
  try {
    const db = await openAudioDraftDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_DRAFT_STORE, "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Failed to save audio draft"));
      };
      tx.objectStore(AUDIO_DRAFT_STORE).put(
        {
          blob: file,
          name: file.name,
          type: file.type || "audio/mpeg",
          lastModified: file.lastModified || Date.now(),
          savedAt: Date.now(),
        },
        AUDIO_DRAFT_KEY
      );
    });
  } catch {
    // Ignore storage failures so caption flow remains usable.
  }
}

async function loadAudioDraft() {
  try {
    const db = await openAudioDraftDb();
    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_DRAFT_STORE, "readonly");
      const req = tx.objectStore(AUDIO_DRAFT_STORE).get(AUDIO_DRAFT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("Failed to load audio draft"));
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
    return payload;
  } catch {
    return null;
  }
}

async function clearAudioDraft() {
  try {
    const db = await openAudioDraftDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_DRAFT_STORE, "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Failed to clear audio draft"));
      };
      tx.objectStore(AUDIO_DRAFT_STORE).delete(AUDIO_DRAFT_KEY);
    });
  } catch {
    // Ignore storage failures so clear action still works for text draft.
  }
}

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

const STEPS = [
  { id: 1, label: "Source" },
  { id: 2, label: "Settings" },
  { id: 3, label: "Generate" },
  { id: 4, label: "Review" },
  { id: 5, label: "Export" },
];

function formatTime(seconds) {
  const totalMs = Math.floor(seconds * 1000);
  const h = Math.floor(totalMs / 3600000).toString().padStart(2, "0");
  const m = Math.floor((totalMs % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
  const ms = (totalMs % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

function getActiveSegmentIndex(segments, currentTime) {
  if (!Array.isArray(segments) || !segments.length) return -1;

  const t = Math.max(0, Number(currentTime) || 0);
  const epsilon = 0.06;
  let fallbackIdx = -1;

  for (let i = 0; i < segments.length; i += 1) {
    const rawStart = Number(segments[i]?.start);
    const rawEnd = Number(segments[i]?.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;

    const start = Math.min(rawStart, rawEnd);
    const end = Math.max(rawStart, rawEnd);

    if (t + epsilon >= start && t <= end + epsilon) {
      return i;
    }

    if (start <= t) {
      fallbackIdx = i;
    }
  }

  return fallbackIdx;
}

function buildSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text.trim()}`)
    .join("\n\n");
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
  );
}

function CaptionTool({ setToast }) {
  const [inputMode, setInputMode] = useState("upload");
  const [file, setFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [language, setLanguage] = useState("auto");
  const [granularity, setGranularity] = useState("line");
  const [maxChars, setMaxChars] = useState(50);
  const [model, setModel] = useState("small");
  const [loading, setLoading] = useState(false);
  const [progressLog, setProgressLog] = useState([]);
  const [progressPct, setProgressPct] = useState(0);
  const [modelStatuses, setModelStatuses] = useState({});
  const [modelStatusLoading, setModelStatusLoading] = useState(false);
  const [modelStatusError, setModelStatusError] = useState("");
  const [modelDownloadPct, setModelDownloadPct] = useState(null);
  const [modelDownloadBytes, setModelDownloadBytes] = useState({ downloaded: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [editableSegments, setEditableSegments] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeStep, setActiveStep] = useState(1);
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [draftSourceName, setDraftSourceName] = useState("");
  const [restoringDraft, setRestoringDraft] = useState(false);
  const restoredAudioUrlRef = useRef("");
  const audioRef = useRef(null);
  const reviewListRef = useRef(null);
  const rowRefs = useRef(new Map());
  const wizardRef = useRef(null);

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

  const onAudioReady = (selectedFile, previewUrl) => {
    if (restoredAudioUrlRef.current && restoredAudioUrlRef.current !== previewUrl) {
      URL.revokeObjectURL(restoredAudioUrlRef.current);
      restoredAudioUrlRef.current = "";
    }
    setFile(selectedFile);
    setDraftSourceName(selectedFile?.name || "");
    setAudioUrl(previewUrl);
    setResult(null);
    setEditableSegments([]);
    setActiveIndex(-1);
    localStorage.removeItem(CAPTION_DRAFT_KEY);
    if (selectedFile) {
      void saveAudioDraft(selectedFile);
    }
  };

  const clearDraft = () => {
    localStorage.removeItem(CAPTION_DRAFT_KEY);
    void clearAudioDraft();
    setResult(null);
    setEditableSegments([]);
    setActiveIndex(-1);
    setDraftSourceName(file?.name || "");
    if (file) {
      setCompletedSteps(new Set([1]));
      setActiveStep(2);
    } else {
      setCompletedSteps(new Set());
      setActiveStep(1);
    }
    setToast({ type: "success", title: "Draft cleared", message: "Saved subtitle draft removed." });
  };

  useEffect(() => {
    let active = true;
    const raw = localStorage.getItem(CAPTION_DRAFT_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw);
      const restoredSegments = draft?.editableSegments;
      if (!Array.isArray(restoredSegments) || !restoredSegments.length) return;

      setLanguage(draft.language || "auto");
      setGranularity(draft.granularity || "line");
      setMaxChars(typeof draft.maxChars === "number" ? draft.maxChars : 50);
      setModel(draft.model || "small");
      setResult(draft.result || { segments: restoredSegments, language_detected: draft.language || "unknown" });
      setEditableSegments(restoredSegments);
      setActiveIndex(Number.isInteger(draft.activeIndex) ? draft.activeIndex : -1);
      setDraftSourceName(draft.sourceName || "Recovered draft");

      const restoredCompleted = Array.isArray(draft.completedSteps) ? draft.completedSteps : [1, 2, 3, 4];
      setCompletedSteps(new Set(restoredCompleted));
      setActiveStep(draft.activeStep === 5 ? 5 : 4);

      setRestoringDraft(true);
      loadAudioDraft().then((audioDraft) => {
        if (!active || !audioDraft?.blob) return;
        const draftName = audioDraft.name || draft.sourceName || "restored-audio.wav";
        const draftType = audioDraft.type || "audio/wav";
        const restoredFile = new File([audioDraft.blob], draftName, {
          type: draftType,
          lastModified: Number(audioDraft.lastModified || Date.now()),
        });
        const restoredUrl = URL.createObjectURL(audioDraft.blob);
        restoredAudioUrlRef.current = restoredUrl;
        setFile(restoredFile);
        setAudioUrl(restoredUrl);
      }).finally(() => {
        if (active) setRestoringDraft(false);
      });

      setToast({
        type: "success",
        title: "Draft restored",
        message: "Previous subtitle edits recovered from local draft.",
      });
    } catch {
      localStorage.removeItem(CAPTION_DRAFT_KEY);
      if (active) setRestoringDraft(false);
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (restoredAudioUrlRef.current) {
        URL.revokeObjectURL(restoredAudioUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let active = true;

    const fetchModelStatuses = async () => {
      setModelStatusLoading(true);
      setModelStatusError("");
      try {
        const res = await fetch(`${API_BASE}/caption/models/status`);
        if (!res.ok) throw new Error("Failed to fetch model status");
        const data = await res.json();
        if (!active) return;
        setModelStatuses(data?.models || {});
      } catch {
        if (!active) return;
        setModelStatusError("Model status unavailable");
      } finally {
        if (active) setModelStatusLoading(false);
      }
    };

    fetchModelStatuses();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!result || !editableSegments.length) return;

    const draftPayload = {
      sourceName: file?.name || draftSourceName || "",
      language,
      granularity,
      maxChars,
      model,
      activeStep,
      activeIndex,
      completedSteps: Array.from(completedSteps),
      editableSegments,
      result: {
        ...(result || {}),
        segments: editableSegments,
        srt: buildSrt(editableSegments),
      },
      savedAt: Date.now(),
    };

    localStorage.setItem(CAPTION_DRAFT_KEY, JSON.stringify(draftPayload));
  }, [
    result,
    editableSegments,
    language,
    granularity,
    maxChars,
    model,
    activeStep,
    activeIndex,
    completedSteps,
    file,
    draftSourceName,
  ]);

  useEffect(() => {
    if (activeStep !== 4 || activeIndex < 0) return;
    const container = reviewListRef.current;
    const row = rowRefs.current.get(activeIndex);
    if (!container || !row) return;

    // Keep active row in a safe zone and avoid placing it too close to clipped edges.
    const safeTop = 88;
    const safeBottom = 72;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const tooHigh = rowRect.top < containerRect.top + safeTop;
    const tooLow = rowRect.bottom > containerRect.bottom - safeBottom;

    if (tooHigh || tooLow) {
      row.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    }
  }, [activeStep, activeIndex]);

  // Auto-advance step 1 → 2 when a source is ready
  useEffect(() => {
    if (file && activeStep === 1) {
      markDone(1);
      setActiveStep(2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Auto-advance step 3 → 4 when captions arrive
  useEffect(() => {
    if (result) {
      setEditableSegments(result.segments || []);
      markDone(1);
      markDone(2);
      markDone(3);
      setActiveStep(4);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const generateCaption = async () => {
    if (!file) {
      setToast({ type: "error", title: "No source", message: "Upload or record audio first." });
      return;
    }
    setLoading(true);
    setProgressLog([]);
    setProgressPct(0);
    setModelDownloadPct(null);
    setModelDownloadBytes({ downloaded: 0, total: 0 });
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("language", language);
      formData.append("granularity", granularity);
      formData.append("max_chars", String(maxChars));
      formData.append("model", model);

      const res = await fetch(`${API_BASE}/caption`, { method: "POST", body: formData });
      if (!res.ok) throw new Error("Caption request failed.");

      let captionResult = null;
      let errorMsg = null;

      await readSSEStream(res, (event) => {
        if (event.step === "error") { errorMsg = event.error || event.label; return; }
        setProgressPct(event.pct);
        if (typeof event.download_pct === "number") {
          setModelDownloadPct(event.download_pct);
          setModelDownloadBytes({
            downloaded: Number(event.downloaded_bytes || 0),
            total: Number(event.total_bytes || 0),
          });
        }
        if (event.step !== "done") {
          setProgressLog((prev) => [...prev, event]);
        } else {
          captionResult = event.result;
        }
      });

      if (errorMsg) throw new Error(errorMsg);
      if (!captionResult) throw new Error("No captions returned.");

      setResult(captionResult);
      setActiveIndex(0);
      setModelStatuses((prev) => ({ ...prev, [model]: true }));
      setToast({ type: "success", title: "Done", message: "Captions generated." });
    } catch (err) {
      setToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const downloadSrt = () => {
    if (!editableSegments.length) return;
    const blob = new Blob([buildSrt(editableSegments)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `caption_${Date.now()}_${language}.srt`;
    a.click();
    URL.revokeObjectURL(url);
    markDone(5);
    setToast({ type: "success", title: "Downloaded", message: "SRT file saved." });
  };

  const langLabel =
    language === "id" ? "Bahasa Indonesia" : language === "en" ? "English" : "Auto-detect";
  const granLabel = granularity === "word" ? "Word-level" : "Line-level";
  const selectedModelReady = Boolean(modelStatuses?.[model]);
  const downloadedModelCount = WHISPER_MODEL_OPTIONS.filter((name) => modelStatuses?.[name]).length;
  const modelDownloadText = modelDownloadBytes.total > 0
    ? `${(modelDownloadBytes.downloaded / (1024 * 1024)).toFixed(1)} / ${(modelDownloadBytes.total / (1024 * 1024)).toFixed(1)} MB`
    : `${(modelDownloadBytes.downloaded / (1024 * 1024)).toFixed(1)} MB`;
  const segments = useMemo(() => editableSegments, [editableSegments]);

  return (
    <div className="caption-wizard" ref={wizardRef}>
      {/* ── Stepper bar ────────────────────────────────── */}
      <nav className="stepper-bar" aria-label="Caption workflow steps">
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

      {/* ── Step body ───────────────────────────────────── */}
      <div className="step-body">

        {/* Step 1 — Source */}
        {activeStep === 1 ? (
          <section className="step-card">
            <header className="step-header">
              <span className="section-kicker">Step 1</span>
              <h3>Choose your source</h3>
              <p>Upload an audio file or record directly from your browser.</p>
            </header>
            <div className="tab-switch">
              <button type="button" className={inputMode === "upload" ? "active" : ""} onClick={() => setInputMode("upload")}>Upload</button>
              <button type="button" className={inputMode === "record" ? "active" : ""} onClick={() => setInputMode("record")}>Record</button>
            </div>
            {inputMode === "record" ? (
              <Recorder onAudioReady={onAudioReady} />
            ) : (
              <Uploader accept=".mp3,.wav,.m4a,.mp4,.ogg" onAudioReady={onAudioReady} />
            )}
            {file && (
              <div className="step-advance-row">
                <div className="caption-status-bar">
                  <span className="pill-badge muted">Ready</span>
                  <span className="caption-status-name">{file.name}</span>
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
                <span className="step-summary-detail">{file?.name || draftSourceName || "—"}</span>
              </div>
            </div>
            <span className="step-summary-edit">Edit</span>
          </button>
        ) : null}

        {/* Step 2 — Settings */}
        {activeStep === 2 ? (
          <section className="step-card">
            <header className="step-header">
              <span className="section-kicker">Step 2</span>
              <h3>Transcription settings</h3>
              <p>Defaults work well for most cases. Adjust if needed.</p>
            </header>
            <div className="settings-grid settings-grid-split">
              <div className="settings-panel">
                <label>
                  <span className="field-label">Language</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="id">Bahasa Indonesia</option>
                    <option value="en">English</option>
                    <option value="auto">Auto-detect</option>
                  </select>
                </label>
                <div>
                  <span className="field-label">Granularity</span>
                  <div className="segmented-control" role="group" aria-label="Caption granularity">
                    <button type="button" className={`segment ${granularity === "line" ? "active" : ""}`} onClick={() => setGranularity("line")}>Per Baris</button>
                    <button type="button" className={`segment ${granularity === "word" ? "active" : ""}`} onClick={() => setGranularity("word")}>Per Kata</button>
                  </div>
                </div>
              </div>
              <div className="settings-panel settings-panel-soft">
                {granularity === "line" ? (
                  <label>
                    <span className="field-label">Max chars per line</span>
                    <div className="range-header">
                      <strong>{maxChars}</strong>
                      <span className="small-text">characters</span>
                    </div>
                    <input type="range" min="30" max="80" value={maxChars} onChange={(e) => setMaxChars(Number(e.target.value))} />
                  </label>
                ) : (
                  <div className="settings-note">
                    <strong>Word-level</strong>
                    <p className="small-text">Each word becomes its own timed entry.</p>
                  </div>
                )}
                <details className="advanced-panel">
                  <summary>Whisper model</summary>
                  <label>
                    <span className="field-label">Model</span>
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      <option value="tiny">tiny — fastest {modelStatuses.tiny ? "(downloaded)" : "(not downloaded)"}</option>
                      <option value="base">base {modelStatuses.base ? "(downloaded)" : "(not downloaded)"}</option>
                      <option value="small">small — recommended {modelStatuses.small ? "(downloaded)" : "(not downloaded)"}</option>
                      <option value="large-v3">large-v3 — most accurate {modelStatuses["large-v3"] ? "(downloaded)" : "(not downloaded)"}</option>
                    </select>
                  </label>
                  <div className="model-status-panel" role="status" aria-live="polite">
                    <div className="model-status-header">
                      <span className="small-text">Downloaded models</span>
                      <strong>{downloadedModelCount}/{WHISPER_MODEL_OPTIONS.length}</strong>
                    </div>
                    <div className="model-status-list">
                      {WHISPER_MODEL_OPTIONS.map((name) => (
                        <span key={name} className={`model-status-chip ${modelStatuses?.[name] ? "ready" : "missing"}`}>
                          {name}: {modelStatuses?.[name] ? "downloaded" : "not downloaded"}
                        </span>
                      ))}
                    </div>
                    {modelStatusLoading && <p className="small-text model-status-note">Checking model cache…</p>}
                    {modelStatusError && <p className="small-text model-status-note model-status-note-error">{modelStatusError}</p>}
                  </div>
                </details>
              </div>
            </div>
            <div className="step-advance-row">
              <button type="button" className="btn btn-outline" onClick={() => goTo(1)}>Back</button>
              <button type="button" className="btn btn-primary" onClick={() => { markDone(2); goTo(3); }}>
                Next: Generate
              </button>
            </div>
          </section>
        ) : completedSteps.has(2) ? (
          <button type="button" className="step-summary-card" onClick={() => goTo(2)}>
            <div className="step-summary-left">
              <span className="step-summary-check"><CheckIcon /></span>
              <div>
                <span className="step-summary-title">Settings</span>
                <span className="step-summary-detail">{langLabel} · {granLabel}</span>
              </div>
            </div>
            <span className="step-summary-edit">Edit</span>
          </button>
        ) : null}

        {/* Step 3 — Generate */}
        {activeStep === 3 ? (
          <section className="step-card">
            <header className="step-header step-header-inline">
              <div>
                <span className="section-kicker">Step 3</span>
                <h3>Generate captions</h3>
              </div>
              <div className="caption-summary-pills">
                <span className="pill-badge muted">{langLabel}</span>
                <span className="pill-badge muted">{granLabel}</span>
                <span className="pill-badge muted">{model}</span>
              </div>
            </header>
            <button
              type="button"
              className="btn btn-accent btn-full btn-tall"
              onClick={generateCaption}
              disabled={loading}
            >
              {loading ? "Transcribing audio…" : "Generate Captions"}
            </button>
            {loading && <div className="shimmer-bar" aria-hidden="true" />}
            {loading && modelDownloadPct !== null && modelDownloadPct < 100 && (
              <div className="model-download-progress" role="status" aria-live="polite">
                <div className="model-download-head">
                  <strong>Downloading model: {model}</strong>
                  <span>{modelDownloadPct}%</span>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${modelDownloadPct}%` }} />
                </div>
                <p className="small-text">{modelDownloadText}</p>
              </div>
            )}
            {!loading && !selectedModelReady && (
              <p className="small-text model-download-hint">
                Model <strong>{model}</strong> belum terdownload. Saat generate pertama kali, model akan diunduh dulu.
              </p>
            )}
            {(loading || progressLog.length > 0) && (
              <div className="progress-log" role="log" aria-live="polite">
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                {progressLog.map((s, i) => (
                  <div
                    key={i}
                    className={`progress-log-item${i === progressLog.length - 1 && loading ? " current" : " done"}`}
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
                <span className="step-summary-title">Generated</span>
                <span className="step-summary-detail">{segments.length} caption entries</span>
              </div>
            </div>
            <span className="step-summary-edit">Re-generate</span>
          </button>
        ) : null}

        {/* Step 4 — Review workspace (2-column) */}
        {activeStep === 4 && result && (
          <section className="step-card step-card-review">
            <header className="step-header step-header-inline">
              <div>
                <span className="section-kicker">Step 4</span>
                <h3>Review &amp; edit</h3>
              </div>
              <div className="caption-summary-pills">
                <span className="pill-badge primary">{segments.length} entries</span>
                {result.language_detected && (
                  <span className="pill-badge muted">Detected: {result.language_detected}</span>
                )}
                <button type="button" className="btn btn-primary" onClick={() => { markDone(4); goTo(5); }}>
                  Done — Export
                </button>
              </div>
            </header>
            <div className="review-workspace">
              <div className="review-caption-list" ref={reviewListRef}>
                {segments.map((segment, idx) => (
                  <article
                    key={`${segment.start}-${idx}`}
                    className={`caption-row${idx === activeIndex ? " active" : ""}`}
                    ref={(el) => {
                      if (el) {
                        rowRefs.current.set(idx, el);
                      } else {
                        rowRefs.current.delete(idx);
                      }
                    }}
                  >
                    <div className="caption-row-meta">
                      <div className="caption-row-meta-main">
                        <span className="caption-row-index">{idx + 1}</span>
                        <span className="pill-badge primary caption-time-badge">
                          {formatTime(segment.start)} &ndash; {formatTime(segment.end)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="pill"
                        aria-label={`Preview segment ${idx + 1}`}
                        onClick={() => {
                          if (audioRef.current) {
                            audioRef.current.currentTime = segment.start;
                            audioRef.current.play().catch(() => undefined);
                          }
                          setActiveIndex(idx);
                        }}
                      >
                        Preview
                      </button>
                    </div>
                    <textarea
                      value={segment.text}
                      rows={2}
                      onChange={(e) => {
                        const next = [...segments];
                        next[idx] = { ...segment, text: e.target.value };
                        setEditableSegments(next);
                      }}
                    />
                  </article>
                ))}
              </div>
              <aside className="review-player-panel">
                <p className="field-label">Audio preview</p>
                {!audioUrl && !restoringDraft && (
                  <p className="small-text review-player-warning">
                    Preview audio tidak tersedia setelah refresh. Upload ulang source audio untuk sync playback.
                  </p>
                )}
                {restoringDraft && (
                  <p className="small-text review-player-warning">
                    Memulihkan audio draft...
                  </p>
                )}
                <audio
                  ref={audioRef}
                  controls
                  src={audioUrl}
                  className="full-audio"
                  onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime;
                    const idx = getActiveSegmentIndex(segments, t);
                    setActiveIndex((prev) => (prev === idx ? prev : idx));
                  }}
                  onPlay={(e) => {
                    const idx = getActiveSegmentIndex(segments, e.currentTarget.currentTime);
                    setActiveIndex((prev) => (prev === idx ? prev : idx));
                  }}
                  onSeeked={(e) => {
                    const idx = getActiveSegmentIndex(segments, e.currentTarget.currentTime);
                    setActiveIndex((prev) => (prev === idx ? prev : idx));
                  }}
                />
                <div className="review-meta">
                  <div>
                    <span className="small-text">Entries</span>
                    <strong>{segments.length}</strong>
                  </div>
                  <div>
                    <span className="small-text">Language</span>
                    <strong>{result.language_detected || langLabel}</strong>
                  </div>
                  <div>
                    <span className="small-text">Mode</span>
                    <strong>{granLabel}</strong>
                  </div>
                </div>
                <p className="review-player-hint small-text">
                  Click Preview on any row to jump to that moment in the audio.
                </p>
                <button type="button" className="btn btn-outline btn-full" onClick={clearDraft}>
                  Clear saved draft
                </button>
              </aside>
            </div>
          </section>
        )}

        {/* Step 5 — Export */}
        {activeStep === 5 ? (
          <section className="step-card">
            <header className="step-header step-header-inline">
              <div>
                <span className="section-kicker">Step 5</span>
                <h3>Export captions</h3>
              </div>
              <button type="button" className="btn btn-outline" onClick={() => goTo(4)}>
                Back to Review
              </button>
            </header>
            <div className="export-meta">
              <div className="export-meta-item">
                <span className="small-text">Format</span>
                <strong>.SRT</strong>
              </div>
              <div className="export-meta-item">
                <span className="small-text">Entries</span>
                <strong>{segments.length}</strong>
              </div>
              <div className="export-meta-item">
                <span className="small-text">Language</span>
                <strong>{result?.language_detected || langLabel}</strong>
              </div>
            </div>
            <button type="button" className="btn btn-primary btn-full btn-tall" onClick={downloadSrt}>
              Download .SRT file
            </button>
            <p className="small-text">All edits from the Review step are included in the export.</p>
          </section>
        ) : completedSteps.has(5) ? (
          <button type="button" className="step-summary-card step-summary-success" onClick={() => goTo(5)}>
            <div className="step-summary-left">
              <span className="step-summary-check"><CheckIcon /></span>
              <div>
                <span className="step-summary-title">Exported</span>
                <span className="step-summary-detail">caption_[timestamp]_{language}.srt</span>
              </div>
            </div>
            <span className="step-summary-edit">Download again</span>
          </button>
        ) : null}

      </div>
    </div>
  );
}

export default CaptionTool;
