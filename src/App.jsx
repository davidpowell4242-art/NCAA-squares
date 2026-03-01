import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const DIGITS = Array.from({ length: 10 }, (_, i) => i);
const BOARD_ID = import.meta.env.VITE_BOARD_ID;
const keyOf = (r, c) => `${r}-${c}`;

export default function App() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  const [board, setBoard] = useState(null);
  const [profile, setProfile] = useState(null);
  const [squares, setSquares] = useState([]);
  const [holds, setHolds] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendLink() {
    setMsg("");
    try {
      await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      setMsg("Check your email for the sign-in link.");
    } catch (e) {
      setMsg(e?.message ?? "Failed to send sign-in link.");
    }
  }

  async function loadAll() {
    const { data: b } = await supabase
      .from("boards")
      .select("*")
      .eq("id", BOARD_ID)
      .single();

    const { data: s } = await supabase
      .from("squares")
      .select("id,row,col,state,owner_user_id")
      .eq("board_id", BOARD_ID);

    const { data: h } = await supabase
      .from("holds")
      .select("square_id,user_id,expires_at")
      .eq("board_id", BOARD_ID);

    setBoard(b);
    setSquares(s ?? []);
    setHolds(h ?? []);

    if (session?.user?.id) {
      const { data: p } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("user_id", session.user.id)
        .single();
      setProfile(p ?? null);
    }
  }

  useEffect(() => {
    if (!session) return;

    let cleanup = () => {};
    (async () => {
      setLoading(true);
      await loadAll();
      setLoading(false);

      const ch = supabase
        .channel(`board:${BOARD_ID}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "squares", filter: `board_id=eq.${BOARD_ID}` },
          loadAll
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "holds", filter: `board_id=eq.${BOARD_ID}` },
          loadAll
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "boards", filter: `id=eq.${BOARD_ID}` },
          loadAll
        )
        .subscribe();

      cleanup = () => supabase.removeChannel(ch);
    })();

    return cleanup;
  }, [session]);

  const squareMap = useMemo(() => {
    const m = new Map();
    for (const s of squares) m.set(keyOf(s.row, s.col), s);
    return m;
  }, [squares]);

  const holdsBySquare = useMemo(() => {
    const m = new Map();
    for (const h of holds) m.set(h.square_id, h);
    return m;
  }, [holds]);

  async function toggleSquare(square) {
    if (!session || !board) return;
    if (board.status !== "open") return;
    if (square.owner_user_id) return;

    const hold = holdsBySquare.get(square.id);
    const isMine = hold && hold.user_id === session.user.id;

    if (isMine) {
      await supabase.rpc("release_hold", { p_square_id: square.id });
    } else {
      await supabase.rpc("try_hold_square", { p_square_id: square.id });
    }
  }

  function classFor(square) {
    const hold = holdsBySquare.get(square.id);
    const held = !!hold;
    const mine = held && session?.user?.id && hold.user_id === session.user.id;

    if (square.owner_user_id) return "cell purchased";
    if (mine) return "cell mine";
    if (held) return "cell held";
    return "cell";
  }

  const topDigits =
    Array.isArray(board?.top_digits) && board.top_digits.length === 10
      ? board.top_digits
      : Array(10).fill("#");

  const sideDigits =
    Array.isArray(board?.side_digits) && board.side_digits.length === 10
      ? board.side_digits
      : Array(10).fill("#");

  async function closeBoard() {
    await supabase.from("boards").update({ status: "closed" }).eq("id", BOARD_ID);
  }

  async function revealNumbers() {
    await supabase.rpc("admin_reveal_digits", { p_board_id: BOARD_ID });
  }

  async function resetBoard() {
    if (!confirm("Are you sure you want to completely reset the board?")) return;
    await supabase.rpc("admin_reset_board", { p_board_id: BOARD_ID });
  }

  useEffect(() => {
    const css = `
      .page{font-family:system-ui,Arial,sans-serif;max-width:1000px;margin:0 auto;padding:20px;}
      .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
      input{padding:10px;border-radius:10px;border:1px solid #ddd;width:280px;}
      button{padding:10px 12px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;}
      button:disabled{opacity:.6;}

      .board-wrapper{margin-top:20px;}

      .board-layout{
        display:grid;
        grid-template-columns: 40px auto;
        column-gap: 12px;
      }

      .side-label{
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
        font-size:20px;
        writing-mode:vertical-rl;
        transform:rotate(180deg);
      }

      .content{display:block;}

      .top-grid{
        display:grid;
        grid-template-columns:42px repeat(10,42px);
        gap:6px;
        margin-bottom:8px;
      }

      .top-title{
        grid-column:2 / 12;
        text-align:center;
        font-weight:700;
        font-size:20px;
      }

      .board-shell{
        display:flex;
      }

      .board{
        display:grid;
        grid-template-columns:42px repeat(10,42px);
        grid-auto-rows:42px;
        gap:6px;
      }

      .corner{width:42px;height:42px;}
      .hdr{display:flex;align-items:center;justify-content:center;font-weight:700;background:#f2f2f2;border-radius:10px;}
      .row{display:contents;}

      .cell{width:42px;height:42px;border-radius:10px;border:1px solid #ddd;background:#fff;}
      .cell.held{background:#e9e9e9;}
      .cell.mine{outline:3px solid #111;outline-offset:-3px;}
      .cell.purchased{background:#111;border-color:#111;}
    `;
    const style = document.createElement("style");
    style.innerHTML = css;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  if (!session) {
    return (
      <div className="page">
        <h1>NCAA Squares</h1>
        <input
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button onClick={sendLink} disabled={!email}>
          Send sign-in link
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="topbar">
        <h1>{board?.name ?? "Board"}</h1>
        <div style={{ display: "flex", gap: 10 }}>
          {profile?.is_admin && (
            <>
              <button onClick={closeBoard}>Close Board</button>
              <button onClick={revealNumbers}>Reveal Numbers</button>
              <button onClick={resetBoard}>Reset Board</button>
            </>
          )}
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>

      {loading && <div>Loading...</div>}

      <div className="board-wrapper">
        <div className="board-layout">
          <div className="side-label">Away Team</div>

          <div className="content">
            <div className="top-grid">
              <div className="corner" />
              <div className="top-title">Home Team</div>
            </div>

            <div className="board-shell">
              <div className="board">
                <div className="corner" />
                {topDigits.map((d, i) => (
                  <div key={i} className="hdr">{d}</div>
                ))}

                {DIGITS.map((r) => (
                  <div key={r} className="row">
                    <div className="hdr">{sideDigits[r]}</div>
                    {DIGITS.map((c) => {
                      const sq = squareMap.get(keyOf(r, c));
                      if (!sq) return <div key={c} className="cell" />;

                      return (
                        <button
                          key={sq.id}
                          className={classFor(sq)}
                          onClick={() => toggleSquare(sq)}
                          disabled={board?.status !== "open" || !!sq.owner_user_id}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}