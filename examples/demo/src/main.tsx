import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WikaClient } from "@wika/core";
import { WikaLike, WikaClaim } from "@wika/react";
import "@wika/react/styles.css";
import "./style.css";

function App() {
  const [client, setClient] = useState<WikaClient | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const endpoint = import.meta.env.VITE_WIKA_NODE_URL || "ws://127.0.0.1:9944";
  const url = import.meta.env.VITE_WIKA_PAGE_URL || "https://wika.network/demo";
  useEffect(() => {
    let active = true;
    let connection: WikaClient | undefined;
    setClient(null);
    setError("");
    WikaClient.connect({
      endpoint,
      genesisHash: import.meta.env.VITE_WIKA_GENESIS_HASH || undefined,
    }).then(
      (value) => {
        if (active) {
          connection = value;
          setClient(value);
        } else void value.disconnect();
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
      void connection?.disconnect();
    };
  }, [endpoint, attempt]);
  return (
    <main>
      <p className="eyebrow">WIKA / COMPONENT DEMO</p>
      <h1>
        A little appreciation.
        <br />
        On the open web.
      </h1>
      <p>
        Connect your Wika wallet and send a paid like to a page. Your wallet
        asks you to approve before signing.
      </p>
      <article>
        <h2>A page worth sharing</h2>
        <p>{url}</p>
        {client ? (
          <WikaLike client={client} url={url} appName="Wika component demo" />
        ) : error ? (
          <p role="alert">
            {error}{" "}
            <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          </p>
        ) : (
          <p role="status">Connecting to Wika…</p>
        )}
      </article>
      {client?.supportsSafeClaims && <WikaClaim client={client.claims} url={url} appName="Wika component demo" />}
      <p className="endpoint">Node: {endpoint}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
