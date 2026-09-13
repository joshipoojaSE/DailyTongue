import { useRef, useState } from "react";

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

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const formatRef = useRef(null);

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
    recorder.start();
    setIsRecording(true);
  }

  // Resolves to { blob, filename } once the recorder has flushed its data.
  function stop() {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder) return resolve(null);

      recorder.onstop = () => {
        recorder.stream.getTracks().forEach((t) => t.stop());
        const { mimeType, ext } = formatRef.current;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        recorderRef.current = null;
        setIsRecording(false);
        resolve({ blob, filename: `recording.${ext}` });
      };
      recorder.stop();
    });
  }

  return { isRecording, start, stop };
}
