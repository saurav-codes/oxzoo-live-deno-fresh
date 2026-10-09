import { useSignal } from "@preact/signals";

interface Health {
  name: string;
  server: string;
  release: string;
  uptime_s: number;
}

export default function HealthCheck() {
  const clicks = useSignal(0);
  const result = useSignal("not checked yet");

  async function check() {
    clicks.value += 1;
    try {
      const res = await fetch("/_zoo/health", { signal: AbortSignal.timeout(5000) });
      const h: Health = await res.json();
      result.value = `${h.name}@${h.server}, release ${h.release}, up ${h.uptime_s} s`;
    } catch (e) {
      result.value = `failed: ${(e as Error).message}`;
    }
  }

  return (
    <div style="border: 1px solid #ddd; border-radius: 14px; padding: 1rem">
      <button type="button" id="check" onClick={check}>Check health from the browser</button>
      <p>
        Checks: <span id="clicks">{clicks}</span>. Last: <span id="result">{result}</span>
      </p>
    </div>
  );
}
