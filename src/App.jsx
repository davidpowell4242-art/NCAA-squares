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
  const [orders, setOrders] = useState([]); // board orders (admin sees all, users see own)
  const [orderItems, setOrderItems] = useState([]); // items for visible orders
  const [loading, setLoading] = useState(true);

  const [now, setNow] = useState(Date.now());

  // admin payment fields for marking paid
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  // owner display lookup
  const [ownerNameByUserId, setOwnerNameByUserId] = useState({});

  // Profile modal
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [pfFirstName, setPfFirstName] = useState("");
  const [pfLastInitial, setPfLastInitial] = useState("");
  const [pfSaving, setPfSaving] = useState(false);

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
      .select("id,row,col,state,owner_user_id,pending_order_id")
      .eq("board_id", BOARD_ID);
    if (se) throw se;

    const { data: h, error: he } = await supabase
      .from("holds")
      .select("square_id,user_id,expires_at")
      .eq("board_id", BOARD_ID);
    if (he) throw he;

    // Load my profile
    if (session?.user?.id) {
      const { data: p, error: pe } = await supabase
        .from("profiles")
        .select("first_name,last_initial,is_admin")
        .eq("user_id", session.user.id)
        .single();

      if (!pe) {
        setProfile(p ?? null);

        const missing = !p?.first_name || !p?.last_initial;
        if (missing) {
          setPfFirstName(p?.first_name ?? "");
          setPfLastInitial((p?.last_initial ?? "").toUpperCase().slice(0, 1));
          setShowProfileModal(true);
        } else {
          setShowProfileModal(false);
        }
      } else {
        setProfile(null);
      }
    }

    // Orders visible:
    // - non-admin: only own orders via RLS
    // - admin: all orders via RLS
    const { data: o, error: oe } = await supabase
      .from("orders")
      .select("id,board_id,user_id,status,created_at,paid_at,canceled_at,payment_method,payment_notes")
      .eq("board_id", BOARD_ID)
      .order("created_at", { ascending: false });
    if (oe) throw oe;

    const orderIds = (o ?? []).map((x) => x.id);
    let oi = [];
    if (orderIds.length > 0) {
      const { data: items, error: ie } = await supabase
        .from("order_items")
        .select("order_id,square_id")
        .in("order_id", orderIds);
      if (ie) throw ie;
      oi = items ?? [];
    }

    setBoard(b);
    setSquares(s ?? []);
    setHolds(h ?? []);
    setOrders(o ?? []);
    setOrderItems(oi);

    // Build owner name map for purchased + pending squares owners
    const ownerIds = new Set((s ?? []).map((x) => x.owner_user_id).filter(Boolean));

    // also collect order user_ids for pending orders so we can show "Pending" name
    for (const ord of o ?? []) {
      if (ord?.user_id) ownerIds.add(ord.user_id);
    }

    const ownerIdArr = Array.from(ownerIds);
    if (ownerIdArr.length === 0) {
      setOwnerNameByUserId({});
      return;
    }

    const { data: owners } = await supabase
      .from("profiles")
      .select("user_id,first_name,last_initial")
      .in("user_id", ownerIdArr);

    const map = {};
    for (const p of owners ?? []) {
      const fn = (p.first_name ?? "").trim();
      const li = (p.last_initial ?? "").trim();
      const label = fn && li ? `${fn} ${li}` : fn ? fn : li ? li : null;
      if (label) map[p.user_id] = label;
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
            { event: "*", schema: "public", table: "orders", filter: `board_id=eq.${BOARD_ID}` },
            () => loadAll()
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "order_items" },
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

  const orderById = useMemo(() => {
    const m = new Map();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  const orderItemsByOrderId = useMemo(() => {
    const m = new Map();
    for (const it of orderItems) {
      if (!m.has(it.order_id)) m.set(it.order_id, []);
      m.get(it.order_id).push(it.square_id);
    }
    return m;
  }, [orderItems]);

  const myHeldSquares = useMemo(() => {
    const uid = session?.user?.id;
    const mine = [];
    for (const s of squares) {
      const h = holdsBySquareId.get(s.id);
      if (h && h.user_id === uid && !s.owner_user_id && !s.pending_order_id) {
        mine.push(s);
      }
    }
    mine.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    return mine;
  }, [squares, holdsBySquareId, session]);

  const myPendingOrders = useMemo(() => {
    const uid = session?.user?.id;
    return orders.filter((o) => o.user_id === uid && o.status === "pending");
  }, [orders, session]);

  const counts = useMemo(() => {
    const purchased = squares.filter((s) => !!s.owner_user_id).length;
    const pending = squares.filter((s) => !!s.pending_order_id && !s.owner_user_id).length;
    const remaining = squares.length - purchased - pending;
    const held = new Set(holds.map((h) => h.square_id)).size;
    return { remaining, held, purchased, pending };
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
    if (square.pending_order_id) return; // locked by an order

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

  function holdCountdown(squareId) {
    const h = holdsBySquareId.get(squareId);
    if (!h?.expires_at) return null;
    const msLeft = new Date(h.expires_at).getTime() - now;
    if (msLeft <= 0) return null;
    return msToMMSS(msLeft);
  }

  function displayNameForUserId(uid) {
    if (!uid) return "";
    const name = ownerNameByUserId[uid];
    if (name) return name;
    if (session?.user?.id === uid && session?.user?.email) return session.user.email.split("@")[0];
    return "Player";
  }

  function displayCellText(square) {
    if (square.owner_user_id) return displayNameForUserId(square.owner_user_id);

    if (square.pending_order_id) {
      const ord = orderById.get(square.pending_order_id);
      const owner = ord?.user_id;
      const who = owner ? displayNameForUserId(owner) : "Player";
      return `PENDING\n${who}`;
    }
    return "";
  }

  function classFor(square) {
    const hold = holdsBySquareId.get(square.id);
    const held = !!hold;
    const mine = held && session?.user?.id && hold.user_id === session.user.id;

    if (square.owner_user_id) return "cell purchased";
    if (square.pending_order_id) return "cell pending";
    if (mine) return "cell mine";
    if (held) return "cell held";
    return "cell";
  }

  async function purchaseHeldSquares() {
    setMsg("");
    try {
      if (myHeldSquares.length === 0) {
        setMsg("Hold one or more squares first.");
        return;
      }
      const { data: orderId, error } = await supabase.rpc("create_order_from_holds", {
        p_board_id: BOARD_ID,
      });
      if (error) throw error;
      setMsg(`Purchase submitted! Order pending payment.`);
      // loadAll will refresh via realtime, but do it now for snappiness
      await loadAll();
    } catch (e) {
      setMsg(e?.message ?? "Could not submit purchase.");
    }
  }

  async function saveProfile() {
    setMsg("");
    const first = (pfFirstName ?? "").trim();
    const liRaw = (pfLastInitial ?? "").trim();
    const li = liRaw ? liRaw[0].toUpperCase() : "";

    if (!first) return setMsg("Please enter your first name.");
    if (!li) return setMsg("Please enter your last initial.");

    setPfSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ first_name: first, last_initial: li })
        .eq("user_id", session.user.id);
      if (error) throw error;

      setShowProfileModal(false);
      setMsg("Profile saved.");
      await loadAll();
    } catch (e) {
      setMsg(e?.message ?? "Failed to save profile.");
    } finally {
      setPfSaving(false);
    }
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
        setPaymentMethod("");
        setPaymentNotes("");
        setMsg("Board reset successfully.");
      }
    } catch (e) {
      setMsg(e?.message ?? "Reset failed.");
    }
  }

  async function adminMarkPaid(orderId) {
    setMsg("");
    try {
      const { data, error } = await supabase.rpc("admin_mark_order_paid", {
        p_order_id: orderId,
        p_payment_method: paymentMethod.trim() || null,
        p_payment_notes: paymentNotes.trim() || null,
      });
      if (error) throw error;
      if (!data) return setMsg("Mark paid failed (must be admin, order must be pending).");
      setMsg("Order marked paid.");
      setPaymentMethod("");
      setPaymentNotes("");
      await loadAll();
    } catch (e) {
      setMsg(e?.message ?? "Failed to mark paid.");
    }
  }

  async function adminCancel(orderId) {
    setMsg("");
    try {
      const { data, error } = await supabase.rpc("admin_cancel_order", { p_order_id: orderId });
      if (error) throw error;
      if (!data) return setMsg("Cancel failed (must be admin, order must be pending).");
      setMsg("Order canceled.");
      await loadAll();
    } catch (e) {
      setMsg(e?.message ?? "Failed to cancel order.");
    }
  }

  // STYLES
  useEffect(() => {
    const css = `
      .page{font-family:system-ui,Arial,sans-serif;max-width:1100px;margin:0 auto;padding:20px;}
      .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
      .login{display:flex;gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap;}
      input{padding:10px;border-radius:10px;border:1px solid #ddd;width:280px;}
      button{padding:10px 12px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;}
      button:disabled{opacity:.6;cursor:not-allowed;}
      .msg{margin:10px 0;color:#333;}

      .statusbar{
        display:flex;gap:14px;align-items:center;flex-wrap:wrap;
        padding:10px 12px;border:1px solid #eee;border-radius:12px;background:#fafafa;margin-bottom:12px;
      }
      .pill{padding:6px 10px;border:1px solid #e5e5e5;border-radius:999px;background:#fff;font-size:13px;}

      .info{
        margin-bottom:12px;padding:12px;border:1px solid #e9e9e9;border-radius:12px;background:#fff;
        line-height:1.35;font-size:14px;
      }
      .info b{font-weight:800;}
      .info .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;}

      .admin-panel{margin-top:14px;padding:12px;border:1px solid #eee;border-radius:12px;background:#fff;}
      .admin-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px;}
      .admin-hint{font-size:13px;color:#666;margin-top:6px;line-height:1.35;}
      .danger{border-color:#f0c7c7;background:#fff7f7;}
      .primary{border-color:#cfd7ff;background:#f5f7ff;}

      .orders-list{margin-top:10px;border-top:1px solid #eee;padding-top:10px;}
      .order-card{
        border:1px solid #eee;border-radius:12px;padding:10px;margin-top:10px;background:#fafafa;
        display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;align-items:flex-start;
      }
      .order-meta{font-size:13px;color:#444;line-height:1.35;}
      .order-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}

      .board-wrapper{margin-top:14px;}
      .board-layout{display:grid;grid-template-columns:40px auto;column-gap:12px;align-items:start;}
      .side-label{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;writing-mode:vertical-rl;transform:rotate(180deg);text-align:center;}
      .content{display:block;}

      .top-grid{display:grid;grid-template-columns:42px repeat(10,42px);gap:6px;margin-bottom:8px;align-items:center;}
      .top-title{grid-column:2 / 12;text-align:center;font-weight:700;font-size:20px;}

      .board{display:grid;grid-template-columns:42px repeat(10,42px);grid-auto-rows:42px;gap:6px;}
      .corner{width:42px;height:42px;}
      .hdr{display:flex;align-items:center;justify-content:center;font-weight:700;background:#f2f2f2;border-radius:10px;}
      .row{display:contents;}

      .cell{position:relative;width:42px;height:42px;border-radius:10px;border:1px solid #ddd;background:#fff;padding:0;}
      .cell.held{background:#efefef;}
      .cell.mine{outline:3px solid #111;outline-offset:-3px;}
      .cell.purchased{background:#111;border-color:#111;}
      .cell.pending{background:#2b2b2b;border-color:#2b2b2b;opacity:0.88;}
      .cell-text{
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font-size:9px;line-height:1.05;padding:3px;text-align:center;color:#fff;font-weight:800;white-space:pre-line;
        pointer-events:none;
      }
      .badge{position:absolute;bottom:2px;right:2px;font-size:9px;padding:2px 4px;border-radius:6px;border:1px solid #ddd;background:#fff;color:#111;pointer-events:none;}
      .badge.mine{border-color:#111;font-weight:800;}

      /* Modal */
      .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999;padding:18px;}
      .modal{width:100%;max-width:420px;background:#fff;border-radius:16px;border:1px solid #eee;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:16px;}
      .modal h2{margin:0 0 8px 0;}
      .modal p{margin:0 0 12px 0;color:#555;line-height:1.35;}
      .modal .two{display:grid;grid-template-columns:1fr 110px;gap:10px;margin-top:10px;}
      .modal .actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;}
      .modal input{width:100%;}
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
          <input placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button onClick={sendLink} disabled={!email}>Send sign-in link</button>
        </div>
        {msg && <div className="msg">{msg}</div>}
      </div>
    );
  }

  const pendingOrdersAdmin = profile?.is_admin
    ? orders.filter((o) => o.status === "pending")
    : [];

  return (
    <div className="page">
      {/* Complete Profile Modal */}
      {showProfileModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Complete your profile</h2>
            <p>We use your name to display squares (first name + last initial).</p>
            <div className="two">
              <div>
                <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>First name</div>
                <input value={pfFirstName} onChange={(e) => setPfFirstName(e.target.value)} placeholder="First name" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Last initial</div>
                <input
                  value={pfLastInitial}
                  onChange={(e) => setPfLastInitial(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 1))}
                  placeholder="L"
                  maxLength={1}
                />
              </div>
            </div>
            <div className="actions">
              <button onClick={saveProfile} disabled={pfSaving}>{pfSaving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}

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
        <div className="pill">Pending: <b>{counts.pending}</b></div>
        <div className="pill">Purchased: <b>{counts.purchased}</b></div>
        <div className="pill">Board status: <b>{board?.status ?? "-"}</b></div>
      </div>

      {/* User purchase UX */}
      <div className="info">
        <div>
          <b>Step 1:</b> Click squares to hold them (temporary).
          <br />
          <b>Step 2:</b> Click <b>Purchase</b> to submit your selection (it becomes <b>Pending</b> and locks in).
          <br />
          <b>Step 3:</b> Organizer confirms payment and your squares become <b>Purchased</b>.
        </div>

        <div className="actions">
          <button className="primary" onClick={purchaseHeldSquares} disabled={myHeldSquares.length === 0}>
            Purchase ({myHeldSquares.length})
          </button>
        </div>

        {myPendingOrders.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#444" }}>
            You have <b>{myPendingOrders.length}</b> pending purchase(s). Your squares are locked in pending status.
          </div>
        )}
      </div>

      {/* Admin pending orders */}
      {profile?.is_admin && (
        <div className="admin-panel">
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>Admin – Pending Orders</div>
            <div className="pill">Pending orders: <b>{pendingOrdersAdmin.length}</b></div>
          </div>

          <div className="admin-row">
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
          </div>

          <div className="orders-list">
            {pendingOrdersAdmin.length === 0 && (
              <div className="admin-hint">No pending orders right now.</div>
            )}

            {pendingOrdersAdmin.map((o) => {
              const buyerName = displayNameForUserId(o.user_id);
              const sqIds = orderItemsByOrderId.get(o.id) ?? [];
              const sqLabels = sqIds
                .map((sid) => squares.find((x) => x.id === sid))
                .filter(Boolean)
                .map((sq) => `R${sq.row}-${sq.col}`)
                .join(", ");

              return (
                <div key={o.id} className="order-card">
                  <div className="order-meta">
                    <div><b>{buyerName}</b></div>
                    <div>Order: {o.id.slice(0, 8)}…</div>
                    <div>Squares: <b>{sqIds.length}</b></div>
                    <div style={{ marginTop: 6, color: "#666" }}>{sqLabels}</div>
                  </div>

                  <div className="order-actions">
                    <button className="primary" onClick={() => adminMarkPaid(o.id)}>Mark Paid</button>
                    <button className="danger" onClick={() => adminCancel(o.id)}>Cancel</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="admin-hint" style={{ marginTop: 10 }}>
            “Pending” squares are locked. Mark Paid assigns ownership; Cancel releases the squares.
          </div>
        </div>
      )}

      {/* Board */}
      <div className="board-wrapper">
        <div className="board-layout">
          <div className="side-label">Away Team</div>

          <div className="content">
            <div className="top-grid">
              <div className="corner" />
              <div className="top-title">Home Team</div>
            </div>

            <div className="board">
              <div className="corner" />
              {topDigits.map((d, i) => (
                <div key={`col-${i}`} className="hdr">{d}</div>
              ))}

              {DIGITS.map((r) => (
                <div key={`row-${r}`} className="row">
                  <div className="hdr">{sideDigits[r]}</div>

                  {DIGITS.map((c) => {
                    const sq = squareMap.get(keyOf(r, c));
                    if (!sq) return <div key={`missing-${r}-${c}`} className="cell" />;

                    const hold = holdsBySquareId.get(sq.id);
                    const countdown = holdCountdown(sq.id);
                    const isMine = hold && hold.user_id === session.user.id;

                    const disabled =
                      board?.status !== "open" ||
                      !!sq.owner_user_id ||
                      !!sq.pending_order_id ||
                      (hold && !isMine); // someone else holds it

                    return (
                      <button
                        key={sq.id}
                        className={classFor(sq)}
                        onClick={() => toggleSquare(sq)}
                        disabled={disabled}
                        title={`R${r}-C${c}`}
                      >
                        {(sq.owner_user_id || sq.pending_order_id) && (
                          <div className="cell-text">{displayCellText(sq)}</div>
                        )}

                        {!sq.owner_user_id && !sq.pending_order_id && countdown && (
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
        </div>
      </div>
    </div>
  );
}