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

function EnhancementControls({ settings, setSettings, activePreset, setActivePreset, embedded = false, showTitle = true }) {
  const setPreset = (name) => {
    if (name === "Custom") { setActivePreset("Custom"); return; }
    setActivePreset(name);
    setSettings(PRESETS[name]);
  };

  const setValue = (key, value) => {
    setActivePreset("Custom");
    setSettings((prev) => ({ ...prev, [key]: value }));
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
