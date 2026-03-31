let currentUser = null;
let calendar = null;
let cars = [];
let reservations = [];
let hasConflict = false;

const CAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

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
    if (!res.ok) {
      window.location.href = '/login';
      return;
    }
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
  } catch (e) {
    window.location.href = '/login';
  }
}

// 車両データ読み込み
async function loadCars() {
  try {
    const res = await fetch('/api/cars');
    cars = await res.json();
    cars = cars.filter(c => c.is_active);

    const filter = document.getElementById('carFilter');
    const resSelect = document.getElementById('resCarId');

    filter.innerHTML = '<option value="">すべての車両</option>';
    resSelect.innerHTML = '<option value="">選択してください</option>';

    cars.forEach((car, i) => {
      filter.innerHTML += `<option value="${car.id}">${car.model} (${car.name})</option>`;
      resSelect.innerHTML += `<option value="${car.id}">${car.model} [${car.name}] - ${car.capacity}人乗り</option>`;
    });
  } catch (e) {
    console.error('車両データ取得エラー:', e);
  }
}

// === 予約フォームのリアルタイムバリデーション ===
function setupReservationValidation() {
  const fields = ['resCarId', 'resStart', 'resEnd', 'resDeparture', 'resReturn'];
  fields.forEach(id => {
    document.getElementById(id).addEventListener('change', validateReservation);
  });
}

async function validateReservation() {
  const warnings = [];
  hasConflict = false;

  const carId = document.getElementById('resCarId').value;
  const startStr = document.getElementById('resStart').value;
  const endStr = document.getElementById('resEnd').value;
  const departure = document.getElementById('resDeparture').value;
  const excludeId = document.getElementById('reservationId').value;

  // 1) 重複チェック
  if (carId && startStr && endStr) {
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

  // 2) 日をまたぐチェック
  if (startStr && endStr) {
    const startDate = startStr.slice(0, 10);
    const endDate = endStr.slice(0, 10);
    if (startDate !== endDate) {
      warnings.push({
        type: 'warning',
        icon: 'exclamation-triangle-fill',
        text: '貸出が日をまたいでいます。日付をご確認ください。'
      });
    }
  }

  // 3) 車両の現在地と出発場所の不一致チェック
  if (carId && departure) {
    const car = cars.find(c => c.id === parseInt(carId));
    if (car && car.current_location !== departure) {
      warnings.push({
        type: 'warning',
        icon: 'exclamation-triangle-fill',
        text: `この車両の現在地は「${escapeHtml(car.current_location)}」ですが、出発場所が「${escapeHtml(departure)}」になっています。`
      });
    }
  }

  // 4) 前回の返却場所と出発場所の不一致チェック
  if (carId && startStr && departure) {
    try {
      const res = await fetch(`/api/reservations/last-return?car_id=${carId}&before=${startStr}`);
      const data = await res.json();
      if (data.return_location && data.return_location !== departure) {
        warnings.push({
          type: 'warning',
          icon: 'exclamation-triangle-fill',
          text: `前回の返却先は「${escapeHtml(data.return_location)}」（${escapeHtml(data.user_name)}さん / ${data.end_datetime.slice(0,16)}）ですが、出発場所が異なります。`
        });
      }
    } catch (e) { /* ignore */ }
  }

  // 警告表示
  const container = document.getElementById('resWarnings');
  if (warnings.length === 0) {
    container.innerHTML = '';
  } else {
    container.innerHTML = warnings.map(w =>
      `<div class="alert alert-${w.type} py-2 px-3 mb-2 d-flex align-items-start gap-2" style="font-size:13px;">
        <i class="bi bi-${w.icon} mt-1 flex-shrink-0"></i>
        <span>${w.text}</span>
      </div>`
    ).join('');
  }

  // 重複時は保存ボタン無効化
  const saveBtn = document.getElementById('saveResBtn');
  if (hasConflict) {
    saveBtn.disabled = true;
    saveBtn.classList.add('btn-secondary');
    saveBtn.classList.remove('btn-primary');
  } else {
    saveBtn.disabled = false;
    saveBtn.classList.remove('btn-secondary');
    saveBtn.classList.add('btn-primary');
  }
}

// === カレンダー ===
function initCalendar() {
  const calendarEl = document.getElementById('calendar');
  const isMobile = window.innerWidth <= 768;

  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: isMobile ? 'listWeek' : 'dayGridMonth',
    locale: 'ja',
    headerToolbar: isMobile
      ? { left: 'prev,next', center: 'title', right: 'dayGridMonth,listWeek' }
      : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    buttonText: {
      today: '今日',
      month: '月',
      week: '週',
      day: '日',
      list: 'リスト'
    },
    allDayText: '終日',
    slotMinTime: '06:00:00',
    slotMaxTime: '22:00:00',
    height: 'auto',
    dayMaxEvents: isMobile ? 2 : false,
    navLinks: true,
    editable: false,
    selectable: true,
    selectMirror: true,
    nowIndicator: true,
    eventTimeFormat: {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    },
    slotLabelFormat: {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    },
    events: fetchEvents,
    eventClick: showEventDetail,
    select: (info) => {
      openNewReservation(info.startStr, info.endStr);
    },
    eventDidMount: (info) => {
      const props = info.event.extendedProps;
      info.el.title = `${props.car_model}\n${props.departure_location} → ${props.return_location}\n予約者: ${props.user_name}`;
    }
  });

  calendar.render();

  document.getElementById('carFilter').addEventListener('change', () => {
    calendar.refetchEvents();
  });
}

// イベントデータ取得
async function fetchEvents(fetchInfo, successCallback, failureCallback) {
  try {
    const carFilter = document.getElementById('carFilter').value;
    let url = `/api/reservations?start=${fetchInfo.startStr}&end=${fetchInfo.endStr}`;
    if (carFilter) url += `&car_id=${carFilter}`;

    const res = await fetch(url);
    reservations = await res.json();

    const now = new Date();
    const events = reservations.map(r => {
      const carIndex = cars.findIndex(c => c.id === r.car_id);
      const color = CAR_COLORS[carIndex % CAR_COLORS.length] || '#6b7280';

      // 使用中判定（10分前から）
      const startTime = new Date(r.start_datetime);
      const endTime = new Date(r.end_datetime);
      const startMinus10 = new Date(startTime.getTime() - 10 * 60 * 1000);
      const isInUse = r.status === 'active' && now >= startMinus10 && now < endTime;

      return {
        id: r.id,
        title: isInUse
          ? `🚗 ${r.car_model} - ${r.user_name}`
          : `${r.car_model} - ${r.user_name}`,
        start: r.start_datetime,
        end: r.end_datetime,
        backgroundColor: isInUse ? '#dc2626' : color,
        borderColor: isInUse ? '#dc2626' : color,
        classNames: isInUse ? ['event-in-use'] : [],
        extendedProps: {
          car_id: r.car_id,
          car_name: r.car_name,
          car_model: r.car_model,
          user_id: r.user_id,
          user_name: r.user_name,
          employee_id: r.employee_id,
          departure_location: r.departure_location,
          return_location: r.return_location,
          status: r.status,
          notes: r.notes,
          isInUse: isInUse
        }
      };
    });

    successCallback(events);
  } catch (e) {
    failureCallback(e);
  }
}

// イベント詳細表示
function showEventDetail(info) {
  const props = info.event.extendedProps;
  const start = new Date(info.event.start);
  const end = new Date(info.event.end);

  const formatDate = (d) => {
    return d.toLocaleDateString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
    });
  };
  const formatTime = (d) => {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // 使用中判定（10分前から）
  const nowDetail = new Date();
  const startMinus10 = new Date(start.getTime() - 10 * 60 * 1000);
  const isInUse = props.status === 'active' && nowDetail >= startMinus10 && nowDetail < end;

  let activeLabel;
  if (isInUse) {
    activeLabel = '<span class="status-badge in-use"><i class="bi bi-exclamation-circle"></i> 使用中</span>';
  } else {
    activeLabel = '<span class="status-badge reserved">予約中</span>';
  }

  const statusText = {
    active: activeLabel,
    completed: '<span class="status-badge available">完了</span>',
    cancelled: '<span class="status-badge" style="background:#e2e8f0;color:#475569;">キャンセル済</span>'
  };

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-car-front"></i></div>
      <div>
        <div class="detail-label">車両</div>
        <div class="detail-value">${props.car_model}（${props.car_name}）</div>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-calendar-event"></i></div>
      <div>
        <div class="detail-label">日時</div>
        <div class="detail-value">${formatDate(start)}</div>
        <div class="detail-value">${formatTime(start)} ～ ${formatTime(end)}</div>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-geo-alt"></i></div>
      <div>
        <div class="detail-label">出発場所</div>
        <div class="detail-value">${escapeHtml(props.departure_location)}</div>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-geo-alt-fill"></i></div>
      <div>
        <div class="detail-label">返却場所</div>
        <div class="detail-value">${escapeHtml(props.return_location)}</div>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-person"></i></div>
      <div>
        <div class="detail-label">予約者</div>
        <div class="detail-value">${escapeHtml(props.user_name)}（社員番号: ${escapeHtml(props.employee_id)}）</div>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-flag"></i></div>
      <div>
        <div class="detail-label">ステータス</div>
        <div class="detail-value">${statusText[props.status] || props.status}</div>
      </div>
    </div>
    ${props.notes ? `
    <div class="detail-row">
      <div class="detail-icon"><i class="bi bi-chat-text"></i></div>
      <div>
        <div class="detail-label">備考</div>
        <div class="detail-value">${escapeHtml(props.notes)}</div>
      </div>
    </div>
    ` : ''}
  `;

  let footerHtml = '<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>';

  if (props.status === 'active' && (props.user_id === currentUser.id || currentUser.role === 'admin')) {
    footerHtml = `
      <button class="btn btn-success" onclick="completeReservation(${info.event.id}, ${props.car_id}, '${escapeHtml(props.return_location)}')">
        <i class="bi bi-check-circle"></i> 返却完了
      </button>
      <button class="btn btn-warning" onclick="editReservation(${info.event.id})">
        <i class="bi bi-pencil"></i> 編集
      </button>
      <button class="btn btn-danger" onclick="cancelReservation(${info.event.id})">
        <i class="bi bi-x-circle"></i> キャンセル
      </button>
      ${footerHtml}
    `;
  }

  document.getElementById('detailFooter').innerHTML = footerHtml;
  new bootstrap.Modal(document.getElementById('detailModal')).show();
}

// 新規予約モーダル
function openNewReservation(startStr, endStr) {
  document.getElementById('reservationModalTitle').innerHTML =
    '<i class="bi bi-plus-circle"></i> 新規予約';
  document.getElementById('reservationId').value = '';
  document.getElementById('resCarId').value = '';
  document.getElementById('resDeparture').value = '本社駐車場';
  document.getElementById('resReturn').value = '本社駐車場';
  document.getElementById('resNotes').value = '';
  document.getElementById('resWarnings').innerHTML = '';
  document.getElementById('saveResBtn').disabled = false;
  document.getElementById('saveResBtn').classList.add('btn-primary');
  document.getElementById('saveResBtn').classList.remove('btn-secondary');

  if (startStr) {
    const start = startStr.includes('T') ? startStr.slice(0, 16) : startStr + 'T09:00';
    const end = endStr
      ? (endStr.includes('T') ? endStr.slice(0, 16) : endStr + 'T18:00')
      : startStr + 'T18:00';
    document.getElementById('resStart').value = start;
    document.getElementById('resEnd').value = end;
  } else {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);
    document.getElementById('resStart').value = dateStr + 'T09:00';
    document.getElementById('resEnd').value = dateStr + 'T18:00';
  }

  new bootstrap.Modal(document.getElementById('reservationModal')).show();
}

// 予約を編集モードで開く
function editReservation(id) {
  bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide();

  const r = reservations.find(r => r.id === id);
  if (!r) return;

  document.getElementById('reservationModalTitle').innerHTML =
    '<i class="bi bi-pencil"></i> 予約編集';
  document.getElementById('reservationId').value = r.id;
  document.getElementById('resCarId').value = r.car_id;
  document.getElementById('resStart').value = r.start_datetime.slice(0, 16);
  document.getElementById('resEnd').value = r.end_datetime.slice(0, 16);
  document.getElementById('resDeparture').value = r.departure_location;
  document.getElementById('resReturn').value = r.return_location;
  document.getElementById('resNotes').value = r.notes || '';
  document.getElementById('resWarnings').innerHTML = '';
  document.getElementById('saveResBtn').disabled = false;
  document.getElementById('saveResBtn').classList.add('btn-primary');
  document.getElementById('saveResBtn').classList.remove('btn-secondary');

  setTimeout(() => {
    new bootstrap.Modal(document.getElementById('reservationModal')).show();
  }, 300);
}

// 予約保存
async function saveReservation() {
  if (hasConflict) return;

  const id = document.getElementById('reservationId').value;
  const data = {
    car_id: document.getElementById('resCarId').value,
    start_datetime: document.getElementById('resStart').value,
    end_datetime: document.getElementById('resEnd').value,
    departure_location: document.getElementById('resDeparture').value,
    return_location: document.getElementById('resReturn').value,
    notes: document.getElementById('resNotes').value
  };

  if (!data.car_id || !data.start_datetime || !data.end_datetime ||
      !data.departure_location || !data.return_location) {
    alert('必須項目を入力してください');
    return;
  }

  try {
    const url = id ? `/api/reservations/${id}` : '/api/reservations';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await res.json();

    if (res.ok) {
      bootstrap.Modal.getInstance(document.getElementById('reservationModal'))?.hide();
      calendar.refetchEvents();
      loadCarStatusCards();
    } else {
      alert(result.error);
    }
  } catch (e) {
    alert('保存に失敗しました');
  }
}

// 返却完了
async function completeReservation(id, carId, returnLocation) {
  if (!confirm('この予約を返却完了にしますか？')) return;

  try {
    const res = await fetch(`/api/reservations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', car_id: carId, return_location: returnLocation })
    });

    if (res.ok) {
      bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide();
      calendar.refetchEvents();
      loadCarStatusCards();
    } else {
      const data = await res.json();
      alert(data.error);
    }
  } catch (e) {
    alert('処理に失敗しました');
  }
}

// 予約キャンセル
async function cancelReservation(id) {
  if (!confirm('この予約をキャンセルしますか？')) return;

  try {
    const res = await fetch(`/api/reservations/${id}`, { method: 'DELETE' });

    if (res.ok) {
      bootstrap.Modal.getInstance(document.getElementById('detailModal'))?.hide();
      calendar.refetchEvents();
      loadCarStatusCards();
    } else {
      const data = await res.json();
      alert(data.error);
    }
  } catch (e) {
    alert('キャンセルに失敗しました');
  }
}

// === 車両ステータスカード（車種メイン + 予約者 + 次回予約表示） ===
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

    let statusBadge, userLine;

    if (current) {
      statusBadge = `<span class="status-badge in-use"><i class="bi bi-exclamation-circle"></i> 使用中</span>`;
      userLine = `
        <div class="status-row">
          <i class="bi bi-person-fill" style="color:#ef4444"></i>
          <span><strong>${escapeHtml(current.user_name)}</strong> が使用中</span>
        </div>
        <div class="status-row">
          <i class="bi bi-clock" style="color:#64748b"></i>
          <span>${current.start_datetime.slice(11,16)} ～ ${current.end_datetime.slice(11,16)}</span>
        </div>
        <div class="status-row">
          <i class="bi bi-arrow-right" style="color:#64748b"></i>
          <span>${escapeHtml(current.departure_location)} → ${escapeHtml(current.return_location)}</span>
        </div>
      `;
    } else {
      statusBadge = `<span class="status-badge available"><i class="bi bi-check-circle"></i> 空車</span>`;
      userLine = '';
    }

    let nextLine = '';
    let locationWarning = '';
    if (next) {
      const nextDate = new Date(next.start_datetime);
      const dateLabel = nextDate.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', weekday: 'short' });
      const timeLabel = next.start_datetime.slice(11, 16);

      // 場所不一致チェック：使用中なら返却先 vs 次回出発、空車なら現在地 vs 次回出発
      if (current && current.return_location !== next.departure_location) {
        locationWarning = `
          <div class="car-location-warning">
            <i class="bi bi-exclamation-triangle-fill"></i>
            現在使用中の返却先「${escapeHtml(current.return_location)}」と次回の出発場所「${escapeHtml(next.departure_location)}」が異なります
          </div>
        `;
      } else if (!current && car.current_location !== next.departure_location) {
        locationWarning = `
          <div class="car-location-warning">
            <i class="bi bi-exclamation-triangle-fill"></i>
            車両の現在地「${escapeHtml(car.current_location)}」と次回の出発場所「${escapeHtml(next.departure_location)}」が異なります
          </div>
        `;
      }

      nextLine = `
        <div class="next-reservation">
          <div class="next-label"><i class="bi bi-fast-forward-fill"></i> 次回予約</div>
          <div class="next-detail">
            ${dateLabel} ${timeLabel}～ / ${escapeHtml(next.user_name)}
          </div>
          <div class="next-detail">
            ${escapeHtml(next.departure_location)} → ${escapeHtml(next.return_location)}
          </div>
        </div>
      `;
    }

    statusHtml += `
      <div class="car-status-card" style="border-left-color: ${color}">
        <div class="car-card-header">
          <div>
            <h5 class="car-model-title">${escapeHtml(car.model)}</h5>
            <div class="car-id-label">${escapeHtml(car.name)} / ${car.capacity}人乗り</div>
          </div>
          ${statusBadge}
        </div>
        ${userLine}
        <div class="status-row">
          <i class="bi bi-geo-alt" style="color:#64748b"></i>
          <span>現在地: ${escapeHtml(car.current_location)}</span>
        </div>
        ${locationWarning}
        ${nextLine}
      </div>
    `;
  }

  document.getElementById('carStatusGrid').innerHTML = statusHtml;
}

// ビュー切り替え
function showCarStatus() {
  document.getElementById('calendarView').classList.add('d-none');
  document.getElementById('carStatusView').classList.remove('d-none');

  document.getElementById('carStatusDetail').innerHTML =
    document.getElementById('carStatusGrid').innerHTML;

  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[1].classList.add('active');
}

function showCalendar() {
  document.getElementById('calendarView').classList.remove('d-none');
  document.getElementById('carStatusView').classList.add('d-none');

  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a')[0].classList.add('active');
}

// サイドバートグル（モバイル）
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('show');

  // サイドバーが開いたら、外側クリックで閉じる
  if (sidebar.classList.contains('show')) {
    setTimeout(() => {
      document.addEventListener('click', closeSidebarOnOutsideClick);
    }, 0);
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

// ログアウト
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// XSS対策
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
