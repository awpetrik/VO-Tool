const PRESETS = {
  Podcast: { noise_reduction: 80, clarity: 70, de_reverb: 30, compression: 70, normalize: true },
  Vocal: { noise_reduction: 60, clarity: 80, de_reverb: 50, compression: 50, normalize: true },
  "Call Recording": { noise_reduction: 90, clarity: 60, de_reverb: 60, compression: 80, normalize: true },
  Interview: { noise_reduction: 75, clarity: 65, de_reverb: 40, compression: 65, normalize: true },
};

function EnhancementControls({ settings, setSettings, activePreset, setActivePreset, embedded = false, showTitle = true }) {
  const setPreset = (name) => {
    if (name === "Custom") {
      setActivePreset("Custom");
      return;
    }
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
      <div className="pill-row">
        {Object.keys(PRESETS)
          .concat("Custom")
          .map((preset) => (
            <button
              key={preset}
              className={`pill ${activePreset === preset ? "active" : ""}`}
              onClick={() => setPreset(preset)}
            >
              {preset}
            </button>
          ))}
      </div>

      <div className="slider-grid">
        <label>
          Noise Reduction: {settings.noise_reduction}
          <input
            type="range"
            min="0"
            max="100"
            value={settings.noise_reduction}
            onChange={(e) => setValue("noise_reduction", Number(e.target.value))}
          />
        </label>

        <label>
          Clarity: {settings.clarity}
          <input
            type="range"
            min="0"
            max="100"
            value={settings.clarity}
            onChange={(e) => setValue("clarity", Number(e.target.value))}
          />
        </label>

        <label>
          De-reverb: {settings.de_reverb}
          <input
            type="range"
            min="0"
            max="100"
            value={settings.de_reverb}
            onChange={(e) => setValue("de_reverb", Number(e.target.value))}
          />
        </label>

        <label>
          Compression: {settings.compression}
          <input
            type="range"
            min="0"
            max="100"
            value={settings.compression}
            onChange={(e) => setValue("compression", Number(e.target.value))}
          />
        </label>
      </div>

      <label className="normalize-toggle">
        <input
          type="checkbox"
          checked={settings.normalize}
          onChange={(e) => setValue("normalize", e.target.checked)}
        />
        Normalize (-14 LUFS)
      </label>
    </section>
  );
}

export default EnhancementControls;
