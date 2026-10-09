import { health } from "../lib/zoo.ts";
import { info } from "../lib/zoo_app.ts";
import HealthCheck from "../islands/HealthCheck.tsx";

export default function Home() {
  const h = health(info);
  return (
    <main>
      <h1>Deno Fresh 2 on ox</h1>
      <p>
        Server-rendered by <strong>{h.name}@{h.server}</strong>, release <code>{h.release}</code>, {h.build.runtime}.
      </p>
      <p>The island below hydrates in the browser and calls the health endpoint itself.</p>
      <HealthCheck />
      <p>
        <a href="/_zoo/health">health</a> · <a href="/_zoo/probe">probe</a>
      </p>
    </main>
  );
}
