import { useEffect, useMemo, useState } from "react";
import { InboxTriageModal } from "../../components/InboxTriageModal";
import { authTelegram, getInbox, getTelegramInitDataRaw, triageInboxItem } from "../../lib/api";
import type { InboxItem } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";

type AuthState = "idle" | "authenticating" | "ready" | "error";

function previewText(item: InboxItem): string {
  return item.raw_text ?? item.transcript_text ?? "(voice placeholder)";
}

function sourceLabel(item: InboxItem): string {
  return `${item.source_channel} / ${item.source_type}`;
}

export function InboxPage() {
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [manualInitData, setManualInitData] = useState("");
  const [sessionToken, setSessionToken] = useState<string>(localStorage.getItem(SESSION_KEY) ?? "");
  const [triageLoading, setTriageLoading] = useState(false);
  const [pendingTriage, setPendingTriage] = useState<{ item: InboxItem; mode: "task" | "note" } | null>(null);

  const initDataRaw = useMemo(() => getTelegramInitDataRaw(), []);

  function resetSession() {
    localStorage.removeItem(SESSION_KEY);
    setSessionToken("");
    setItems([]);
    setError(null);
    setAuthState("idle");

    if (initDataRaw) {
      void runAuth(initDataRaw);
    }
  }

  async function loadInbox(token: string) {
    setLoadingItems(true);
    try {
      const inboxItems = await getInbox(token);
      setItems(inboxItems);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load inbox");
    } finally {
      setLoadingItems(false);
    }
  }

  async function runAuth(initData: string) {
    setAuthState("authenticating");
    setError(null);

    try {
      const session = await authTelegram(initData);
      localStorage.setItem(SESSION_KEY, session.token);
      setSessionToken(session.token);
      setAuthState("ready");
      await loadInbox(session.token);
    } catch (authError) {
      setAuthState("error");
      setError(authError instanceof Error ? authError.message : "Authentication failed");
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();

    const boot = async () => {
      if (sessionToken) {
        setAuthState("ready");
        await loadInbox(sessionToken);
        return;
      }

      if (initDataRaw) {
        await runAuth(initDataRaw);
      }
    };

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTriage(item: InboxItem, action: "task" | "note" | "discard") {
    if (!sessionToken) return;

    setError(null);

    try {
      if (action === "discard") {
        await triageInboxItem({
          sessionToken,
          inboxItemId: item.id,
          action
        });
        await loadInbox(sessionToken);
        return;
      }

      setPendingTriage({ item, mode: action });
    } catch (triageError) {
      setError(triageError instanceof Error ? triageError.message : "Failed to triage inbox item");
    }
  }

  async function confirmModalTriage(payload: { title?: string; noteBody?: string }) {
    if (!sessionToken || !pendingTriage) return;

    setTriageLoading(true);
    setError(null);

    try {
      await triageInboxItem({
        sessionToken,
        inboxItemId: pendingTriage.item.id,
        action: pendingTriage.mode,
        title: payload.title,
        noteBody: payload.noteBody
      });

      setPendingTriage(null);
      await loadInbox(sessionToken);
    } catch (triageError) {
      setError(triageError instanceof Error ? triageError.message : "Failed to triage inbox item");
    } finally {
      setTriageLoading(false);
    }
  }

  return (
    <section className="panel">
      <h2>Inbox</h2>
      <p>Real capture queue from Telegram bot and Mini App.</p>
      {sessionToken ? (
        <div className="toolbar-row">
          <button onClick={resetSession}>Reset session</button>
        </div>
      ) : null}

      {!initDataRaw && !sessionToken ? (
        <div className="dev-auth-box">
          <p className="empty-note">
            Telegram initData not detected. For local testing, paste initData and authenticate.
          </p>
          <textarea
            value={manualInitData}
            onChange={(event) => setManualInitData(event.target.value)}
            placeholder="Paste Telegram WebApp initData"
            rows={4}
          />
          <button
            onClick={() => void runAuth(manualInitData.trim())}
            disabled={authState === "authenticating" || !manualInitData.trim()}
          >
            {authState === "authenticating" ? "Authenticating..." : "Authenticate"}
          </button>
        </div>
      ) : null}

      {error ? <p className="error-note">{error}</p> : null}

      {authState === "authenticating" ? <p>Authenticating...</p> : null}
      {loadingItems ? <p>Loading inbox...</p> : null}

      {!loadingItems && items.length === 0 ? (
        <p className="empty-note">Inbox is empty.</p>
      ) : (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id} className="inbox-item">
              <p className="inbox-main-text">{previewText(item)}</p>
              <p className="inbox-meta">
                {sourceLabel(item)} · {new Date(item.captured_at).toLocaleString()}
              </p>
              <div className="inbox-actions">
                <button onClick={() => void handleTriage(item, "task")}>To Task</button>
                <button onClick={() => void handleTriage(item, "note")}>To Note</button>
                <button className="danger" onClick={() => void handleTriage(item, "discard")}>
                  Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <InboxTriageModal
        open={Boolean(pendingTriage)}
        mode={pendingTriage?.mode ?? null}
        sourceText={pendingTriage ? previewText(pendingTriage.item) : ""}
        busy={triageLoading}
        onCancel={() => setPendingTriage(null)}
        onConfirm={(payload) => {
          void confirmModalTriage(payload);
        }}
      />
    </section>
  );
}
