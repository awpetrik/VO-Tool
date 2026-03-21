import { useEffect, useRef, useState } from "react";

function Recorder({ onAudioReady }) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const file = new File([blob], "recording.webm", { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      onAudioReady(file, url);
    };

    recorder.start();
    setIsRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setIsRecording(false);
  };

  const rerecord = () => {
    setAudioUrl("");
    onAudioReady(null, "");
  };

  return (
    <section className={`card recorder-card ${isRecording ? "recording" : "idle"}`}>
      <div className="card-title-row">
        <h3>Recorder</h3>
        {isRecording && (
          <span className="recording-indicator">
            <span className="pulse-dot" /> Recording...
          </span>
        )}
      </div>

      <div className="visualizer-bars" aria-hidden="true">
        {Array.from({ length: 28 }).map((_, idx) => (
          <span
            key={idx}
            style={{
              height: `${18 + ((idx * 7) % 26)}px`,
              opacity: isRecording ? 1 : 0.45,
            }}
          />
        ))}
      </div>

      <div className="button-row">
        {!isRecording ? (
          <button className="btn btn-primary" onClick={startRecording}>
            Start
          </button>
        ) : (
          <button className="btn btn-accent" onClick={stopRecording}>
            Stop
          </button>
        )}
        <button className="btn btn-outline" onClick={rerecord}>
          Re-record
        </button>
      </div>

      {audioUrl && <audio controls src={audioUrl} className="full-audio" />}
    </section>
  );
}

export default Recorder;
