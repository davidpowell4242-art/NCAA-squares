import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const DIGITS = Array.from({ length: 10 }, (_, i) => i);
const BOARD_ID = import.meta.env.VITE_BOARD_ID;
const keyOf = (r, c) => `${r}-${c}`;

function msToMMSS(ms) {
  if (ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  const [board, setBoard] = useState(null);
  const [profile, setProfile] = useState(null);

  const [squares, setSquares] = useState([]);
  const [holds, setHolds] = useState([]);
  const [loading, setLoading] = useState(true);

  // live clock for countdown
  const [now, setNow] = useState(Date.now());

  // admin selection + payment flow B
  const [adminSelected, setAdminSelected] = useState(() => new Set()); // square ids
  const [buyerEmail, setBuyerEmail] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  // owner display lookup
  const [ownerNameByUserId, setOwnerNameByUserId] = useState({});

  // AUTH
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // countdown tick
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session]);

  async function sendLink() {
	setMsg("");
	try {
	const { error } = await supabase.auth.signInWithOtp({
	email,
	options: { emailRedirectTo: window.location.origin },
	});
	if (error) throw error;
	setMsg("Check your email for the sign-in link.");
	} catch (e) {
	setMsg(e?.message ?? "Failed to send sign-in link.");
	}
}

  async function loadAll() {
    const { data: b, error: be } = await supabase
      .from("boards")
      .select("*")
      .eq("id", BOARD_ID)
      .single();
    if (be) throw be;

    const { data: s, error: se } = await supabase
      .from("squares")
      .select("id,row,col,state,owner_user_id")
      .eq("board_id", BOARD_ID);
    if (se) throw se;

    const { data: h, error: he } = await supabase
      .from("holds")
      .select("square_id,user_id,expires_at")
      .eq("board_id", BOARD_ID);
    if (he) throw he;

    setBoard(b);
    setSquares(s ?? []);
    setHolds(h ?? []);

    // Load my profile (admin flag + optional name)
    if (session?.user?.id) {
      const { data: p, error: pe } = await supabase
        .from("profiles")
        .select("first_name,last_initial,is_admin")
        .eq("user_id", session.user.id)
        .single();

      // Don't crash if profile doesn't exist yet
      if (!pe) setProfile(p ?? null);
      else setProfile(null);
    }

    // Build owner name map for purchased squares
    const ownerIds = Array.from(
      new Set((s ?? []).map((x) => x.owner_user_id).filter(Boolean))
    );

    if (ownerIds.length === 0) {
      setOwnerNameByUserId({});
      return;
    }

    // Pull profile names for owners
    const { data: owners } = await supabase
      .from("profiles")
      .select("user_id,first_name,last_initial")
      .in("user_id", ownerIds);

    const map = {};
    for (const o of owners ?? []) {
      const fn = (o.first_name ?? "").trim();
      const li = (o.last_initial ?? "").trim();
      const label =
        fn && li ? `${fn} ${li}` : fn ? fn : li ? li : null;
      if (label) map[o.user_id] = label;
    }
    setOwnerNameByUserId(map);
  }

  // realtime subscribe
  useEffect(() => {
    if (!session) return;

    let cleanup = () => {};
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        await loadAll();

        const ch = supabase
          .channel(`board:${BOARD_ID}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "squares", filter: `board_id=eq.${BOARD_ID}` },
            () => loadAll()
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "holds", filter: `board_id=eq.${BOARD_ID}` },
            () => loadAll()
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "boards", filter: `id=eq.${BOARD_ID}` },
            () => loadAll()
          )
          .subscribe();

        cleanup = () => supabase.removeChannel(ch);
      } catch (e) {
        setMsg(e?.message ?? "Failed to load board.");
      } finally {
        setLoading(false);
      }
    })();

    return cleanup;
  }, [session]);

  const squareMap = useMemo(() => {
    const m = new Map();
    for (const s of squares) m.set(keyOf(s.row, s.col), s);
    return m;
  }, [squares]);

  const holdsBySquareId = useMemo(() => {
    const m = new Map();
    for (const h of holds) m.set(h.square_id, h);
    return m;
  }, [holds]);

  const myHeldSquareIds = useMemo(() => {
    const set = new Set();
    const uid = session?.user?.id;
    for (const h of holds) {
      if (h.user_id === uid) set.add(h.square_id);
    }
    return set;
  }, [holds, session]);

  const counts = useMemo(() => {
    const purchased = squares.filter((s) => !!s.owner_user_id).length;
    const remaining = squares.length - purchased;
    const held = new Set(holds.map((h) => h.square_id)).size;
    return { remaining, held, purchased };
  }, [squares, holds]);

  const topDigits =
    Array.isArray(board?.top_digits) && board.top_digits.length === 10
      ? board.top_digits
      : Array(10).fill("#");

  const sideDigits =
    Array.isArray(board?.side_digits) && board.side_digits.length === 10
      ? board.side_digits
      : Array(10).fill("#");

  async function toggleSquare(square) {
    if (!session || !board) return;
    if (board.status !== "open") return;
    if (square.owner_user_id) return;

    setMsg("");
    const hold = holdsBySquareId.get(square.id);
    const isMine = hold && hold.user_id === session.user.id;

    try {
      if (isMine) {
        const { data, error } = await supabase.rpc("release_hold", { p_square_id: square.id });
        if (error) throw error;
        if (!data) setMsg("Could not release that square.");
      } else {
        const { data, error } = await supabase.rpc("try_hold_square", { p_square_id: square.id });
        if (error) throw error;
        const res = data?.[0];
        if (!res?.success) setMsg(`Could not hold: ${res?.reason ?? "unknown"}`);
      }
    } catch (e) {
      setMsg(e?.message ?? "Action failed.");
    }
  }

  function classFor(square) {
    const hold = holdsBySquareId.get(square.id);
    const held = !!hold;
    const mine = held && session?.user?.id && hold.user_id === session.user.id;

    if (square.owner_user_id) return "cell purchased";
    if (mine) return "cell mine";
    if (held) return "cell held";
    return "cell";
  }

  function holdCountdown(squareId) {
    const h = holdsBySquareId.get(squareId);
    if (!h?.expires_at) return null;
    const msLeft = new Date(h.expires_at).getTime() - now;
    if (msLeft <= 0) return null;
    return msToMMSS(msLeft);
  }

  function displayOwner(square) {
    const uid = square.owner_user_id;
    if (!uid) return "";
    // preferred: profile name
    const name = ownerNameByUserId[uid];
    if (name) return name;

    // fallback: email prefix if owner is current user
    if (session?.user?.id === uid && session?.user?.email) {
      return session.user.email.split("@")[0];
    }

    // generic fallback
    return "Paid";
  }

  // ADMIN actions
  async function closeBoard() {
    setMsg("");
    try {
      const { error } = await supabase.from("boards").update({ status: "closed" }).eq("id", BOARD_ID);
      if (error) throw error;
      setMsg("Board closed.");
    } catch (e) {
      setMsg(e?.message ?? "Failed to close board.");
    }
  }

  async function revealNumbers() {
    setMsg("");
    try {
      const { data, error } = await supabase.rpc("admin_reveal_digits", { p_board_id: BOARD_ID });
      if (error) throw error;
      if (!data) setMsg("Could not reveal numbers (must be admin and board closed/sold out).");
      else setMsg("Numbers revealed.");
    } catch (e) {
      setMsg(e?.message ?? "Reveal failed.");
    }
  }

  async function resetBoard() {
    if (!confirm("Are you sure you want to completely reset the board?")) return;

    setMsg("");
    try {
      const { data, error } = await supabase.rpc("admin_reset_board", { p_board_id: BOARD_ID });
      if (error) throw error;
      if (!data) setMsg("Reset failed (must be admin).");
      else {
        setAdminSelected(new Set());
        setBuyerEmail("");
        setPaymentMethod("");
        setPaymentNotes("");
        setMsg("Board reset successfully.");
      }
    } catch (e) {
      setMsg(e?.message ?? "Reset failed.");
    }
  }

  function toggleAdminSelect(square) {
    if (!profile?.is_admin) return;
    if (!square || square.owner_user_id) return; // don't select already purchased
    const next = new Set(adminSelected);
    if (next.has(square.id)) next.delete(square.id);
    else next.add(square.id);
    setAdminSelected(next);
  }

  async function adminMarkPurchased() {
    setMsg("");
    try {
      if (!buyerEmail.trim()) {
        setMsg("Enter the buyer email first.");
        return;
      }
      if (adminSelected.size === 0) {
        setMsg("Select at least one square to mark as purchased.");
        return;
      }

      // Lookup user id by email (admin RPC)
      const { data: buyerId, error: fe } = await supabase.rpc("admin_find_user_by_email", {
        p_email: buyerEmail.trim(),
      });
      if (fe) throw fe;
      if (!buyerId) {
        setMsg("No user found with that email yet. Ask them to log in once first.");
        return;
      }

      const squareIds = Array.from(adminSelected);

      const { data, error } = await supabase.rpc("admin_mark_purchased", {
        p_board_id: BOARD_ID,
        p_buyer_user_id: buyerId,
        p_square_ids: squareIds,
        p_payment_method: paymentMethod.trim() || null,
        p_payment_notes: paymentNotes.trim() || null,
      });
      if (error) throw error;
      if (!data) {
        setMsg("Mark purchased failed (must be admin).");
        return;
      }

      setAdminSelected(new Set());
      setBuyerEmail("");
      setPaymentMethod("");
      setPaymentNotes("");
      setMsg("Squares marked as purchased.");
    } catch (e) {
      setMsg(e?.message ?? "Failed to mark purchased.");
    }
  }

  // STYLES
  useEffect(() => {
    const css = `
      .page{font-family:system-ui,Arial,sans-serif;max-width:1100px;margin:0 auto;padding:20px;}
      .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
      .login{display:flex;gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap;}
      input, textarea, select{padding:10px;border-radius:10px;border:1px solid #ddd;}
      input{width:280px;}
      textarea{width:280px;min-height:42px;resize:vertical;}
      button{padding:10px 12px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;}
      button:disabled{opacity:.6;cursor:not-allowed;}
      .msg{margin:10px 0;color:#333;}

      .statusbar{
        display:flex;
        gap:14px;
        align-items:center;
        flex-wrap:wrap;
        padding:10px 12px;
        border:1px solid #eee;
        border-radius:12px;
        background:#fafafa;
        margin-bottom:12px;
      }
      .pill{
        padding:6px 10px;
        border:1px solid #e5e5e5;
        border-radius:999px;
        background:#fff;
        font-size:13px;
      }

      .admin-panel{
        margin-top:14px;
        padding:12px;
        border:1px solid #eee;
        border-radius:12px;
        background:#fff;
      }
      .admin-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px;}
      .admin-hint{font-size:13px;color:#666;margin-top:6px;line-height:1.35;}
      .danger{border-color:#f0c7c7;background:#fff7f7;}
      .primary{border-color:#cfd7ff;background:#f5f7ff;}

      .board-wrapper{margin-top:14px;}

      /* 2-column layout: side label + main content */
      .board-layout{
        display:grid;
        grid-template-columns: 40px auto;
        column-gap: 12px;
        align-items:start;
      }

      /* Vertically centered side label along the grid */
      .side-label{
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
        font-size:20px;
        writing-mode:vertical-rl;
        transform:rotate(180deg);
        text-align:center;
      }

      .content{display:block;}

      /* Header grid matches board columns exactly */
      .top-grid{
        display:grid;
        grid-template-columns:42px repeat(10,42px);
        gap:6px;
        margin-bottom:8px;
        align-items:center;
      }
      /* Title spans only the 10 digit columns (excludes corner) */
      .top-title{
        grid-column:2 / 12;
        text-align:center;
        font-weight:700;
        font-size:20px;
      }

      .board-shell{display:flex;}

      .board{
        display:grid;
        grid-template-columns:42px repeat(10,42px);
        grid-auto-rows:42px;
        gap:6px;
      }

      .corner{width:42px;height:42px;}
      .hdr{display:flex;align-items:center;justify-content:center;font-weight:700;background:#f2f2f2;border-radius:10px;}
      .row{display:contents;}

      .cell{
        position:relative;
        width:42px;height:42px;
        border-radius:10px;
        border:1px solid #ddd;
        background:#fff;
        padding:0;
      }
      .cell.held{background:#efefef;}
      .cell.mine{outline:3px solid #111;outline-offset:-3px;}
      .cell.purchased{background:#111;border-color:#111;}

      /* show selected squares for admin */
      .cell.selected{
        outline:3px solid #2f6fff;
        outline-offset:-3px;
      }

      .cell-text{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:10px;
        line-height:1.05;
        padding:3px;
        text-align:center;
        color:#fff;
        font-weight:700;
        pointer-events:none;
      }

      .badge{
        position:absolute;
        bottom:2px;
        right:2px;
        font-size:9px;
        padding:2px 4px;
        border-radius:6px;
        border:1px solid #ddd;
        background:#fff;
        color:#111;
        pointer-events:none;
      }
      .badge.mine{
        border-color:#111;
        font-weight:700;
      }
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
        <div className="login">
          <input
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button onClick={sendLink} disabled={!email}>
            Send sign-in link
          </button>
        </div>
        {msg && <div className="msg">{msg}</div>}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="topbar">
        <h1>{board?.name ?? "Board"}</h1>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {profile?.is_admin && (
            <>
              <button onClick={closeBoard}>Close Board</button>
              <button onClick={revealNumbers}>Reveal Numbers</button>
              <button className="danger" onClick={resetBoard}>Reset Board</button>
            </>
          )}
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>

      {msg && <div className="msg">{msg}</div>}
      {loading && <div>Loading...</div>}

      <div className="statusbar">
        <div className="pill">Remaining: <b>{counts.remaining}</b></div>
        <div className="pill">Held: <b>{counts.held}</b></div>
        <div className="pill">Purchased: <b>{counts.purchased}</b></div>
        <div className="pill">Board status: <b>{board?.status ?? "-"}</b></div>
      </div>

      {profile?.is_admin && (
        <div className="admin-panel">
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>Admin – Payment Tracking (Manual)</div>
            <div className="pill">Selected squares: <b>{adminSelected.size}</b></div>
          </div>

          <div className="admin-row">
            <input
              placeholder="Buyer email (must have logged in once)"
              value={buyerEmail}
              onChange={(e) => setBuyerEmail(e.target.value)}
            />
            <input
              placeholder="Payment method (optional, e.g., Venmo)"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
            />
            <input
              placeholder="Payment notes (optional)"
              value={paymentNotes}
              onChange={(e) => setPaymentNotes(e.target.value)}
            />
            <button className="primary" onClick={adminMarkPurchased} disabled={adminSelected.size === 0}>
              Mark Purchased
            </button>
            <button
              onClick={() => setAdminSelected(new Set())}
              disabled={adminSelected.size === 0}
            >
              Clear Selection
            </button>
          </div>

          <div className="admin-hint">
            Click squares on the board to select them (purchased squares can’t be selected).
            The buyer must log in at least once so they exist in Supabase Auth.
          </div>
        </div>
      )}

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
                  <div key={`col-${i}`} className="hdr">
                    {d}
                  </div>
                ))}

                {DIGITS.map((r) => (
                  <div key={`row-${r}`} className="row">
                    <div className="hdr">{sideDigits[r]}</div>

                    {DIGITS.map((c) => {
                      const sq = squareMap.get(keyOf(r, c));
                      if (!sq) return <div key={`missing-${r}-${c}`} className="cell" />;

                      const hold = holdsBySquareId.get(sq.id);
                      const countdown = holdCountdown(sq.id);
                      const isHeld = !!hold;
                      const isMine = isHeld && hold.user_id === session.user.id;

                      const selected = profile?.is_admin && adminSelected.has(sq.id);

                      // Click behavior:
                      // - Admin: if not purchased, click selects (even if held). If you want to block selecting held squares, we can.
                      // - Non-admin: normal hold/unhold behavior.
                      const onClick = () => {
                        if (profile?.is_admin) toggleAdminSelect(sq);
                        else toggleSquare(sq);
                      };

                      // Disable for non-admin when closed/purchased
                      const disabled =
                        !profile?.is_admin &&
                        (board?.status !== "open" || !!sq.owner_user_id);

                      const cls = `${classFor(sq)}${selected ? " selected" : ""}`;

                      return (
                        <button
                          key={sq.id}
                          className={cls}
                          onClick={onClick}
                          disabled={disabled}
                          title={`${r}-${c}`}
                        >
                          {sq.owner_user_id && (
                            <div className="cell-text">{displayOwner(sq)}</div>
                          )}

                          {!sq.owner_user_id && countdown && (
                            <div className={`badge${isMine ? " mine" : ""}`}>
                              {countdown}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {!profile?.is_admin && myHeldSquareIds.size > 0 && (
              <div className="admin-hint" style={{ marginTop: 10 }}>
                You currently have <b>{myHeldSquareIds.size}</b> square(s) on hold. Holds expire automatically.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}