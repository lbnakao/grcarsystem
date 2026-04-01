let currentUser = null;
let calendar = null;
let cars = [];
let reservations = [];
let hasConflict = false;

const CAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

const isMobile = window.innerWidth <= 768;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadCars();
  initCalendar();
  loadCarStatusCards();
  setupReservationValidation();
});

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
  } catch (e) { window.location.href = '/login'; }
}

// 車両データ読み込み
async function loadCars() {
  try {
    const res = await fetch('/api/cars');
    cars = await res.json();
    cars = cars.filter(c => c.is_active);

    const resSelect = document.getElementById('resCarId');
    resSelect.innerHTML = '<option value="">選択してください</option>';
    cars.forEach((car, i) => {
      resSelect.innerHTML += `<option value="${car.id}">${car.model} [${car.name}] - ${car.capacity}人乗り</option>`;
    });
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
    navLinks: true,
    editable: false,
    selectable: true,
    selectMirror: true,
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
    const res = await fetch(`/api/reservations?start=${fetchInfo.startStr}&end=${fetchInfo.endStr}`);
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
          status: r.status, notes: r.notes, isInUse: isInUse
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
  `;

  let footerHtml = '<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>';
  if (props.status === 'active' && (props.user_id === currentUser.id || currentUser.role === 'admin')) {
    footerHtml = `
      <button class="btn btn-warning" onclick="editReservation(${info.event.id})"><i class="bi bi-pencil"></i> 編集</button>
      <button class="btn btn-danger" onclick="cancelReservation(${info.event.id})"><i class="bi bi-x-circle"></i> キャンセル</button>
      ${footerHtml}`;
  }
  document.getElementById('detailFooter').innerHTML = footerHtml;
  new bootstrap.Modal(document.getElementById('detailModal')).show();
}

// 新規予約モーダル
function openNewReservation(startStr, endStr) {
  document.getElementById('reservationModalTitle').innerHTML = '<i class="bi bi-plus-circle"></i> 新規予約';
  document.getElementById('reservationId').value = '';
  document.getElementById('resCarId').value = '';
  document.getElementById('resDeparture').value = '弥山';
  document.getElementById('resReturn').value = '弥山';
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

  setTimeout(() => { new bootstrap.Modal(document.getElementById('reservationModal')).show(); }, 300);
}

// 予約保存
async function saveReservation() {
  if (hasConflict) return;
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
      bootstrap.Modal.getInstance(document.getElementById('reservationModal'))?.hide();
      calendar.refetchEvents();
      loadCarStatusCards();
    } else { alert(result.error); }
  } catch (e) { alert('保存に失敗しました'); }
}

// 返却完了
// 予約キャンセル
async function cancelReservation(id) {
  if (!confirm('この予約をキャンセルしますか？')) return;
  try {
    const res = await fetch(`/api/reservations/${id}`, { method: 'DELETE' });
    if (res.ok) { bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide(); calendar.refetchEvents(); loadCarStatusCards(); }
    else { const d = await res.json(); alert(d.error); }
  } catch (e) { alert('キャンセルに失敗しました'); }
}

// ===== 車両ステータスカード（折りたたみ式） =====
async function loadCarStatusCards() {
  let statusData = { current: {}, next: {} };
  try {
    const res = await fetch('/api/reservations/status/all');
    statusData = await res.json();
  } catch (e) { /* ignore */ }

  let statusHtml = '';

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const color = CAR_COLORS[i % CAR_COLORS.length];
    const current = statusData.current[car.id];
    const next = statusData.next[car.id];

    // ステータス判定
    const isInUse = !!current;
    const statusBadge = isInUse
      ? `<span class="status-badge in-use"><i class="bi bi-exclamation-circle"></i> 使用中</span>`
      : `<span class="status-badge available"><i class="bi bi-check-circle"></i> 空車</span>`;

    // 警告判定
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

    // 小さいヘッダー（常時表示）
    const warningIcon = hasWarning ? ' <i class="bi bi-exclamation-triangle-fill" style="color:#f59e0b"></i>' : '';

    // 詳細（展開時のみ表示）
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
      <div class="car-status-card" style="border-left-color: ${color}">
        <div class="car-card-compact" onclick="this.parentElement.classList.toggle('expanded')">
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

// ビュー切り替え
function showCarStatus() {
  document.getElementById('calendarView').classList.add('d-none');
  document.getElementById('carStatusView').classList.remove('d-none');
  document.getElementById('carStatusDetail').innerHTML = document.getElementById('carStatusGrid').innerHTML;
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[1].classList.add('active');
}

function showCalendar() {
  document.getElementById('calendarView').classList.remove('d-none');
  document.getElementById('carStatusView').classList.add('d-none');
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[0].classList.add('active');
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
