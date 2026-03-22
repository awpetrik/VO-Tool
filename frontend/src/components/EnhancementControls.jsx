import { Mic, Headphones, Radio, PhoneCall, Users, SlidersHorizontal } from "lucide-react";

const PRESETS = {
  Podcast:        { noise_reduction: 80, clarity: 70, de_reverb: 30, compression: 70, normalize: true },
  "Voice Over":   { noise_reduction: 70, clarity: 90, de_reverb: 65, compression: 60, normalize: true },
  Vocal:          { noise_reduction: 60, clarity: 80, de_reverb: 50, compression: 50, normalize: true },
  "Call Recording": { noise_reduction: 90, clarity: 60, de_reverb: 60, compression: 80, normalize: true },
  Interview:      { noise_reduction: 75, clarity: 65, de_reverb: 40, compression: 65, normalize: true },
};

const PRESET_META = {
  Podcast:          { icon: Radio,       desc: "Balanced voice for spoken content" },
  "Voice Over":     { icon: Mic,         desc: "Studio-clear narration & VO" },
  Vocal:            { icon: Headphones,  desc: "Singing & expressive voice" },
  "Call Recording": { icon: PhoneCall,   desc: "Heavily compressed call audio" },
  Interview:        { icon: Users,       desc: "Multi-speaker conversation" },
};

const SLIDERS = [
  { key: "noise_reduction", label: "Noise Reduction", hint: "Removes hiss & background noise" },
  { key: "clarity",         label: "Clarity",         hint: "Sharpens speech intelligibility" },
  { key: "de_reverb",       label: "De-reverb",       hint: "Reduces room echo" },
  { key: "compression",     label: "Compression",     hint: "Evens out volume dynamics" },
];

const DEFAULT_CLEAN_SETTINGS = {
  filler_removal: false,
  silence_trim: false,
  max_pause_sec: 0.8,
  custom_fillers: "",
};

function EnhancementControls({ settings, setSettings, activePreset, setActivePreset, embedded = false, showTitle = true }) {
  const cleanSettings = { ...DEFAULT_CLEAN_SETTINGS, ...(settings.clean_settings || {}) };

  const setPreset = (name) => {
    if (name === "Custom") { setActivePreset("Custom"); return; }
    setActivePreset(name);
    setSettings((prev) => ({
      ...PRESETS[name],
      clean_settings: { ...DEFAULT_CLEAN_SETTINGS, ...(prev.clean_settings || {}) },
    }));
  };

  const setValue = (key, value) => {
    setActivePreset("Custom");
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const setCleanValue = (key, value) => {
    setActivePreset("Custom");
    setSettings((prev) => ({
      ...prev,
      clean_settings: {
        ...DEFAULT_CLEAN_SETTINGS,
        ...(prev.clean_settings || {}),
        [key]: value,
      },
    }));
  };

  return (
    <section className={embedded ? "enhancement-controls" : "card enhancement-controls"}>
      {showTitle && <h3>Enhancement Controls</h3>}

      {/* ── Preset grid ── */}
      <div className="ec-preset-grid">
        {Object.keys(PRESETS).map((name) => {
          const meta = PRESET_META[name];
          const Icon = meta.icon;
          const active = activePreset === name;
          return (
            <button
              key={name}
              type="button"
              className={`ec-preset-card${active ? " active" : ""}`}
              onClick={() => setPreset(name)}
              aria-pressed={active}
            >
              <span className="ec-preset-icon"><Icon size={15} strokeWidth={2} /></span>
              <span className="ec-preset-name">{name}</span>
              <span className="ec-preset-desc">{meta.desc}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`ec-preset-card ec-preset-custom${activePreset === "Custom" ? " active" : ""}`}
          onClick={() => setPreset("Custom")}
          aria-pressed={activePreset === "Custom"}
        >
          <span className="ec-preset-icon"><SlidersHorizontal size={15} strokeWidth={2} /></span>
          <span className="ec-preset-name">Custom</span>
          <span className="ec-preset-desc">Manual fine-tune</span>
        </button>
      </div>

      {/* ── Sliders ── */}
      <div className="ec-slider-stack">
        {SLIDERS.map(({ key, label, hint }) => (
          <div key={key} className="ec-slider-row">
            <div className="ec-slider-head">
              <span className="ec-slider-label">{label}</span>
              <span className="ec-slider-hint">{hint}</span>
              <span className="ec-slider-value">{settings[key]}</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={settings[key]}
              onChange={(e) => setValue(key, Number(e.target.value))}
              aria-label={label}
            />
            <div className="ec-slider-track-labels">
              <span>0</span><span>50</span><span>100</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Clean speech ── */}
      <div className="ec-clean-card">
        <div className="ec-clean-head">
          <span className="ec-clean-title">Clean Speech</span>
          <span className="ec-clean-subtitle">Remove unnecessary fillers and trim long pauses</span>
        </div>

        <div className="ec-clean-row">
          <div>
            <span className="ec-clean-label">Remove filler words</span>
            <span className="ec-clean-help">Default is ultra-conservative: umm, uhh, ehh, eee, hmm only.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cleanSettings.filler_removal}
            className={`ec-toggle${cleanSettings.filler_removal ? " on" : ""}`}
            onClick={() => setCleanValue("filler_removal", !cleanSettings.filler_removal)}
            aria-label="Toggle filler removal"
          >
            <span className="ec-toggle-thumb" />
          </button>
        </div>

        <label className="ec-clean-input-wrap" htmlFor="custom-fillers">
          <span className="ec-clean-label">Custom fillers (optional)</span>
          <input
            id="custom-fillers"
            type="text"
            placeholder="nah, anu, ya kan, gitu"
            value={cleanSettings.custom_fillers}
            onChange={(e) => setCleanValue("custom_fillers", e.target.value)}
          />
        </label>

        <div className="ec-clean-row">
          <div>
            <span className="ec-clean-label">Trim long silences</span>
            <span className="ec-clean-help">Keep natural pacing by capping pause length.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cleanSettings.silence_trim}
            className={`ec-toggle${cleanSettings.silence_trim ? " on" : ""}`}
            onClick={() => setCleanValue("silence_trim", !cleanSettings.silence_trim)}
            aria-label="Toggle silence trim"
          >
            <span className="ec-toggle-thumb" />
          </button>
        </div>

        <div className={`ec-pause-row${cleanSettings.silence_trim ? "" : " disabled"}`}>
          <div className="ec-slider-head">
            <span className="ec-slider-label">Max Pause</span>
            <span className="ec-slider-hint">Pauses above this will be shortened</span>
            <span className="ec-slider-value">{cleanSettings.max_pause_sec.toFixed(1)}s</span>
          </div>
          <input
            type="range"
            min="0.4"
            max="1.8"
            step="0.1"
            value={cleanSettings.max_pause_sec}
            onChange={(e) => setCleanValue("max_pause_sec", Number(e.target.value))}
            disabled={!cleanSettings.silence_trim}
            aria-label="Maximum pause length"
          />
        </div>
      </div>

      {/* ── Normalize toggle ── */}
      <div className="ec-normalize-row">
        <div className="ec-normalize-info">
          <span className="ec-normalize-label">Normalize</span>
          <span className="ec-normalize-desc">Target –14 LUFS for consistent loudness</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.normalize}
          className={`ec-toggle${settings.normalize ? " on" : ""}`}
          onClick={() => setValue("normalize", !settings.normalize)}
          aria-label="Toggle normalize"
        >
          <span className="ec-toggle-thumb" />
        </button>
      </div>
    </section>
  );
}

export default EnhancementControls;
