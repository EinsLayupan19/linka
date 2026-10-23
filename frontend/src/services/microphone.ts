/** Thrown when the microphone cannot be used; `message` is ready to show. */
export class MicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

/**
 * Asks for the microphone (the browser shows its permission prompt the first time). Calls ask for
 * it before ringing anyone, so a blocked microphone never leaves the other person waiting.
 */
export async function getMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('Calls need a secure (https) connection and a browser that supports them.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    const name = error instanceof DOMException || error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneError('Linka needs your microphone for calls. Allow it in your browser’s site settings, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicrophoneError('No microphone was found.');
    if (name === 'NotReadableError') throw new MicrophoneError('Your microphone is being used by another app.');
    throw new MicrophoneError('Could not start the microphone.');
  }
}

/** Turns the microphone off for good (the browser's recording indicator goes away). */
export function stopStream(stream: MediaStream | null | undefined) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
