let currentUser = null;
let calendar = null;
let cars = [];
let reservations = [];
let hasConflict = false;
let hasWarnings = false;
let groups = [];
let currentGroupCode = 'gr';

const CAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

const isMobile = window.innerWidth <= 768;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadGroups();
  applyGroupTheme();
  await loadCars();
  initCalendar();
  loadCarStatusCards();
  setupReservationValidation();
  setupModalCleanup();
  checkPendingCompletions();
});

// モーダルが閉じた後の残骸クリーンアップを全モーダルに仕掛ける
// backdropクリック・ESCキー・閉じるボタン・プログラム閉じのどれで閉じても反応する
function setupModalCleanup() {
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('hidden.bs.modal', () => {
      setTimeout(() => {
        const stillOpen = document.querySelectorAll('.modal.show').length > 0;
        if (!stillOpen) {
          document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
          document.body.classList.remove('modal-open');
          document.body.style.overflow = '';
          document.body.style.paddingRight = '';
        }
      }, 50);
    });
  });
}

// 認証チェック
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const data = await res.json();
    currentUser = data.user;

    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('userRole').textContent =
      currentUser.role === 'admin' ? '管理者' : '一般ユーザー';
    document.getElementById('userAvatar').textContent =
      currentUser.name.charAt(0);

    if (currentUser.role === 'admin') {
      document.getElementById('adminLink').classList.remove('d-none');
    }

    // 横断可能 or 管理者は直前の選択を復元、一般は自グループ固定
    const canCrossGroup = currentUser.role === 'admin' || currentUser.cross_group;
    if (canCrossGroup) {
      currentGroupCode = localStorage.getItem('selectedGroup') || currentUser.group_code || 'gr';
    } else {
      currentGroupCode = currentUser.group_code || 'gr';
    }
  } catch (e) { window.location.href = '/login'; }
}

// グループ情報読み込み
async function loadGroups() {
  try {
    const res = await fetch('/api/auth/groups');
    if (res.ok) {
      groups = await res.json();
    }
  } catch (e) { /* ignore */ }
  renderGroupTabs();
}

function renderGroupTabs() {
  const container = document.getElementById('groupTabs');
  if (!container) return;

  const canCrossGroup = currentUser.role === 'admin' || currentUser.cross_group;
  const visibleGroups = canCrossGroup
    ? groups
    : groups.filter(g => g.code === currentUser.group_code);

  if (visibleGroups.length <= 1) {
    // タブ不要、見出しのみ
    if (visibleGroups.length === 1) {
      container.innerHTML = `
        <div class="group-tab-single" style="border-left-color:${visibleGroups[0].color}">
          <i class="bi bi-building"></i> ${escapeHtml(visibleGroups[0].name)}
        </div>`;
    } else {
      container.innerHTML = '';
    }
    return;
  }

  container.innerHTML = visibleGroups.map(g => `
    <button class="group-tab ${g.code === currentGroupCode ? 'active' : ''}"
            data-code="${g.code}"
            style="--tab-color:${g.color}"
            onclick="switchGroup('${g.code}')">
      <i class="bi bi-building"></i> ${escapeHtml(g.name)}
    </button>
  `).join('');
}

async function switchGroup(code) {
  if (code === currentGroupCode) return;
  currentGroupCode = code;
  localStorage.setItem('selectedGroup', code);
  applyGroupTheme();
  renderGroupTabs();
  await loadCars();
  if (calendar) calendar.refetchEvents();
  loadCarStatusCards();
}

function getCurrentGroup() {
  return groups.find(g => g.code === currentGroupCode);
}

function isAkiota() {
  return currentGroupCode === 'akiota';
}

function applyGroupTheme() {
  document.body.classList.toggle('theme-akiota', isAkiota());
  document.body.classList.toggle('theme-gr', !isAkiota());

  const g = getCurrentGroup();
  const brand = document.getElementById('brandName');
  const title = document.getElementById('pageTitleText');
  if (g && brand) brand.textContent = g.name;
  if (title) title.textContent = '予約カレンダー';

  // 運行記録簿リンクは安芸太田のみ
  const navLog = document.getElementById('navOperationLog');
  if (navLog) navLog.classList.toggle('d-none', !isAkiota());

  // 操作説明書リンクをグループに応じて切替
  const manualUrl = isAkiota() ? '/manual-akiota.html' : '/manual.html';
  const manualLink = document.getElementById('manualLink');
  const manualLinkHeader = document.getElementById('manualLinkHeader');
  if (manualLink) manualLink.setAttribute('href', manualUrl);
  if (manualLinkHeader) manualLinkHeader.setAttribute('href', manualUrl);
}

// 車両データ読み込み
async function loadCars() {
  try {
    const res = await fetch(`/api/cars?group=${currentGroupCode}`);
    cars = await res.json();
    cars = cars.filter(c => c.is_active);

    const resSelect = document.getElementById('resCarId');
    resSelect.innerHTML = '<option value="">選択してください</option>';
    cars.forEach((car, i) => {
      resSelect.innerHTML += `<option value="${car.id}">${car.model} [${car.name}] - ${car.capacity}人乗り</option>`;
    });

    // 運行記録簿の車両セレクトも更新
    const logSelect = document.getElementById('logCarSelect');
    if (logSelect) {
      logSelect.innerHTML = cars.map(c =>
        `<option value="${c.id}">${escapeHtml(c.model)} [${escapeHtml(c.name)}]</option>`
      ).join('');
    }
  } catch (e) {
    console.error('車両データ取得エラー:', e);
  }
}

// ===== 日付・時間ヘルパー =====
function getResStart() {
  return document.getElementById('resStartDate').value + 'T' + document.getElementById('resStartTime').value;
}
function getResEnd() {
  return document.getElementById('resEndDate').value + 'T' + document.getElementById('resEndTime').value;
}
function setResStart(datetimeStr) {
  document.getElementById('resStartDate').value = datetimeStr.slice(0, 10);
  document.getElementById('resStartTime').value = datetimeStr.slice(11, 16);
}
function setResEnd(datetimeStr) {
  document.getElementById('resEndDate').value = datetimeStr.slice(0, 10);
  document.getElementById('resEndTime').value = datetimeStr.slice(11, 16);
}

// ===== 予約フォームのリアルタイムバリデーション =====
function setupReservationValidation() {
  const fields = ['resCarId', 'resStartDate', 'resStartTime', 'resEndDate', 'resEndTime', 'resDeparture', 'resReturn'];
  fields.forEach(id => {
    document.getElementById(id).addEventListener('change', validateReservation);
  });
  // 開始日変更時に終了日を同日に連動
  document.getElementById('resStartDate').addEventListener('change', () => {
    document.getElementById('resEndDate').value = document.getElementById('resStartDate').value;
  });

  // 完了モーダルの距離自動計算
  const startOdoEl = document.getElementById('completeStartOdo');
  const endOdoEl = document.getElementById('completeEndOdo');
  if (startOdoEl && endOdoEl) {
    const calc = () => {
      const s = parseFloat(startOdoEl.value);
      const e = parseFloat(endOdoEl.value);
      const distEl = document.getElementById('completeDistance');
      if (!isNaN(s) && !isNaN(e) && e >= s) {
        distEl.value = (e - s).toFixed(1);
      } else {
        distEl.value = '';
      }
    };
    startOdoEl.addEventListener('input', calc);
    endOdoEl.addEventListener('input', calc);
  }
}

async function validateReservation() {
  const warnings = [];
  hasConflict = false;

  const carId = document.getElementById('resCarId').value;
  const startStr = getResStart();
  const endStr = getResEnd();
  const departure = document.getElementById('resDeparture').value;
  const excludeId = document.getElementById('reservationId').value;

  if (carId && startStr.length >= 16 && endStr.length >= 16) {
    try {
      let url = `/api/reservations/check-conflict?car_id=${carId}&start=${startStr}&end=${endStr}`;
      if (excludeId) url += `&exclude_id=${excludeId}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.conflict) {
        hasConflict = true;
        warnings.push({ type: 'danger', icon: 'x-circle-fill', text: data.message });
      }
    } catch (e) { /* ignore */ }
  }

  if (startStr.length >= 16 && endStr.length >= 16) {
    const startDate = startStr.slice(0, 10);
    const endDate = endStr.slice(0, 10);
    if (startDate !== endDate) {
      warnings.push({ type: 'warning', icon: 'exclamation-triangle-fill', text: '貸出が日をまたいでいます。日付をご確認ください。' });
    }
  }

  if (carId && departure) {
    const car = cars.find(c => c.id === parseInt(carId));
    if (car && car.current_location !== departure) {
      warnings.push({ type: 'warning', icon: 'exclamation-triangle-fill',
        text: `この車両の現在地は「${escapeHtml(car.current_location)}」ですが、出発場所が「${escapeHtml(departure)}」になっています。` });
    }
  }

  if (carId && startStr.length >= 16 && departure) {
    try {
      const res = await fetch(`/api/reservations/last-return?car_id=${carId}&before=${startStr}`);
      const data = await res.json();
      if (data.return_location && data.return_location !== departure) {
        warnings.push({ type: 'warning', icon: 'exclamation-triangle-fill',
          text: `前回の返却先は「${escapeHtml(data.return_location)}」（${escapeHtml(data.user_name)}さん）ですが、出発場所が異なります。` });
      }
    } catch (e) { /* ignore */ }
  }

  hasWarnings = warnings.some(w => w.type === 'warning');

  const container = document.getElementById('resWarnings');
  container.innerHTML = warnings.map(w =>
    `<div class="alert alert-${w.type} py-2 px-3 mb-2 d-flex align-items-start gap-2" style="font-size:13px;">
      <i class="bi bi-${w.icon} mt-1 flex-shrink-0"></i><span>${w.text}</span>
    </div>`
  ).join('');

  const saveBtn = document.getElementById('saveResBtn');
  saveBtn.disabled = hasConflict;
  saveBtn.classList.toggle('btn-secondary', hasConflict);
  saveBtn.classList.toggle('btn-primary', !hasConflict);
}

// ===== カレンダー =====
function initCalendar() {
  const calendarEl = document.getElementById('calendar');

  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'dayGridMonth',
    locale: 'ja',
    headerToolbar: isMobile
      ? { left: 'prev,next', center: 'title', right: 'dayGridMonth,listWeek' }
      : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    buttonText: { today: '今日', month: '月', week: '週', day: '日', list: 'リスト' },
    allDayText: '終日',
    slotMinTime: '06:00:00',
    slotMaxTime: '22:00:00',
    height: 'auto',
    dayMaxEvents: isMobile ? 3 : false,
    navLinks: false,
    editable: false,
    selectable: true,
    selectMirror: true,
    dateClick: (info) => { openNewReservation(info.dateStr); },
    nowIndicator: true,
    displayEventEnd: false,
    eventTimeFormat: isMobile
      ? { hour: 'numeric', hour12: false }
      : { hour: '2-digit', minute: '2-digit', hour12: false },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    events: fetchEvents,
    eventClick: showEventDetail,
    select: (info) => { openNewReservation(info.startStr, info.endStr); },
    eventDidMount: (info) => {
      const props = info.event.extendedProps;
      info.el.title = `${props.car_model}\n${props.departure_location} → ${props.return_location}\n予約者: ${props.user_name}`;

      // スマホ月表示：時間を「9時」形式に
      if (isMobile && info.view.type === 'dayGridMonth') {
        const timeEl = info.el.querySelector('.fc-event-time');
        if (timeEl) {
          const hour = parseInt(timeEl.textContent.trim(), 10);
          if (!isNaN(hour)) timeEl.textContent = hour + '時';
        }
      }
    }
  });

  calendar.render();
}

// イベントデータ取得
async function fetchEvents(fetchInfo, successCallback, failureCallback) {
  try {
    const res = await fetch(`/api/reservations?group=${currentGroupCode}&start=${fetchInfo.startStr}&end=${fetchInfo.endStr}`);
    reservations = await res.json();

    const now = new Date();
    const events = reservations.map(r => {
      const carIndex = cars.findIndex(c => c.id === r.car_id);
      const color = CAR_COLORS[carIndex % CAR_COLORS.length] || '#6b7280';

      const startTime = new Date(r.start_datetime);
      const endTime = new Date(r.end_datetime);
      const isInUse = r.status === 'active' && now >= new Date(startTime.getTime() - 10 * 60 * 1000) && now < endTime;

      // スマホ月表示: 予約者名を省いて車種だけ
      const title = isMobile
        ? (isInUse ? `🚗${r.car_model}` : r.car_model)
        : (isInUse ? `🚗 ${r.car_model} - ${r.user_name}` : `${r.car_model} - ${r.user_name}`);

      return {
        id: r.id,
        title: title,
        start: r.start_datetime,
        end: r.end_datetime,
        display: 'block',
        backgroundColor: isInUse ? '#dc2626' : color,
        borderColor: isInUse ? '#dc2626' : color,
        classNames: isInUse ? ['event-in-use'] : [],
        extendedProps: {
          car_id: r.car_id, car_name: r.car_name, car_model: r.car_model,
          user_id: r.user_id, user_name: r.user_name, employee_id: r.employee_id,
          departure_location: r.departure_location, return_location: r.return_location,
          status: r.status, notes: r.notes, isInUse: isInUse,
          start_odometer: r.start_odometer, end_odometer: r.end_odometer,
          distance_used: r.distance_used, purpose: r.purpose, completed_at: r.completed_at
        }
      };
    });

    successCallback(events);
  } catch (e) { failureCallback(e); }
}

// イベント詳細表示
function showEventDetail(info) {
  const props = info.event.extendedProps;
  const start = new Date(info.event.start);
  const end = new Date(info.event.end);

  const formatDate = (d) => d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const formatTime = (d) => d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });

  const nowDetail = new Date();
  const isInUse = props.status === 'active' && nowDetail >= new Date(start.getTime() - 10*60*1000) && nowDetail < end;

  const activeLabel = isInUse
    ? '<span class="status-badge in-use"><i class="bi bi-exclamation-circle"></i> 使用中</span>'
    : '<span class="status-badge reserved">予約中</span>';

  const statusText = {
    active: activeLabel,
    completed: '<span class="status-badge available">完了</span>',
    cancelled: '<span class="status-badge" style="background:#e2e8f0;color:#475569;">キャンセル済</span>'
  };

  // 運行記録（安芸太田・完了済の場合のみ表示）
  let logHtml = '';
  if (isAkiota() && props.status === 'completed') {
    logHtml = `
      <div class="detail-row">
        <div class="detail-icon"><i class="bi bi-speedometer2"></i></div>
        <div>
          <div class="detail-label">積算距離</div>
          <div class="detail-value">出庫 ${fmtKm(props.start_odometer)} → 帰着 ${fmtKm(props.end_odometer)} km</div>
          <div class="detail-value" style="color:#059669;">使用距離: ${fmtKm(props.distance_used)} km</div>
        </div>
      </div>
      ${props.purpose ? `<div class="detail-row"><div class="detail-icon"><i class="bi bi-signpost"></i></div><div><div class="detail-label">行先・使用目的</div><div class="detail-value">${escapeHtml(props.purpose)}</div></div></div>` : ''}
      ${props.completed_at ? `<div class="detail-row"><div class="detail-icon"><i class="bi bi-clock-history"></i></div><div><div class="detail-label">帰着時間</div><div class="detail-value">${escapeHtml(props.completed_at.replace('T',' '))}</div></div></div>` : ''}
    `;
  }

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-car-front"></i></div>
      <div><div class="detail-label">車両</div><div class="detail-value">${props.car_model}（${props.car_name}）</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-calendar-event"></i></div>
      <div><div class="detail-label">日時</div><div class="detail-value">${formatDate(start)}</div><div class="detail-value">${formatTime(start)} ～ ${formatTime(end)}</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-geo-alt"></i></div>
      <div><div class="detail-label">出発場所</div><div class="detail-value">${escapeHtml(props.departure_location)}</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-geo-alt-fill"></i></div>
      <div><div class="detail-label">返却場所</div><div class="detail-value">${escapeHtml(props.return_location)}</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-person"></i></div>
      <div><div class="detail-label">予約者</div><div class="detail-value">${escapeHtml(props.user_name)}（${escapeHtml(props.employee_id)}）</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-flag"></i></div>
      <div><div class="detail-label">ステータス</div><div class="detail-value">${statusText[props.status] || props.status}</div></div>
    </div>
    ${props.notes ? `<div class="detail-row"><div class="detail-icon"><i class="bi bi-chat-text"></i></div><div><div class="detail-label">備考</div><div class="detail-value">${escapeHtml(props.notes)}</div></div></div>` : ''}
    ${logHtml}
  `;

  let footerHtml = '<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>';
  const isOwner = props.user_id === currentUser.id;
  const isOwnerOrAdmin = isOwner || currentUser.role === 'admin';
  const canEdit = props.status === 'active' && isOwnerOrAdmin;

  // 完全削除の権限: 自分の予約は誰でも / 他人の予約は管理者 or 髙宮(101)
  const canPurgeOthers = currentUser.role === 'admin' || currentUser.employee_id === '101';
  const canPurge = isOwner || canPurgeOthers;
  const purgeBtn = canPurge
    ? `<button class="btn btn-outline-danger btn-sm" onclick="purgeReservation(${info.event.id})" title="完全削除（テストデータ削除用）"><i class="bi bi-trash"></i> 削除</button>`
    : '';

  if (canEdit) {
    const completeBtn = isAkiota()
      ? `<button class="btn btn-success" onclick="openCompleteModal(${info.event.id})"><i class="bi bi-check-circle"></i> 完了</button>`
      : '';
    footerHtml = `
      ${completeBtn}
      <button class="btn btn-warning" onclick="editReservation(${info.event.id})"><i class="bi bi-pencil"></i> 編集</button>
      <button class="btn btn-danger" onclick="cancelReservation(${info.event.id})"><i class="bi bi-x-circle"></i> キャンセル</button>
      ${purgeBtn}
      ${footerHtml}`;
  } else {
    footerHtml = `${purgeBtn} ${footerHtml}`;
  }
  document.getElementById('detailFooter').innerHTML = footerHtml;
  new bootstrap.Modal(document.getElementById('detailModal')).show();
}

function fmtKm(v) {
  if (v == null || v === '') return '-';
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toFixed(1);
}

// 完了モーダルを開く（予約IDベース：カレンダー一覧から検索）
async function openCompleteModal(id) {
  bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide();
  const r = reservations.find(r => r.id === id);
  if (!r) return;
  setTimeout(() => openCompleteModalWith(r), 400);
}

// 完了モーダルを開く（予約オブジェクト直接渡し：リマインダーから）
function openCompleteModalWith(r) {
  document.getElementById('completeResId').value = r.id;
  const startOdo = r.start_odometer != null ? r.start_odometer : 0;
  document.getElementById('completeStartOdo').value = startOdo;
  document.getElementById('completeEndOdo').value = '';
  document.getElementById('completeDistance').value = '';
  document.getElementById('completePurpose').value = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('completeModal')).show();
}

// 安芸太田ログイン時の完了リマインダー
async function checkPendingCompletions() {
  if (!currentUser || currentUser.group_code !== 'akiota') return;
  try {
    const res = await fetch('/api/reservations/pending-complete');
    if (!res.ok) return;
    const list = await res.json();
    if (list.length === 0) return;

    // 優先順: まず「終了超過」、なければ「使用中」
    const overdue = list.find(r => r.overdue);
    const inProgress = list.find(r => r.in_progress);
    const target = overdue || inProgress;
    if (!target) return;
    showCompletionPrompt(target, !!overdue);
  } catch (e) { /* ignore */ }
}

function showCompletionPrompt(r, isOverdue) {
  const header = document.getElementById('completionPromptHeader');
  header.className = isOverdue
    ? 'modal-header bg-danger text-white'
    : 'modal-header bg-warning text-dark';
  header.style.borderRadius = '12px 12px 0 0';

  document.getElementById('completionPromptTitle').innerHTML = isOverdue
    ? '<i class="bi bi-exclamation-triangle-fill"></i> 完了ボタンが押されていません'
    : '<i class="bi bi-question-circle-fill"></i> 運転は終了しましたか？';

  const period = `${r.start_datetime.replace('T',' ')} ～ ${r.end_datetime.replace('T',' ')}`;
  const alertCls = isOverdue ? 'alert-danger' : 'alert-info';
  const msg = isOverdue
    ? '<strong>終了日時を過ぎていますが、完了ボタンが押されていません。</strong><br>使用が終了している場合は「完了」を押してください。'
    : '現在、以下の車両を使用中です。<br><strong>運転は終了しましたか？</strong>';

  document.getElementById('completionPromptBody').innerHTML = `
    <div class="alert ${alertCls} py-2 px-3 mb-3" style="font-size:14px;">${msg}</div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-car-front"></i></div>
      <div><div class="detail-label">車両</div><div class="detail-value">${escapeHtml(r.car_model)}（${escapeHtml(r.car_name)}）</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-calendar-event"></i></div>
      <div><div class="detail-label">予約期間</div><div class="detail-value">${period}</div></div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-arrow-right"></i></div>
      <div><div class="detail-label">出発 → 返却</div><div class="detail-value">${escapeHtml(r.departure_location)} → ${escapeHtml(r.return_location)}</div></div>
    </div>
  `;

  // ボタンのハンドラを差し替え（前回のリスナが残らないようクローン）
  const doneBtn = document.getElementById('completionPromptDone');
  const newDone = doneBtn.cloneNode(true);
  doneBtn.parentNode.replaceChild(newDone, doneBtn);
  newDone.addEventListener('click', () => {
    closeModalFully('completionPromptModal');
    setTimeout(() => openCompleteModalWith(r), 400);
  });

  const notYetBtn = document.getElementById('completionPromptNotYet');
  const newNotYet = notYetBtn.cloneNode(true);
  notYetBtn.parentNode.replaceChild(newNotYet, notYetBtn);
  newNotYet.addEventListener('click', () => {
    closeModalFully('completionPromptModal');
  });

  bootstrap.Modal.getOrCreateInstance(document.getElementById('completionPromptModal')).show();
}

async function submitComplete() {
  const id = document.getElementById('completeResId').value;
  const startOdo = document.getElementById('completeStartOdo').value;
  const endOdo = document.getElementById('completeEndOdo').value;
  const purpose = document.getElementById('completePurpose').value;

  if (endOdo === '' || endOdo == null) {
    alert('帰着時の積算距離を入力してください');
    return;
  }
  if (!purpose.trim()) {
    alert('行先・使用目的を入力してください');
    return;
  }
  if (parseFloat(endOdo) < parseFloat(startOdo || 0)) {
    alert('帰着距離は出庫距離以上にしてください');
    return;
  }

  try {
    const res = await fetch(`/api/reservations/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_odometer: startOdo,
        end_odometer: endOdo,
        purpose: purpose
      })
    });
    const result = await res.json();
    if (res.ok) {
      closeModalFully('completeModal');
      closeModalFully('detailModal');
      calendar.refetchEvents();
      loadCarStatusCards();
      // 他にも未完了の予約があれば引き続きプロンプト表示
      setTimeout(() => checkPendingCompletions(), 600);
    } else {
      alert(result.error || '完了処理に失敗しました');
    }
  } catch (e) {
    alert('完了処理に失敗しました');
  }
}

// 新規予約モーダル
function openNewReservation(startStr, endStr) {
  document.getElementById('reservationModalTitle').innerHTML = '<i class="bi bi-plus-circle"></i> 新規予約';
  document.getElementById('reservationId').value = '';
  document.getElementById('resCarId').value = '';
  // 安芸太田は拠点名ベース、GRは従来どおり弥山
  const defaultLoc = isAkiota() ? '' : '弥山';
  document.getElementById('resDeparture').value = defaultLoc;
  document.getElementById('resReturn').value = defaultLoc;
  document.getElementById('resNotes').value = '';
  document.getElementById('resWarnings').innerHTML = '';
  document.getElementById('saveResBtn').disabled = false;
  document.getElementById('saveResBtn').className = 'btn btn-primary';

  if (startStr) {
    const start = startStr.includes('T') ? startStr.slice(0, 16) : startStr + 'T09:00';
    const end = endStr ? (endStr.includes('T') ? endStr.slice(0, 16) : endStr + 'T18:00') : startStr + 'T18:00';
    setResStart(start);
    setResEnd(end);
  } else {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ds = tomorrow.toISOString().slice(0, 10);
    setResStart(ds + 'T09:00');
    setResEnd(ds + 'T18:00');
  }

  new bootstrap.Modal(document.getElementById('reservationModal')).show();
}

// 予約を編集モードで開く
function editReservation(id) {
  bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide();
  const r = reservations.find(r => r.id === id);
  if (!r) return;

  document.getElementById('reservationModalTitle').innerHTML = '<i class="bi bi-pencil"></i> 予約編集';
  document.getElementById('reservationId').value = r.id;
  document.getElementById('resCarId').value = r.car_id;
  setResStart(r.start_datetime.slice(0, 16));
  setResEnd(r.end_datetime.slice(0, 16));
  document.getElementById('resDeparture').value = r.departure_location;
  document.getElementById('resReturn').value = r.return_location;
  document.getElementById('resNotes').value = r.notes || '';
  document.getElementById('resWarnings').innerHTML = '';
  document.getElementById('saveResBtn').disabled = false;
  document.getElementById('saveResBtn').className = 'btn btn-primary';

  setTimeout(() => {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('reservationModal')).show();
  }, 400);
}

// 予約保存
async function saveReservation(forceConfirmed) {
  if (hasConflict) return;

  // 警告がある場合はカスタム確認モーダルを表示
  if (hasWarnings && !forceConfirmed) {
    const warningHtml = Array.from(document.querySelectorAll('#resWarnings .alert-warning'))
      .map(el => el.outerHTML).join('');
    document.getElementById('warningConfirmBody').innerHTML =
      `<p style="font-weight:600;margin-bottom:12px;">以下の注意事項があります：</p>
       ${warningHtml}
       <p class="mt-3 mb-0" style="font-size:14px;">この内容で予約を確定してよろしいですか？</p>`;

    bootstrap.Modal.getInstance(document.getElementById('reservationModal'))?.hide();
    setTimeout(() => {
      const confirmModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('warningConfirmModal'));
      confirmModal.show();

      const btn = document.getElementById('warningConfirmBtn');
      const handler = () => {
        btn.removeEventListener('click', handler);
        confirmModal.hide();
        setTimeout(() => saveReservation(true), 400);
      };
      btn.addEventListener('click', handler);
    }, 400);
    return;
  }

  const id = document.getElementById('reservationId').value;
  const data = {
    car_id: document.getElementById('resCarId').value,
    start_datetime: getResStart(),
    end_datetime: getResEnd(),
    departure_location: document.getElementById('resDeparture').value,
    return_location: document.getElementById('resReturn').value,
    notes: document.getElementById('resNotes').value
  };

  if (!data.car_id || data.start_datetime.length < 16 || data.end_datetime.length < 16 || !data.departure_location || !data.return_location) {
    alert('必須項目を入力してください'); return;
  }

  try {
    const url = id ? `/api/reservations/${id}` : '/api/reservations';
    const res = await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) {
      closeModalFully('reservationModal');
      closeModalFully('warningConfirmModal');
      calendar.refetchEvents();
      loadCarStatusCards();
    } else { alert(result.error); }
  } catch (e) { alert('保存に失敗しました'); }
}

// 予約キャンセル
async function cancelReservation(id) {
  if (!confirm('この予約をキャンセルしますか？')) return;
  try {
    const res = await fetch(`/api/reservations/${id}`, { method: 'DELETE' });
    if (res.ok) { closeModalFully('detailModal'); calendar.refetchEvents(); loadCarStatusCards(); }
    else { const d = await res.json(); alert(d.error); }
  } catch (e) { alert('キャンセルに失敗しました'); }
}

// 予約完全削除（テストデータ整理用・DB行ごと削除）
async function purgeReservation(id) {
  if (!confirm('この予約を完全に削除しますか？\n\n※運行記録簿からも消え、元に戻せません。\nテストデータの削除用です。')) return;
  try {
    const res = await fetch(`/api/reservations/${id}/purge`, { method: 'DELETE' });
    if (res.ok) {
      closeModalFully('detailModal');
      calendar.refetchEvents();
      loadCarStatusCards();
    } else {
      const d = await res.json();
      alert(d.error || '削除に失敗しました');
    }
  } catch (e) { alert('削除に失敗しました'); }
}

// ===== 車両ステータスカード（折りたたみ式） =====
async function loadCarStatusCards() {
  let statusData = { current: {}, next: {} };
  try {
    const res = await fetch(`/api/reservations/status/all?group=${currentGroupCode}`);
    statusData = await res.json();
  } catch (e) { /* ignore */ }

  let statusHtml = '';

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const color = CAR_COLORS[i % CAR_COLORS.length];
    const current = statusData.current[car.id];
    const next = statusData.next[car.id];

    const isInUse = !!current;
    const statusBadge = isInUse
      ? `<span class="status-badge in-use"><i class="bi bi-exclamation-circle"></i> 使用中</span>`
      : `<span class="status-badge available"><i class="bi bi-check-circle"></i> 空車</span>`;

    let hasWarning = false;
    let locationWarning = '';
    if (next) {
      if (current && current.return_location !== next.departure_location) {
        hasWarning = true;
        locationWarning = `<div class="car-location-warning"><i class="bi bi-exclamation-triangle-fill"></i> 返却先「${escapeHtml(current.return_location)}」と次回出発「${escapeHtml(next.departure_location)}」が異なります</div>`;
      } else if (!current && car.current_location !== next.departure_location) {
        hasWarning = true;
        locationWarning = `<div class="car-location-warning"><i class="bi bi-exclamation-triangle-fill"></i> 現在地「${escapeHtml(car.current_location)}」と次回出発「${escapeHtml(next.departure_location)}」が異なります</div>`;
      }
    }

    const warningIcon = hasWarning ? ' <i class="bi bi-exclamation-triangle-fill" style="color:#f59e0b"></i>' : '';

    let detailHtml = '';

    if (current) {
      detailHtml += `
        <div class="status-row"><i class="bi bi-person-fill" style="color:#ef4444"></i><span><strong>${escapeHtml(current.user_name)}</strong> が使用中</span></div>
        <div class="status-row"><i class="bi bi-clock" style="color:#64748b"></i><span>${current.start_datetime.slice(11,16)} ～ ${current.end_datetime.slice(11,16)}</span></div>
        <div class="status-row"><i class="bi bi-arrow-right" style="color:#64748b"></i><span>${escapeHtml(current.departure_location)} → ${escapeHtml(current.return_location)}</span></div>
      `;
    }

    detailHtml += `<div class="status-row"><i class="bi bi-geo-alt" style="color:#64748b"></i><span>現在地: ${escapeHtml(car.current_location)}</span></div>`;
    detailHtml += locationWarning;

    if (next) {
      const nd = new Date(next.start_datetime);
      const dl = nd.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', weekday: 'short' });
      detailHtml += `
        <div class="next-reservation">
          <div class="next-label"><i class="bi bi-fast-forward-fill"></i> 次回予約</div>
          <div class="next-detail">${dl} ${next.start_datetime.slice(11,16)}～ / ${escapeHtml(next.user_name)}</div>
          <div class="next-detail">${escapeHtml(next.departure_location)} → ${escapeHtml(next.return_location)}</div>
        </div>`;
    }

    statusHtml += `
      <div class="car-status-card" style="border-left-color: ${color}" data-car-id="${car.id}">
        <div class="car-card-compact" onclick="toggleCarCard(this)">
          <span class="car-compact-name">${escapeHtml(car.model)}</span>
          <span class="car-compact-right">${warningIcon} ${statusBadge} <i class="bi bi-chevron-down car-chevron"></i></span>
        </div>
        <div class="car-card-detail">
          <div class="car-id-label">${escapeHtml(car.name)} / ${car.capacity}人乗り</div>
          ${detailHtml}
        </div>
      </div>
    `;
  }

  document.getElementById('carStatusGrid').innerHTML = statusHtml;
}

function toggleCarCard(el) {
  el.parentElement.classList.toggle('expanded');
}

// ビュー切り替え
function showCarStatus() {
  document.getElementById('calendarView').classList.add('d-none');
  document.getElementById('carStatusView').classList.remove('d-none');
  document.getElementById('operationLogView').classList.add('d-none');
  document.getElementById('carStatusDetail').innerHTML = document.getElementById('carStatusGrid').innerHTML;
  document.querySelectorAll('#carStatusDetail .car-status-card').forEach(c => c.classList.add('expanded'));
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[1].classList.add('active');
}

function showCalendar() {
  document.getElementById('calendarView').classList.remove('d-none');
  document.getElementById('carStatusView').classList.add('d-none');
  document.getElementById('operationLogView').classList.add('d-none');
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[0].classList.add('active');
}

// 運行記録簿ビュー
function showOperationLog() {
  document.getElementById('calendarView').classList.add('d-none');
  document.getElementById('carStatusView').classList.add('d-none');
  document.getElementById('operationLogView').classList.remove('d-none');

  // 年月セレクトを初期化（初回のみ）
  const yearSel = document.getElementById('logYearSelect');
  const monthSel = document.getElementById('logMonthSelect');
  if (yearSel.options.length === 0) {
    const now = new Date();
    const curY = now.getFullYear();
    for (let y = curY - 1; y <= curY + 1; y++) {
      yearSel.innerHTML += `<option value="${y}" ${y === curY ? 'selected' : ''}>${y}</option>`;
    }
    for (let m = 1; m <= 12; m++) {
      monthSel.innerHTML += `<option value="${m}" ${m === now.getMonth() + 1 ? 'selected' : ''}>${m}</option>`;
    }
  }

  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('navOperationLog').querySelector('a').classList.add('active');

  loadOperationLog();
}

async function loadOperationLog() {
  const carId = document.getElementById('logCarSelect').value;
  const year = document.getElementById('logYearSelect').value;
  const month = document.getElementById('logMonthSelect').value;

  if (!carId) {
    document.getElementById('operationLogContent').innerHTML =
      '<div class="alert alert-info">車両を選択してください</div>';
    return;
  }

  try {
    const res = await fetch(`/api/reservations/operation-log?car_id=${carId}&year=${year}&month=${month}`);
    if (!res.ok) {
      document.getElementById('operationLogContent').innerHTML =
        '<div class="alert alert-danger">取得に失敗しました</div>';
      return;
    }
    const data = await res.json();
    renderOperationLog(data);
  } catch (e) {
    document.getElementById('operationLogContent').innerHTML =
      '<div class="alert alert-danger">取得に失敗しました</div>';
  }
}

function renderOperationLog(data) {
  const { car, year, month, records } = data;

  const rows = records.map(r => {
    const startDate = r.start_datetime.slice(0, 10);
    const day = parseInt(startDate.slice(8, 10));
    const outTime = r.start_datetime.slice(11, 16);
    const inTime = r.completed_at ? r.completed_at.slice(11, 16) : '-';
    const startOdo = fmtKm(r.start_odometer);
    const endOdo = fmtKm(r.end_odometer);
    const dist = fmtKm(r.distance_used);
    const purpose = escapeHtml(r.purpose || '');
    return `
      <tr>
        <td>${day}</td>
        <td>${escapeHtml(r.user_name)}</td>
        <td>${outTime}</td>
        <td>${inTime}</td>
        <td class="num">${startOdo}</td>
        <td class="num">${endOdo}</td>
        <td class="num">${dist}</td>
        <td>${purpose}</td>
      </tr>
    `;
  }).join('');

  // 空の行で埋めてPDFっぽく
  const minRows = Math.max(0, 24 - records.length);
  let emptyRows = '';
  for (let i = 0; i < minRows; i++) {
    emptyRows += '<tr class="empty-row"><td>&nbsp;</td><td></td><td>：</td><td>：</td><td></td><td></td><td></td><td></td></tr>';
  }

  document.getElementById('operationLogContent').innerHTML = `
    <div class="operation-log-sheet">
      <div class="log-header">
        <div class="log-title">運行記録簿</div>
        <div class="log-meta">
          <div><span class="meta-label">車　種</span><span class="meta-value">${escapeHtml(car.model)}</span></div>
          <div><span class="meta-label">${year}年 ${month}月度</span></div>
        </div>
      </div>
      <div class="log-sub">
        <div><span class="meta-label">登録番号</span><span class="meta-value">${escapeHtml(car.name)}</span></div>
        <div><span class="meta-label">拠点名</span><span class="meta-value">${escapeHtml(car.current_location)}</span></div>
      </div>
      <table class="operation-log-table">
        <thead>
          <tr>
            <th rowspan="2">日</th>
            <th rowspan="2">使用者</th>
            <th rowspan="2">出庫時間</th>
            <th rowspan="2">帰着時間</th>
            <th colspan="2">積算距離(km)</th>
            <th rowspan="2">使用距離<br>(km)</th>
            <th rowspan="2">行先・使用目的</th>
          </tr>
          <tr>
            <th>出庫</th>
            <th>帰着</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${emptyRows}
        </tbody>
      </table>
      <div class="log-footer">
        <span>月次終了後、検印の上保管願います。</span>
        <table class="stamp-box">
          <tr><th>MG</th><th>担当</th></tr>
          <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
        </table>
      </div>
      <div class="mt-3 d-print-none">
        <button class="btn btn-outline-secondary btn-sm" onclick="window.print()">
          <i class="bi bi-printer"></i> 印刷
        </button>
      </div>
    </div>
  `;
}

// サイドバートグル
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('show');
  if (sidebar.classList.contains('show')) {
    setTimeout(() => document.addEventListener('click', closeSidebarOnOutsideClick), 0);
  }
}
function closeSidebarOnOutsideClick(e) {
  const sidebar = document.getElementById('sidebar');
  const menuBtn = document.querySelector('.mobile-menu-btn');
  if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
    sidebar.classList.remove('show');
    document.removeEventListener('click', closeSidebarOnOutsideClick);
  }
}

// パスワード変更
function openPasswordModal() {
  document.getElementById('currentPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  new bootstrap.Modal(document.getElementById('passwordModal')).show();
}

async function changePassword() {
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    alert('全ての項目を入力してください');
    return;
  }
  if (newPassword !== confirmPassword) {
    alert('新しいパスワードが一致しません');
    return;
  }
  if (newPassword.length < 4) {
    alert('パスワードは4文字以上にしてください');
    return;
  }

  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
    });
    const result = await res.json();
    if (res.ok) {
      alert('パスワードを変更しました');
      bootstrap.Modal.getInstance(document.getElementById('passwordModal'))?.hide();
    } else {
      alert(result.error);
    }
  } catch (e) {
    alert('パスワード変更に失敗しました');
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// モーダルを確実に閉じる（backdrop残留対策）
function closeModalFully(id) {
  const el = document.getElementById(id);
  if (el) {
    const inst = bootstrap.Modal.getInstance(el);
    if (inst) inst.hide();
  }
  // アニメーション後、残骸を掃除
  setTimeout(() => {
    const stillOpen = document.querySelectorAll('.modal.show').length > 0;
    if (!stillOpen) {
      document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
      document.body.classList.remove('modal-open');
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    }
  }, 400);
}
