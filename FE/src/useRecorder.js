import { useEffect, useRef, useState } from "react";

// Number of bars in the live waveform, and how often a new one is sampled.
export const BAR_COUNT = 40;
const SAMPLE_MS = 70;

// Once the user has spoken, this much continuous quiet ends the recording.
export const SILENCE_MS = 2000;
// If the user hasn't started speaking by then, the recording gives up.
const NO_SPEECH_MS = 8000;
// The recording ends after this long regardless, e.g. when background noise never goes quiet.
const MAX_RECORDING_MS = 2 * 60 * 1000;
// RMS level (0–1) below which the mic counts as quiet.
const SILENCE_RMS = 0.02;

const emptyLevels = () => Array(BAR_COUNT).fill(0);

// Maps RMS to a 0–1 bar level on a decibel scale (-50 dB → 0, -10 dB → 1),
// which follows perceived loudness far better than raw RMS.
function toLevel(rms) {
  const db = 20 * Math.log10(Math.max(rms, 1e-5));
  return Math.min(1, Math.max(0, (db + 50) / 40));
}

// Pick a format the browser can record; the extension is sent to the
// backend, which uses it when saving the temp file for transcription.
function pickFormat() {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
    { mimeType: "audio/mp4", ext: "m4a" },
  ];
  return (
    candidates.find((c) => window.MediaRecorder?.isTypeSupported(c.mimeType)) ?? {
      mimeType: "",
      ext: "webm",
    }
  );
}

/**
 * Records from the microphone. `levels` holds the recent input levels (0–1,
 * newest last) for drawing a waveform, and `hasSpoken` whether the user has
 * started speaking. `onSilence` is called when the user has spoken and then
 * gone quiet for SILENCE_MS, or the recording reaches MAX_RECORDING_MS;
 * `onNoSpeech` when nothing has been heard after NO_SPEECH_MS.
 */
export function useRecorder({ onSilence, onNoSpeech } = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [hasSpoken, setHasSpoken] = useState(false);
  const [levels, setLevels] = useState(emptyLevels);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const formatRef = useRef(null);
  const meterRef = useRef(null);
  const onSilenceRef = useRef(onSilence);
  const onNoSpeechRef = useRef(onNoSpeech);

  useEffect(() => {
    onSilenceRef.current = onSilence;
    onNoSpeechRef.current = onNoSpeech;
  });

  function startMeter(stream) {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    const startedAt = performance.now();
    let heardSpeech = false;
    let quietSince = null;
    // Set once a callback has fired, so it can't fire again before the recording stops.
    let ended = false;

    const end = (callback) => {
      ended = true;
      callback.current?.();
    };

    const timer = setInterval(() => {
      if (ended) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / samples.length);
      setLevels((prev) => [...prev.slice(1), toLevel(rms)]);

      const now = performance.now();
      if (rms > SILENCE_RMS) {
        if (!heardSpeech) setHasSpoken(true);
        heardSpeech = true;
        quietSince = null;
      } else if (heardSpeech) {
        quietSince ??= now;
        if (now - quietSince >= SILENCE_MS) end(onSilenceRef);
      }

      if (ended) return;
      if (!heardSpeech && now - startedAt >= NO_SPEECH_MS) end(onNoSpeechRef);
      else if (now - startedAt >= MAX_RECORDING_MS) end(onSilenceRef);
    }, SAMPLE_MS);

    meterRef.current = { audioContext, timer };
  }

  function stopMeter() {
    const meter = meterRef.current;
    if (!meter) return;
    clearInterval(meter.timer);
    meter.audioContext.close();
    meterRef.current = null;
  }

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const format = pickFormat();
    const recorder = new MediaRecorder(
      stream,
      format.mimeType ? { mimeType: format.mimeType } : undefined
    );

    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    formatRef.current = format;
    recorderRef.current = recorder;
    setLevels(emptyLevels());
    setHasSpoken(false);
    startMeter(stream);
    recorder.start();
    setIsRecording(true);
  }

  // Resolves to { blob, filename } once the recorder has flushed its data.
  function stop() {
    const recorder = recorderRef.current;
    if (!recorder) return Promise.resolve(null);

    // Clear the ref first so a click racing the silence timer can't stop twice.
    recorderRef.current = null;
    stopMeter();

    return new Promise((resolve) => {
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach((t) => t.stop());
        const { mimeType, ext } = formatRef.current;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        setIsRecording(false);
        resolve({ blob, filename: `recording.${ext}` });
      };
      recorder.stop();
    });
  }

  // Stops recording and discards the audio.
  function cancel() {
    stop();
  }

  // Release the microphone if the component unmounts mid-recording.
  useEffect(
    () => () => {
      stopMeter();
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    []
  );

  return { isRecording, hasSpoken, levels, start, stop, cancel };
}
