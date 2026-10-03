'use strict';

/* ─────────────────────────────────────────
   Constants & Config
───────────────────────────────────────── */
const STORAGE_KEY = 'budgetVisualizer_v1';

const CATEGORIES = {
  food:          { label: 'Food & Dining',    emoji: '🍔', type: 'expense' },
  transport:     { label: 'Transport',        emoji: '🚌', type: 'expense' },
  shopping:      { label: 'Shopping',         emoji: '🛍️', type: 'expense' },
  bills:         { label: 'Bills & Utils',    emoji: '💡', type: 'expense' },
  health:        { label: 'Health',           emoji: '💊', type: 'expense' },
  entertainment: { label: 'Entertainment',    emoji: '🎬', type: 'expense' },
  education:     { label: 'Education',        emoji: '📚', type: 'expense' },
  other:         { label: 'Other',            emoji: '📦', type: 'expense' },
  salary:        { label: 'Salary',           emoji: '💼', type: 'income' },
  freelance:     { label: 'Freelance',        emoji: '💻', type: 'income' },
  investment:    { label: 'Investment',       emoji: '📈', type: 'income' },
  gift:          { label: 'Gift',             emoji: '🎁', type: 'income' },
  other_income:  { label: 'Other Income',     emoji: '💵', type: 'income' },
};

// Distinct colour palette for the donut chart
const CHART_COLORS = [
  '#6c63ff', '#f97316', '#22c55e', '#ef4444', '#3b82f6',
  '#a855f7', '#eab308', '#14b8a6', '#ec4899', '#64748b',
  '#06b6d4', '#84cc16',
];

/* ─────────────────────────────────────────
   State
───────────────────────────────────────── */
let transactions = [];      // Array of transaction objects
let activeType   = 'expense'; // Current form type toggle
let filterType   = 'all';    // History filter
let pendingDeleteId = null;  // ID queued for deletion via modal
let toastTimer   = null;     // Debounce toast auto-hide

/* ─────────────────────────────────────────
   DOM references
───────────────────────────────────────── */
const $ = id => document.getElementById(id);

const DOM = {
  totalBalance:  $('totalBalance'),
  totalIncome:   $('totalIncome'),
  totalExpenses: $('totalExpenses'),

  form:          $('transactionForm'),
  description:   $('description'),
  amount:        $('amount'),
  category:      $('category'),
  txDate:        $('txDate'),
  submitBtn:     $('submitBtn'),
  descError:     $('descError'),
  amountError:   $('amountError'),

  typeExpense:   $('typeExpense'),
  typeIncome:    $('typeIncome'),

  txList:        $('txList'),
  txEmpty:       $('txEmpty'),
  filterType:    $('filterType'),

  chartCanvas:   $('spendingChart'),
  chartLegend:   $('chartLegend'),
  chartTotal:    $('chartTotal'),
  chartEmpty:    $('chartEmpty'),
  chartSection:  $('chartSection'),

  modalOverlay:  $('modalOverlay'),
  modalBody:     $('modalBody'),
  modalCancel:   $('modalCancel'),
  modalConfirm:  $('modalConfirm'),

  clearAllBtn:   $('clearAllBtn'),
  toast:         $('toast'),
};

/* ─────────────────────────────────────────
   LocalStorage helpers
───────────────────────────────────────── */
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    transactions = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(transactions)) transactions = [];
  } catch {
    transactions = [];
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  } catch (err) {
    showToast('Storage error — data may not be saved.', 'error');
  }
}

/* ─────────────────────────────────────────
   Formatters
───────────────────────────────────────── */
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
}

function formatDate(iso) {
  // iso = 'YYYY-MM-DD'
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ─────────────────────────────────────────
   Summary calculation
───────────────────────────────────────── */
function calcSummary() {
  let income = 0, expenses = 0;
  for (const tx of transactions) {
    if (tx.type === 'income')  income   += tx.amount;
    else                       expenses += tx.amount;
  }
  return { income, expenses, balance: income - expenses };
}

/* ─────────────────────────────────────────
   Render: Summary bar
───────────────────────────────────────── */
function renderSummary() {
  const { income, expenses, balance } = calcSummary();

  DOM.totalBalance.textContent  = formatCurrency(balance);
  DOM.totalIncome.textContent   = '+' + formatCurrency(income);
  DOM.totalExpenses.textContent = '-' + formatCurrency(expenses);

  DOM.totalBalance.classList.toggle('is-negative', balance < 0);
}

/* ─────────────────────────────────────────
   Render: Transaction list
───────────────────────────────────────── */
function renderTransactions() {
  const filtered = filterType === 'all'
    ? transactions
    : transactions.filter(tx => tx.type === filterType);

  // Sort newest first
  const sorted = [...filtered].sort((a, b) => {
    const dateDiff = b.date.localeCompare(a.date);
    return dateDiff !== 0 ? dateDiff : b.id - a.id;
  });

  DOM.txList.innerHTML = '';

  if (sorted.length === 0) {
    DOM.txEmpty.hidden = false;
    return;
  }
  DOM.txEmpty.hidden = true;

  const frag = document.createDocumentFragment();

  for (const tx of sorted) {
    const cat  = CATEGORIES[tx.category] || { label: tx.category, emoji: '📦' };
    const sign = tx.type === 'income' ? '+' : '-';

    const li = document.createElement('li');
    li.className = 'tx-item';
    li.dataset.id = tx.id;

    li.innerHTML = `
      <div class="tx-icon tx-icon--${tx.type}" aria-hidden="true">${cat.emoji}</div>
      <div class="tx-info">
        <div class="tx-desc" title="${escapeHtml(tx.description)}">${escapeHtml(tx.description)}</div>
        <div class="tx-meta">
          <span class="tx-category">${escapeHtml(cat.label)}</span>
          <span class="tx-date">${formatDate(tx.date)}</span>
        </div>
      </div>
      <div class="tx-right">
        <span class="tx-amount tx-amount--${tx.type}">${sign}${formatCurrency(tx.amount)}</span>
        <button class="tx-delete" data-id="${tx.id}" aria-label="Delete ${escapeHtml(tx.description)}">✕</button>
      </div>
    `;

    frag.appendChild(li);
  }

  DOM.txList.appendChild(frag);
}

/* ─────────────────────────────────────────
   Render: Donut chart (vanilla canvas)
───────────────────────────────────────── */
function renderChart() {
  const ctx    = DOM.chartCanvas.getContext('2d');
  const canvas = DOM.chartCanvas;
  const W      = canvas.width;
  const H      = canvas.height;

  // Aggregate expenses by category
  const expenseTxs = transactions.filter(tx => tx.type === 'expense');
  const totals = {};
  for (const tx of expenseTxs) {
    totals[tx.category] = (totals[tx.category] || 0) + tx.amount;
  }

  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const grandTotal = entries.reduce((s, [, v]) => s + v, 0);

  // Update center label
  DOM.chartTotal.textContent = grandTotal > 0
    ? formatCurrency(grandTotal)
    : '$0';

  // Toggle empty state
  const hasData = entries.length > 0;
  DOM.chartCanvas.style.display  = hasData ? 'block' : 'none';
  DOM.chartEmpty.hidden          = hasData;

  // Clear legend
  DOM.chartLegend.innerHTML = '';

  if (!hasData) {
    ctx.clearRect(0, 0, W, H);
    return;
  }

  // Draw donut
  ctx.clearRect(0, 0, W, H);

  const cx        = W / 2;
  const cy        = H / 2;
  const outerR    = Math.min(W, H) / 2 - 4;
  const innerR    = outerR * 0.58;    // donut hole
  const gap       = 0.025;            // radians between slices
  let   startAngle = -Math.PI / 2;    // start at 12 o'clock

  entries.forEach(([catKey, value], i) => {
    const color     = CHART_COLORS[i % CHART_COLORS.length];
    const fraction  = value / grandTotal;
    const sliceAngle = fraction * (2 * Math.PI) - gap;

    // Slice
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Inner hole punch
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, innerR, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    startAngle += sliceAngle + gap;

    // Legend item
    const cat  = CATEGORIES[catKey] || { label: catKey };
    const pct  = Math.round(fraction * 100);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-dot" style="background:${color}"></span>
      <span>${escapeHtml(cat.label)} <strong>${pct}%</strong></span>
    `;
    DOM.chartLegend.appendChild(item);
  });
}

/* ─────────────────────────────────────────
   Full re-render
───────────────────────────────────────── */
function render() {
  renderSummary();
  renderTransactions();
  renderChart();
}

/* ─────────────────────────────────────────
   Add transaction
───────────────────────────────────────── */
function addTransaction(desc, amount, category, date, type) {
  const tx = {
    id:          Date.now(),
    description: desc.trim(),
    amount:      parseFloat(amount),
    category,
    date,        // 'YYYY-MM-DD'
    type,        // 'expense' | 'income'
  };
  transactions.push(tx);
  saveData();
  render();
}

/* ─────────────────────────────────────────
   Delete transaction
───────────────────────────────────────── */
function deleteTransaction(id) {
  transactions = transactions.filter(tx => tx.id !== id);
  saveData();
  render();
}

/* ─────────────────────────────────────────
   Form validation
───────────────────────────────────────── */
function validateForm() {
  let valid = true;

  // Description
  const desc = DOM.description.value.trim();
  if (!desc) {
    setError(DOM.description, DOM.descError, 'Please enter a description.');
    valid = false;
  } else {
    clearError(DOM.description, DOM.descError);
  }

  // Amount
  const amt = parseFloat(DOM.amount.value);
  if (!DOM.amount.value || isNaN(amt) || amt <= 0) {
    setError(DOM.amount, DOM.amountError, 'Please enter a valid amount greater than 0.');
    valid = false;
  } else {
    clearError(DOM.amount, DOM.amountError);
  }

  return valid;
}

function setError(input, errorEl, message) {
  input.classList.add('is-invalid');
  errorEl.textContent = message;
}

function clearError(input, errorEl) {
  input.classList.remove('is-invalid');
  errorEl.textContent = '';
}

/* ─────────────────────────────────────────
   Type toggle
───────────────────────────────────────── */
function setActiveType(type) {
  activeType = type;

  DOM.typeExpense.classList.toggle('toggle-btn--active', type === 'expense');
  DOM.typeIncome.classList.toggle('toggle-btn--active',  type === 'income');

  // Update submit button label
  DOM.submitBtn.textContent = type === 'expense' ? 'Add Expense' : 'Add Income';
}

/* ─────────────────────────────────────────
   Modal helpers
───────────────────────────────────────── */
function openModal(message, confirmLabel = 'Delete') {
  DOM.modalBody.textContent     = message;
  DOM.modalConfirm.textContent  = confirmLabel;
  DOM.modalOverlay.hidden       = false;
  DOM.modalConfirm.focus();
}

function closeModal() {
  DOM.modalOverlay.hidden = true;
  pendingDeleteId         = null;
}

/* ─────────────────────────────────────────
   Toast
───────────────────────────────────────── */
function showToast(message, variant = 'success') {
  clearTimeout(toastTimer);
  DOM.toast.textContent = message;
  DOM.toast.className   = `toast toast--${variant} show`;
  toastTimer = setTimeout(() => {
    DOM.toast.classList.remove('show');
  }, 2800);
}

/* ─────────────────────────────────────────
   Utility
───────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─────────────────────────────────────────
   Event listeners
───────────────────────────────────────── */

// Type toggle buttons
DOM.typeExpense.addEventListener('click', () => setActiveType('expense'));
DOM.typeIncome.addEventListener('click',  () => setActiveType('income'));

// Form submit
DOM.form.addEventListener('submit', e => {
  e.preventDefault();
  if (!validateForm()) return;

  addTransaction(
    DOM.description.value,
    DOM.amount.value,
    DOM.category.value,
    DOM.txDate.value || todayISO(),
    activeType
  );

  // Reset form
  DOM.description.value = '';
  DOM.amount.value      = '';
  DOM.txDate.value      = todayISO();
  DOM.description.focus();

  showToast(activeType === 'expense' ? '✅ Expense added!' : '✅ Income added!');
});

// Clear field errors on input
DOM.description.addEventListener('input', () => clearError(DOM.description, DOM.descError));
DOM.amount.addEventListener('input',      () => clearError(DOM.amount, DOM.amountError));

// Transaction list — event delegation for delete buttons
DOM.txList.addEventListener('click', e => {
  const btn = e.target.closest('.tx-delete');
  if (!btn) return;

  const id = Number(btn.dataset.id);
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;

  pendingDeleteId = id;
  openModal(`Delete "${tx.description}" (${formatCurrency(tx.amount)})?`);
});

// Modal confirm
DOM.modalConfirm.addEventListener('click', () => {
  if (pendingDeleteId !== null) {
    deleteTransaction(pendingDeleteId);
    showToast('🗑️ Transaction deleted.');
  }
  closeModal();
});

// Modal cancel
DOM.modalCancel.addEventListener('click', closeModal);

// Close modal on backdrop click
DOM.modalOverlay.addEventListener('click', e => {
  if (e.target === DOM.modalOverlay) closeModal();
});

// Close modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !DOM.modalOverlay.hidden) closeModal();
});

// Filter
DOM.filterType.addEventListener('change', e => {
  filterType = e.target.value;
  renderTransactions();
});

// Clear all data
DOM.clearAllBtn.addEventListener('click', () => {
  if (transactions.length === 0) {
    showToast('Nothing to clear.', 'error');
    return;
  }
  pendingDeleteId = null; // not a single tx delete
  openModal('This will permanently delete ALL transactions. Are you sure?', 'Clear All');

  // Override confirm handler for this one-time "clear all"
  DOM.modalConfirm.onclick = () => {
    transactions = [];
    saveData();
    render();
    closeModal();
    showToast('🗑️ All transactions cleared.');
    // Restore default confirm behaviour
    DOM.modalConfirm.onclick = null;
  };
});

/* ─────────────────────────────────────────
   Seed data (shown only on very first visit)
───────────────────────────────────────── */
function seedDemoData() {
  const today = todayISO();
  const [y, m] = today.split('-').map(Number);

  function isoDate(dayOffset) {
    const d = new Date(y, m - 1, Number(today.split('-')[2]) + dayOffset);
    return d.toISOString().slice(0, 10);
  }

  const demo = [
    { description: 'Monthly Salary',      amount: 3200, category: 'salary',        type: 'income',  date: isoDate(-6) },
    { description: 'Grocery Shopping',    amount: 85.5, category: 'food',           type: 'expense', date: isoDate(-5) },
    { description: 'Bus Pass',            amount: 30,   category: 'transport',      type: 'expense', date: isoDate(-4) },
    { description: 'Netflix',             amount: 15.99,category: 'entertainment',  type: 'expense', date: isoDate(-3) },
    { description: 'Electricity Bill',    amount: 72,   category: 'bills',          type: 'expense', date: isoDate(-2) },
    { description: 'Freelance Project',   amount: 450,  category: 'freelance',      type: 'income',  date: isoDate(-2) },
    { description: 'Coffee & Pastry',     amount: 12.4, category: 'food',           type: 'expense', date: isoDate(-1) },
    { description: 'New Shoes',           amount: 59.99,category: 'shopping',       type: 'expense', date: isoDate(0)  },
  ];

  transactions = demo.map((t, i) => ({ ...t, id: Date.now() + i }));
  saveData();
}

/* ─────────────────────────────────────────
   Init
───────────────────────────────────────── */
function init() {
  loadData();

  // Seed demo data only when storage is empty (first visit)
  if (transactions.length === 0) {
    seedDemoData();
  }

  // Set default date to today
  DOM.txDate.value = todayISO();

  render();
}

init();
