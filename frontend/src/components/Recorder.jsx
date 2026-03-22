import { useEffect, useRef, useState } from "react";
import SiriWave from "siriwave";

function Recorder({ onAudioReady }) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [recorderError, setRecorderError] = useState("");
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioUrlRef = useRef("");
  const isRecordingRef = useRef(false);
  const siriContainerRef = useRef(null);
  const siriWaveRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const animationFrameRef = useRef(null);
  const waveAmplitudeRef = useRef(1.5);

  const ensureSiriWave = () => {
    if (siriWaveRef.current || !siriContainerRef.current) return;
    const host = siriContainerRef.current;
    const width = Math.max(280, Math.floor(host.clientWidth || 0));

    siriWaveRef.current = new SiriWave({
      container: host,
      width,
      height: 128,
      style: "ios9",
      autostart: true,
      speed: 0.12,
      amplitude: waveAmplitudeRef.current,
      lerpSpeed: 0.06,
      cover: true,
      curveDefinition: [
        { color: "109, 140, 183", supportLine: true },
        { color: "15, 82, 169" },
        { color: "38, 157, 123" },
        { color: "173, 57, 76" },
      ],
    });
  };

  const recreateSiriWave = () => {
    if (siriWaveRef.current) {
      siriWaveRef.current.dispose();
      siriWaveRef.current = null;
    }
    ensureSiriWave();
    siriWaveRef.current?.setAmplitude(waveAmplitudeRef.current);
  };

  const setIdleAmplitude = () => {
    waveAmplitudeRef.current = 1.5;
    siriWaveRef.current?.setAmplitude(1.5);
  };

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
    setIdleAmplitude();
  };

  const startVisualizer = (stream) => {
    stopVisualizer();
    ensureSiriWave();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.88;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = ctx;
    analyserRef.current = analyser;
    sourceNodeRef.current = source;

    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const draw = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < bufferLength; i += 1) {
        const normalized = (dataArray[i] - 128) / 128;
        const abs = Math.abs(normalized);
        sumSquares += normalized * normalized;
        if (abs > peak) peak = abs;
      }

      const rms = Math.sqrt(sumSquares / bufferLength);
      const targetAmplitude = Math.min(3.5, 1.0 + rms * 14.0 + peak * 5.5);
      waveAmplitudeRef.current += (targetAmplitude - waveAmplitudeRef.current) * 0.3;

      siriWaveRef.current?.setAmplitude(Math.max(1.0, waveAmplitudeRef.current));

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
    ensureSiriWave();
    const onResize = () => {
      recreateSiriWave();
      if (!isRecordingRef.current) {
        setIdleAmplitude();
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      stopVisualizer();
      if (siriWaveRef.current) {
        siriWaveRef.current.dispose();
        siriWaveRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const startRecording = async () => {
    try {
      setRecorderError("");
      ensureSiriWave();
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
      stopVisualizer();
      setRecorderError("Microphone access was blocked. Please allow mic permission and try again.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopVisualizer();
    setIsRecording(false);
  };

  const rerecord = () => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    setRecorderError("");
    stopVisualizer();
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
        <div ref={siriContainerRef} className="recorder-wave-canvas" aria-hidden="true" />
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
