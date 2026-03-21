import { useRef, useState } from "react";

function Uploader({ accept, onAudioReady }) {
  const [isDragging, setIsDragging] = useState(false);
  const [filename, setFilename] = useState("");
  const inputRef = useRef(null);

  const selectFile = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setFilename(file.name);
    onAudioReady(file, url);
  };

  return (
    <section
      className={`card upload-card ${isDragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        selectFile(e.dataTransfer.files[0]);
      }}
    >
      <h3>Uploader</h3>
      <p>Drag &amp; drop your file or browse from your device.</p>
      <p className="small-text">Accepted: {accept}</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => selectFile(e.target.files?.[0])}
      />
      <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
        Choose file
      </button>
      {filename && <span className="pill-badge muted">{filename}</span>}
    </section>
  );
}

export default Uploader;
