import { useEffect, useRef, useState } from "react";

function Recorder({ onAudioReady }) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [recorderError, setRecorderError] = useState("");
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioUrlRef = useRef("");
  const isRecordingRef = useRef(false);
  const canvasRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const animationFrameRef = useRef(null);

  const stopVisualizer = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {
        // Ignore close errors when context already closed.
      });
      audioContextRef.current = null;
    }
  };

  const drawIdleWave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(280, Math.floor(canvas.clientWidth || 0));
    const height = 88;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#d6deea";
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  };

  const startVisualizer = (stream) => {
    stopVisualizer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = ctx;
    analyserRef.current = analyser;
    sourceNodeRef.current = source;

    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasCtx = canvas.getContext("2d");
    if (!canvasCtx) return;

    const draw = () => {
      const width = Math.max(280, Math.floor(canvas.clientWidth || 0));
      const height = 88;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      analyser.getByteTimeDomainData(dataArray);
      canvasCtx.clearRect(0, 0, width, height);
      canvasCtx.lineWidth = 2.2;
      canvasCtx.strokeStyle = "#3d5a80";
      canvasCtx.beginPath();

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i += 1) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
  };

  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    drawIdleWave();
    const onResize = () => {
      if (!isRecordingRef.current) drawIdleWave();
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      stopVisualizer();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const startRecording = async () => {
    try {
      setRecorderError("");
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
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        onAudioReady(file, url);
      };

      startVisualizer(stream);
      recorder.start();
      setIsRecording(true);
    } catch {
      setRecorderError("Microphone access was blocked. Please allow mic permission and try again.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopVisualizer();
    drawIdleWave();
    setIsRecording(false);
  };

  const rerecord = () => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    setRecorderError("");
    drawIdleWave();
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

      <div className={`recorder-wave-shell${isRecording ? " is-live" : ""}`}>
        <canvas ref={canvasRef} className="recorder-wave-canvas" aria-hidden="true" />
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

      {recorderError && <p className="small-text" role="alert">{recorderError}</p>}

      {audioUrl && <audio controls src={audioUrl} className="full-audio" />}
    </section>
  );
}

export default Recorder;
