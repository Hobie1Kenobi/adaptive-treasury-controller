const acts = [
  { id: "setup", title: "1 · Fund", detail: "Deposit operating cash", gate: "canPlan", always: true },
  { id: "plan", title: "2 · Plan", detail: "Rank the five obligations", gate: "canPlan" },
  { id: "shock", title: "3 · Shock", detail: "Read the conflicting email", gate: "canShock" },
  { id: "recalc", title: "4 · Recalc", detail: "Inbound deposit, then replan", gate: "canRecalc" },
  { id: "execute", title: "5 · Execute", detail: "One quote, one payout", gate: "canExecute" },
];

const state = { view: null, error: "" };

document.getElementById("act-list").innerHTML = acts
  .map(
    (act) =>
      `<li><button type="button" data-act="${act.id}"><strong>${act.title}</strong><small>${act.detail}</small></button></li>`,
  )
  .join("");

document.getElementById("act-list").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  postAct(button.dataset.act);
});

document.getElementById("reset").addEventListener("click", () => post("/api/reset"));

load();

async function load() {
  const response = await fetch("/api/state");
  render(await response.json());
}

async function postAct(name) {
  await post(`/api/acts/${name}`);
}

async function post(url) {
  state.error = "";
  const response = await fetch(url, { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    state.error = body.error || "Request failed";
    render(state.view);
    return;
  }
  render(body);
}

function render(view) {
  state.view = view;
  document.getElementById("tagline").textContent = view.narrative;
  document.getElementById("mode-badge").textContent = view.mode === "sandbox" ? "Airwallex sandbox" : "Mock ledger";
  document.getElementById("planner-badge").textContent = view.planner.label;

  document.getElementById("balances").innerHTML = view.balances
    .map((row) => {
      const width = Math.min(100, (row.available / Math.max(view.usdAvailable, view.reserveFloorUsd, 1)) * 100);
      const floorLeft =
        row.currency === "USD"
          ? Math.min(100, (view.reserveFloorUsd / Math.max(row.available, view.reserveFloorUsd, 1)) * 100)
          : null;
      return `<article class="balance">
        <span>${row.currency} available</span>
        <strong>${money(row.available, row.currency)}</strong>
        <div class="meter" aria-hidden="true">
          <div class="fill" style="width:${row.currency === "USD" ? Math.min(100, (row.available / Math.max(row.available, view.reserveFloorUsd * 1.2, 1)) * 100) : width}%"></div>
          ${floorLeft == null ? "" : `<div class="floor" style="left:${floorLeft}%"></div>`}
        </div>
        <span>${row.currency === "USD" ? `Floor ${money(view.reserveFloorUsd, "USD")}` : "Pending " + money(row.pending, row.currency)}</span>
      </article>`;
    })
    .join("");

  for (const button of document.querySelectorAll("#act-list button")) {
    const act = acts.find((item) => item.id === button.dataset.act);
    button.disabled = act.id === "setup" ? false : !view.gates[act.gate];
  }

  const email = view.email
    ? `<article class="letter"><strong>${esc(view.email.subject)}</strong><p class="muted">${esc(view.email.from)}</p><p>${esc(view.email.body)}</p></article>`
    : `<p class="muted">Forecast ${esc(view.forecast.invoice)} from ${esc(view.forecast.payer)}: ${money(view.forecast.amount, view.forecast.currency)} expected in ${view.forecast.expectedInHours}h. Confidence ${view.confidence.toFixed(2)} (${esc(view.confidenceReason)}).</p>`;

  const proof = view.execution
    ? `<div class="proof">
        <div>Quote <b>${esc(view.execution.quoteId || "—")}</b></div>
        <div>Usage <b>${esc(view.execution.quoteUsage || "single-use")}</b></div>
        <div>Conversion <b>${esc(view.execution.conversionStatus || "—")}</b></div>
        <div>Transfer <b>${esc(view.execution.transferStatus || "—")}</b></div>
        <div>USD left <b>${view.execution.reserveUsd == null ? "—" : money(view.execution.reserveUsd, "USD")}</b></div>
        <div>Reserve <b>${view.execution.reserveIntact ? "above floor" : "check failed"}</b></div>
      </div>
      <p class="muted">This beat books one FX conversion and one supplier transfer. The quote is submitted once even when Airwallex marks it MULTI_USE. The USD freight decision stays queued.</p>`
    : "";

  document.getElementById("story").innerHTML = `
    <h2>What changed</h2>
    <p class="story">${esc(view.narrative)}</p>
    ${view.operatingCapUsd ? `<p class="cap">Sandbox demo cap ${money(view.operatingCapUsd, "USD")}. The blotter is the operating book, not the whole wallet. Live USD available is ${money(view.liveUsd, "USD")}. There is no sandbox call that withdraws a rich wallet.</p>` : ""}
    ${view.warning ? `<p class="error">${esc(view.warning)}</p>` : ""}
    ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
    ${email}
    ${proof}`;

  document.getElementById("obligations").innerHTML = view.obligations
    .map((item) => {
      const action = item.action || "open";
      return `<article class="obligation${item.affected ? " affected" : ""}">
        <div>
          <div class="action ${esc(action)}">${esc(action)}</div>
          <div class="meta">${esc(item.settlement)}${item.affected ? " · changed" : ""}</div>
        </div>
        <div>
          <div class="payee">${esc(item.payee)}</div>
          <div class="meta">${esc(item.id)} · due ${item.dueInHours}h · ${esc(item.transferMethod)} · ${esc(item.reasonCode || item.description)}</div>
          <p class="explain">${esc(item.explanation || item.description)}</p>
        </div>
        <div class="amount">
          <b>${money(item.amount, item.currency)}</b>
          <span class="pill ${item.needsApproval ? "warn" : item.action === "escalate" ? "bad" : item.settlement === "sent" ? "good" : ""}">${
            item.needsApproval ? "Needs approval" : item.usdCost != null ? money(item.usdCost, "USD") + " eq." : "—"
          }</span>
        </div>
      </article>`;
    })
    .join("");

  const pending = view.obligations.find((item) => item.needsApproval);
  const panel = document.getElementById("approval-panel");
  if (!pending) {
    panel.hidden = true;
    panel.innerHTML = "";
  } else {
    panel.hidden = false;
    const status = view.approval?.status;
    panel.className = "panel approval";
    panel.innerHTML = `
      <h2>Human approval</h2>
      <p>Bound to <b>${esc(pending.payee)}</b>, buy <b>${money(pending.buyAmount, pending.currency)}</b>${pending.fee ? ` (includes ${money(pending.fee, pending.currency)} SWIFT fee)` : ""}, estimated sell <b>${money(pending.usdCost, "USD")}</b>.</p>
      <p class="muted">Confidence ${view.confidence.toFixed(2)} is under the ${view.policy.confidenceThreshold.toFixed(2)} gate. Autonomous cap is ${money(view.snapshot?.autonomousCapUsd ?? view.policy.autonomousConversionUsd.low, "USD")}.</p>
      <div class="row-actions">
        <button type="button" class="primary" id="approve" ${view.gates.canApprove ? "" : "disabled"}>${status === "approved" ? "Approved" : "Approve this conversion"}</button>
        <button type="button" id="decline" ${view.gates.canDecline ? "" : "disabled"}>${status === "declined" ? "Declined" : "Decline"}</button>
      </div>`;
    document.getElementById("approve")?.addEventListener("click", () => postAct("approve"));
    document.getElementById("decline")?.addEventListener("click", () => postAct("decline"));
  }

  const snap = view.snapshot;
  document.getElementById("policy-panel").innerHTML = `
    <h2>Policy, in code</h2>
    <ul class="policy-list">
      <li>Reserve floor <b>${money(view.policy.reserveFloorUsd, "USD")}</b> available.</li>
      <li>Headroom now <b>${snap ? money(snap.headroomUsd, "USD") : "—"}</b>. Book total <b>${snap ? money(snap.totalUsdCost, "USD") : "—"}</b>.</li>
      <li>Confidence gate <b>${view.policy.confidenceThreshold.toFixed(2)}</b>. Cap <b>${money(view.policy.autonomousConversionUsd.high, "USD")}</b> above it, <b>${money(view.policy.autonomousConversionUsd.low, "USD")}</b> below.</li>
      <li>EUR SWIFT provision <b>${money(view.policy.swiftFeeEur, "EUR")}</b> (estimate ${money(view.policy.swiftFeeBaseEur, "EUR")} plus pad ${money(view.policy.swiftFeePadEur, "EUR")}). Local payouts are free.</li>
      <li>${esc(view.policy.cheapestRule)}</li>
      <li>Indicative EUR ${snap ? snap.usdPerUnit.EUR : "—"}, GBP ${snap ? snap.usdPerUnit.GBP : "—"}. The booked quote uses client_rate.</li>
    </ul>`;

  document.getElementById("audit").innerHTML = view.audit
    .map(
      (event) =>
        `<li><time datetime="${esc(event.at)}">${esc(event.act)} · ${esc(event.at.slice(11, 19))}Z</time>${esc(event.message)}</li>`,
    )
    .join("");
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
